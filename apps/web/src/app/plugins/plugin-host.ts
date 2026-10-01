/**
 * Calls the importer/exporter contributions of a validated plugin package.
 *
 * The host owns every decision: it checks sizes before anything crosses to the
 * Worker and again before it trusts anything that comes back, hands over only
 * the bytes and form values of one call, and returns data that nothing has
 * applied yet. A failure — oversize, malformed result, timeout, cancellation —
 * rejects and leaves the project and the disk untouched.
 *
 * Each call gets a fresh sandbox, torn down when the call ends, and calls run
 * one at a time, so at most one plugin Worker is alive. Quotas bound bytes and
 * time; they do not bound native memory or GPU time.
 */
import {
  PLUGIN_LIMITS,
  exporterMethod,
  importerMethod,
  sanitizeParams,
  utf8Bytes,
  type ExporterContribution,
  type ExporterInput,
  type ExporterResult,
  type ImporterContribution,
  type ImporterInput,
  type ImporterResult,
  type PluginPackage,
  type ShaderParams,
} from '@shadergrove/shared';

import {
  PluginSandbox,
  type PluginSandboxOptions,
  type SandboxCallOptions,
} from './plugin-sandbox';

export type PluginCallErrorCode =
  | 'unknown-contribution'
  | 'input-invalid'
  | 'input-too-large'
  | 'output-invalid'
  | 'output-too-large'
  | 'events-exceeded'
  | 'cancelled';

export class PluginCallError extends Error {
  constructor(
    readonly code: PluginCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginCallError';
  }
}

/** The part of `PluginSandbox` the host uses; a test can stand in for it. */
export interface SandboxHandle {
  call(method: string, params?: unknown, options?: SandboxCallOptions): Promise<unknown>;
  terminate(reason?: string): Promise<void>;
}

export interface PluginHostOptions {
  /** Shorter than the package limit, never longer; for tests. */
  timeoutMs?: number;
  start?: (code: string, options: PluginSandboxOptions) => Promise<SandboxHandle>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

// One Worker at a time, across every host.
let queue: Promise<unknown> = Promise.resolve();

export class PluginHost {
  private readonly start: NonNullable<PluginHostOptions['start']>;
  private readonly timeoutMs: number;

  constructor(
    readonly plugin: PluginPackage,
    options: PluginHostOptions = {},
  ) {
    this.timeoutMs = Math.min(options.timeoutMs ?? Infinity, PLUGIN_LIMITS.callTimeoutMs);
    this.start = options.start ?? ((code, opts) => PluginSandbox.start(code, opts));
  }

  /** Run an importer on one file's bytes. The buffer is transferred and left detached. */
  async importFile(
    contributionId: string,
    bytes: ArrayBuffer,
    params: ShaderParams = {},
    options: CallOptions = {},
  ): Promise<ImporterResult> {
    const contribution = this.contribution(contributionId, 'importer');
    if (bytes.byteLength > PLUGIN_LIMITS.fileBytes) {
      throw new PluginCallError('input-too-large', 'File is larger than a plugin may read');
    }
    if (bytes.byteLength > contribution.maxInputBytes) {
      throw new PluginCallError(
        'input-too-large',
        `File exceeds ${contribution.name}'s input limit`,
      );
    }
    const input: ImporterInput = { bytes, params: sanitizeParams(contribution.params, params) };
    // The params ride along with the file, so they count against the same limit.
    const total = bytes.byteLength + utf8Bytes(JSON.stringify(input.params));
    if (total > Math.min(contribution.maxInputBytes, PLUGIN_LIMITS.callInputBytes)) {
      throw new PluginCallError('input-too-large', 'Input exceeds the importer limit');
    }
    const result = await this.run(
      importerMethod(contributionId),
      input,
      [bytes],
      contribution.maxOutputBytes,
      options,
    );
    if (!isObject(result) || !('candidate' in result)) {
      throw new PluginCallError('output-invalid', 'Importer must return { candidate }');
    }
    return { candidate: jsonCopy(result['candidate'], contribution.maxOutputBytes) };
  }

  /** Run an exporter on the one effect definition chosen; nothing else of the project goes in. */
  async exportEffect(
    contributionId: string,
    effect: unknown,
    params: ShaderParams = {},
    options: CallOptions = {},
  ): Promise<ExporterResult> {
    const contribution = this.contribution(contributionId, 'exporter');
    const input: ExporterInput = {
      effect: jsonCopy(effect, contribution.maxInputBytes, 'input-invalid', 'input-too-large'),
      params: sanitizeParams(contribution.params, params),
    };
    // The params travel with the effect, so the whole input counts against the limit.
    if (serializedBytes(input)! > contribution.maxInputBytes) {
      throw new PluginCallError('input-too-large', 'Input exceeds the exporter limit');
    }
    const result = await this.run(
      exporterMethod(contributionId),
      input,
      [],
      contribution.maxOutputBytes,
      options,
    );
    return validateExport(result, contribution);
  }

  private contribution(id: string, kind: 'importer'): ImporterContribution;
  private contribution(id: string, kind: 'exporter'): ExporterContribution;
  private contribution(id: string, kind: 'importer' | 'exporter') {
    const found = this.plugin.manifest.contributions.find((c) => c.id === id && c.kind === kind);
    if (!found || !this.plugin.code) {
      throw new PluginCallError('unknown-contribution', `No ${kind} "${id}" in this package`);
    }
    return found;
  }

