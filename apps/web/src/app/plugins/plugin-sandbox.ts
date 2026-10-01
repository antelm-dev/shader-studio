/**
 * Runs one plugin bundle outside the app's security boundary.
 *
 * The plugin executes in a Worker created by a `sandbox="allow-scripts"`
 * srcdoc iframe. Without `allow-same-origin` the frame — and so the Worker —
 * gets an opaque origin: no access to the app's storage, cookies, DOM or the
 * Electron preload bridge. The srcdoc inherits the app's CSP and adds its own
 * (`default-src 'none'`); both apply, so the plugin has no direct network. A
 * srcdoc rather than a served page because the server forbids framing
 * (`frame-ancestors 'none'`) and a srcdoc is never fetched. The host talks to
 * the Worker over a MessagePort it created, which no other frame can post into.
 *
 * Termination asks the frame's bootstrap to call `worker.terminate()`, which
 * aborts a plugin stuck in a loop, and removes the frame once it confirms.
 *
 * On the wire, everything the Worker sends is a JSON string plus a list of
 * `ArrayBuffer`s (see the prelude in `plugin-sandbox.js`). Measuring that is a
 * string length and a few `byteLength`s, done before anything is parsed — the
 * host never walks a graph a plugin built, so cycles, shared references, sparse
 * arrays and exotic types have nothing to hide in. A plugin that skips the
 * prelude and posts something else is refused. What cannot be bounded is the
 * browser deserializing a hostile message before the host sees it.
 */
import { PLUGIN_LIMITS, utf8Bytes } from '@shadergrove/shared';

const BOOTSTRAP_PATH = 'plugin-sandbox.js';
/** A frame that does not confirm has no running bootstrap, so no Worker to stop. */
const STOP_ACK_TIMEOUT_MS = 1_000;

export interface PluginSandboxOptions {
  /** Where to mount the hidden frame. Defaults to `document.body`. */
  container?: HTMLElement;
  /** How long the plugin may take to load before it is terminated. */
  readyTimeoutMs?: number;
  /** One-way events the plugin sends with `shaderStudio.notify`. */
  onEvent?: (data: unknown) => void;
}

export interface SandboxCallOptions {
  timeoutMs?: number;
  transfer?: Transferable[];
  /** Bytes of JSON and buffers the reply may carry. */
  maxResultBytes?: number;
}

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

const MAX_BUFFERS = 16;
/** An empty event still costs the host a message, so each one is charged at least this. */
const MIN_EVENT_COST = 64;

/**
 * Turn a reply envelope `{ json, buffers }` into a value, checking its size
 * before parsing. `{ "$buffer": i }` in the JSON stands for `buffers[i]`.
 */
