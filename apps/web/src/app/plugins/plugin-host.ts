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
  PluginCallError,
  PluginSandbox,
  type PluginCallErrorCode,
  type PluginSandboxOptions,
  type SandboxCallOptions,
} from './plugin-sandbox';

export { PluginCallError, type PluginCallErrorCode };

/**
 * The part of `PluginSandbox` the host uses; a test can stand in for it. The
 * sandbox owns the wire format, so it is what bounds reply and event sizes.
 */
export interface SandboxHandle {
  call(method: string, params?: unknown, options?: SandboxCallOptions): Promise<unknown>;
  terminate(reason?: string | Error): Promise<void>;
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
    return { candidate: result['candidate'] };
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
      effect: jsonCopy(effect, contribution.maxInputBytes),
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
    const cancelled = () => new PluginCallError('cancelled', 'Call was cancelled');
    if (signal?.aborted) throw cancelled();
    let sandbox: SandboxHandle | undefined;
    const cancel = () => void sandbox?.terminate(cancelled());
    try {
      sandbox = await this.start(this.plugin.code!, {});
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      return await sandbox.call(method, params, {
        timeoutMs: this.timeoutMs,
        transfer,
        maxResultBytes: maxOutputBytes,
      });
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

/** A plain-data copy of what the app hands a plugin, bounded before it is sent. */
function jsonCopy(value: unknown, max: number): unknown {
  const size = serializedBytes(value);
  if (size === null) throw new PluginCallError('input-invalid', 'Value is not plain JSON data');
  if (size > max) {
    throw new PluginCallError('input-too-large', `Value is ${size} bytes; the limit is ${max}`);
  }
  return JSON.parse(JSON.stringify(value));
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
