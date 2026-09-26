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
 * Termination removes the frame; a dedicated Worker dies with its owner
 * document, so a plugin stuck in a loop cannot keep running.
 */

const BOOTSTRAP_PATH = 'plugin-sandbox.js';

export interface PluginSandboxOptions {
  /** Where to mount the hidden frame. Defaults to `document.body`. */
  container?: HTMLElement;
  /** How long the plugin may take to load before it is terminated. */
  readyTimeoutMs?: number;
  /** One-way events the plugin sends with `shaderStudio.notify`. */
  onEvent?: (data: unknown) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PluginSandbox {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private terminated: Error | null = null;

  private constructor(
    private readonly frame: HTMLIFrameElement,
    private readonly port: MessagePort,
    private readonly onFrameMessage: (event: MessageEvent) => void,
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
    return new Promise<PluginSandbox>((resolve, reject) => {
      const sandbox = new PluginSandbox(frame, channel.port1, (event) => {
        if (event.source !== frame.contentWindow || event.data?.type !== 'sandbox-error') return;
        const message = `Plugin failed: ${String(event.data.message)}`;
        reject(new Error(message)); // no-op once started
        sandbox.terminate(message);
      });
      const timer = setTimeout(() => {
        sandbox.terminate('Plugin did not start in time');
        reject(new Error('Plugin did not start in time'));
      }, options.readyTimeoutMs ?? 5_000);

      channel.port1.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          clearTimeout(timer);
          resolve(sandbox);
        } else if (data?.type === 'event') {
          options.onEvent?.(data.data);
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

  /** Call a plugin method; the plugin is terminated if it does not answer in time. */
  call(method: string, params?: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (this.terminated) return Promise.reject(this.terminated);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.terminate(`Plugin did not answer ${method} in time`),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ id, method, params });
    });
  }

  /** Stop the plugin and reject everything it still owes. Safe to call twice. */
  terminate(reason = 'Plugin was stopped'): void {
    if (this.terminated) return;
    this.terminated = new Error(reason);
    removeEventListener('message', this.onFrameMessage);
    this.port.close();
    this.frame.remove();
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(this.terminated);
    }
    this.pending.clear();
  }

  get running(): boolean {
    return !this.terminated;
  }

  /** The frame, for tests that assert it stays opaque to the host. */
  get element(): HTMLIFrameElement {
    return this.frame;
  }

  private settle(data: { id?: unknown; result?: unknown; error?: unknown }): void {
    const call = typeof data.id === 'number' ? this.pending.get(data.id) : undefined;
    if (!call) return;
    this.pending.delete(data.id as number);
    clearTimeout(call.timer);
    if (data.error === undefined) call.resolve(data.result);
    else call.reject(new Error(String(data.error)));
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