export function decodeResult(envelope: unknown, maxBytes: number): unknown {
  const invalid = () => new PluginCallError('output-invalid', 'Plugin reply is malformed');
  if (typeof envelope !== 'object' || envelope === null) throw invalid();
  const { json, buffers } = envelope as { json?: unknown; buffers?: unknown };
  if (typeof json !== 'string' || !Array.isArray(buffers) || buffers.length > MAX_BUFFERS) {
    throw invalid();
  }
  let bytes = textBytes(json, maxBytes);
  for (const buffer of buffers) {
    if (!(buffer instanceof ArrayBuffer)) throw invalid();
    bytes += buffer.byteLength;
  }
  if (bytes > maxBytes) {
    throw new PluginCallError('output-too-large', `Plugin reply exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(json, (_key, value: unknown) => {
      const index = (value as { $buffer?: unknown } | null)?.$buffer;
      return Number.isInteger(index) && Object.keys(value as object).length === 1
        ? (buffers[index as number] ?? value)
        : value;
    });
  } catch {
    throw invalid();
  }
}

/** The events one sandbox may send; `charge` returns the decoded event or throws. */
export class EventBudget {
  private spent = 0;

  charge(event: unknown): unknown {
    const malformed = () => new PluginCallError('output-invalid', 'Plugin sent a malformed event');
    if (typeof event !== 'string') throw malformed();
    const size = textBytes(event, PLUGIN_LIMITS.eventBytes);
    this.spent += Math.max(size, MIN_EVENT_COST);
    if (size > PLUGIN_LIMITS.eventBytes || this.spent > PLUGIN_LIMITS.callEventBytes) {
      throw new PluginCallError('events-exceeded', 'Plugin sent too many or too large events');
    }
    try {
      return JSON.parse(event);
    } catch {
      throw malformed();
    }
  }
}

/** UTF-8 size of `text`, or `Infinity` once its length alone (never above its UTF-8 size) passes `max`. */
function textBytes(text: string, max: number): number {
  return text.length > max ? Infinity : utf8Bytes(text);
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  maxResultBytes: number;
}

export class PluginSandbox {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private terminated: Error | null = null;
  private stopped: Promise<void> = Promise.resolve();
  private onStopped: (() => void) | null = null;
  private failStart: ((error: Error) => void) | null = null;

  private constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly port: MessagePort,
  ) {}

  static start(code: string, options: PluginSandboxOptions = {}): Promise<PluginSandbox> {
    const bootstrap = escapeAttribute(new URL(BOOTSTRAP_PATH, document.baseURI).href);
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts');
    frame.hidden = true;
    frame.srcdoc =
      `<!doctype html><meta http-equiv="Content-Security-Policy" ` +
      `content="default-src 'none'; script-src ${bootstrap}; worker-src blob:">` +
      `<script src="${bootstrap}"></script>`;

    const channel = new MessageChannel();
    const sandbox = new PluginSandbox(frame, channel.port1);
    const events = new EventBudget();
    return new Promise<PluginSandbox>((resolve, reject) => {
      sandbox.failStart = reject;
      const timer = setTimeout(() => {
        reject(new Error('Plugin did not start in time'));
        void sandbox.terminate('Plugin did not start in time');
      }, options.readyTimeoutMs ?? 5_000);

      channel.port1.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          clearTimeout(timer);
          sandbox.failStart = null;
          resolve(sandbox);
        } else if (data?.type === 'event') {
          let event: unknown;
          try {
            event = events.charge(data.data);
          } catch (error) {
            void sandbox.terminate(error as PluginCallError);
            return;
          }
          options.onEvent?.(event);
        } else if (data?.type === 'result') {
          sandbox.settle(data);
        }
      };
      addEventListener('message', sandbox.onFrameMessage);
      frame.addEventListener(
        'load',
        () => frame.contentWindow?.postMessage({ type: 'start', code }, '*', [channel.port2]),
        { once: true },
      );
      (options.container ?? document.body).append(frame);
    });
  }

  /**
   * Call a plugin method; the plugin is terminated if it does not answer in
   * time. Buffers in `transfer` move to the Worker instead of being cloned and
   * are detached here — the port runs straight from host to Worker, so nothing
   * in between copies them. The Worker's reply moves its `ArrayBuffer`s back
   * the same way.
   */
  call(
    method: string,
    params?: unknown,
    {
      timeoutMs = 10_000,
      transfer = [],
      maxResultBytes = PLUGIN_LIMITS.callOutputBytes,
    }: SandboxCallOptions = {},
  ): Promise<unknown> {
    if (this.terminated) return Promise.reject(this.terminated);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => void this.terminate(`Plugin did not answer ${method} in time`),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer, maxResultBytes });
      this.port.postMessage({ id, method, params }, transfer);
    });
  }

  /**
   * Stop the plugin and reject everything it still owes. Calls are refused
   * immediately; the returned promise settles once the Worker has been
   * terminated and the frame removed. Safe to call twice. Pending calls reject
   * with `reason` itself when it is an error, so callers keep its code.
   */
  terminate(reason: string | Error = 'Plugin was stopped'): Promise<void> {
    if (this.terminated) return this.stopped;
    this.terminated = typeof reason === 'string' ? new Error(reason) : reason;
    this.port.close();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(this.terminated);
    }
    this.pending.clear();
    this.stopped = new Promise<void>((resolve) => {
      const fallback = setTimeout(() => this.onStopped?.(), STOP_ACK_TIMEOUT_MS);
      this.onStopped = () => {
        this.onStopped = null;
        clearTimeout(fallback);
        removeEventListener('message', this.onFrameMessage);
        this.frame.remove();
        resolve();
      };
      this.frame.contentWindow?.postMessage({ type: 'stop' }, '*');
    });
    return this.stopped;
  }

  get running(): boolean {
    return !this.terminated;
  }

  /** The frame, for tests that assert it stays opaque to the host. */
  get element(): HTMLIFrameElement {
    return this.frame;
  }

  private readonly onFrameMessage = (event: MessageEvent): void => {
    if (event.source !== this.frame.contentWindow) return;
    if (event.data?.type === 'stopped') {
      this.onStopped?.();
    } else if (event.data?.type === 'sandbox-error') {
      const error = new Error(`Plugin failed: ${String(event.data.message)}`);
      this.failStart?.(error);
      void this.terminate(error.message);
    }
  };

  private settle(data: { id?: unknown; result?: unknown; error?: unknown }): void {
    const call = typeof data.id === 'number' ? this.pending.get(data.id) : undefined;
    if (!call) return;
    this.pending.delete(data.id as number);
    clearTimeout(call.timer);
    if (data.error !== undefined) {
      const message = typeof data.error === 'string' ? data.error.slice(0, 500) : 'Plugin failed';
      call.reject(new Error(message));
      return;
    }
    try {
      call.resolve(decodeResult(data.result, call.maxResultBytes));
    } catch (error) {
      call.reject(error as Error);
    }
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