  private run(
    method: string,
    params: unknown,
    transfer: Transferable[],
    maxOutputBytes: number,
    { signal }: CallOptions,
  ): Promise<unknown> {
    const turn = queue.then(() => this.runOnce(method, params, transfer, maxOutputBytes, signal));
    queue = turn.catch(() => undefined);
    return turn;
  }

  private async runOnce(
    method: string,
    params: unknown,
    transfer: Transferable[],
    maxOutputBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted) throw new PluginCallError('cancelled', 'Call was cancelled');
    let eventBytes = 0;
    let overrun: PluginCallError | null = null;
    let sandbox: SandboxHandle | undefined;
    const onEvent = (data: unknown) => {
      if (overrun) return;
      // Measured by walking, not by JSON.stringify: that would expand shared references
      // and skip binary, before any quota could apply.
      const size = measure(data, PLUGIN_LIMITS.eventBytes);
      // An empty event still costs the host a message, so it is charged a floor.
      eventBytes += Math.max(size ?? 0, MIN_EVENT_COST);
      if (
        size === null ||
        size > PLUGIN_LIMITS.eventBytes ||
        eventBytes > PLUGIN_LIMITS.callEventBytes
      ) {
        overrun = new PluginCallError(
          'events-exceeded',
          'Plugin sent too many or too large events',
        );
        void sandbox?.terminate(overrun.message);
      }
    };
    const cancel = () => void sandbox?.terminate('Call was cancelled');
    try {
      sandbox = await this.start(this.plugin.code!, { onEvent });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const result = await sandbox.call(method, params, {
        timeoutMs: this.timeoutMs,
        transfer,
      });
      if (overrun) throw overrun;
      checkOutputSize(result, maxOutputBytes);
      return result;
    } catch (error) {
      if (overrun) throw overrun;
      if (signal?.aborted) throw new PluginCallError('cancelled', 'Call was cancelled');
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      await sandbox?.terminate('Call finished');
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** UTF-8 size of the JSON form, or `null` if it has none (cycles, BigInt). */
function serializedBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8Bytes(json);
  } catch {
    return null;
  }
}

/** A plain-data copy, so nothing the Worker built (getters, prototypes) reaches the host. */
function jsonCopy(
  value: unknown,
  max: number,
  invalid: PluginCallErrorCode = 'output-invalid',
  large: PluginCallErrorCode = 'output-too-large',
): unknown {
  const size = serializedBytes(value);
  if (size === null) throw new PluginCallError(invalid, 'Value is not plain JSON data');
  if (size > max) throw new PluginCallError(large, `Value is ${size} bytes; the limit is ${max}`);
  return JSON.parse(JSON.stringify(value));
}

const MIN_EVENT_COST = 64;

/** More values than any bounded message needs; stops cyclic or heavily shared structures. */
const MAX_NODES = 100_000;
const MAX_DEPTH = 32;

/**
 * Bytes a message from the Worker carries — strings, keys and binary — or `null`
 * if it is not plain, bounded data: a cycle, shared references fanning out,
 * nesting past `MAX_DEPTH`, or a type (Map, Set, Date, ...) that holds content this
 * walk cannot see. Counts every reference, as JSON would, so a result this
 * accepts is cheap to serialize afterwards. Stops as soon as `max` is passed.
 */
function measure(value: unknown, max: number): number | null {
  let bytes = 0;
  let nodes = 0;
  const walk = (item: unknown, depth: number): boolean => {
    if (bytes > max) return true;
    if (++nodes > MAX_NODES) return false;
    if (item instanceof ArrayBuffer) {
      bytes += item.byteLength;
    } else if (ArrayBuffer.isView(item)) {
      // Cloning a view copies its whole backing buffer, not just the window it shows.
      bytes += item.buffer.byteLength;
    } else if (typeof item === 'bigint') {
      bytes += Math.ceil(item.toString(16).length / 2);
    } else if (typeof item === 'string') {
      bytes += utf8Bytes(item);
    } else if (typeof item === 'object' && item !== null) {
      const proto = Object.getPrototypeOf(item);
      if (
        depth >= MAX_DEPTH ||
        !(Array.isArray(item) || proto === Object.prototype || proto === null)
      ) {
        return false;
      }
      for (const [key, child] of Object.entries(item)) {
        bytes += utf8Bytes(key);
        if (!walk(child, depth + 1)) return false;
      }
    }
    return true;
  };
  return walk(value, 0) ? bytes : null;
}

/** Total bytes of buffers and JSON in a result, checked before the host reads any of it. */
function checkOutputSize(result: unknown, max: number): void {
  const bytes = measure(result, max);
  if (bytes === null) {
    throw new PluginCallError('output-invalid', 'Result is not plain, bounded data');
  }
  if (bytes > max) throw new PluginCallError('output-too-large', `Result exceeds ${max} bytes`);
}

function validateExport(result: unknown, contribution: ExporterContribution): ExporterResult {
  if (!isObject(result))
    throw new PluginCallError('output-invalid', 'Exporter must return an object');
  const { bytes, mime, fileName } = result;
  if (!(bytes instanceof ArrayBuffer)) {
    throw new PluginCallError('output-invalid', 'Exporter bytes must be an ArrayBuffer');
  }
  if (mime !== contribution.mime) {
    throw new PluginCallError('output-invalid', `Exporter must produce ${contribution.mime}`);
  }
  // The suggestion is a leaf name; the host picks the real destination.
  // oxlint-disable-next-line no-control-regex
  if (typeof fileName !== 'string' || !/^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/.test(fileName)) {
    throw new PluginCallError('output-invalid', 'Exporter fileName must be a plain file name');
  }
  return { bytes, mime, fileName };
}
