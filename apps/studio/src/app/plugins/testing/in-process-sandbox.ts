import type { SandboxHandle } from '../plugin-host';
import { decodeResult } from '../plugin-sandbox';

/**
 * What the Worker prelude in `plugin-sandbox.js` does to a handler's return
 * value: JSON text plus the transferred buffers, `$`-keys escaped. A copy — the
 * prelude only exists as text — so the browser smoke is what runs the real one.
 */
export function encodeLikePrelude(value: unknown): { json: string; buffers: ArrayBuffer[] } {
  const buffers: ArrayBuffer[] = [];
  const json = JSON.stringify(value ?? null, (_key, raw: unknown) => {
    // Under jsdom a plugin's TextEncoder hands back another realm's ArrayBuffer, which
    // `instanceof` misses; a real Worker has one realm. Copy it into this one.
    const item =
      Object.prototype.toString.call(raw) === '[object ArrayBuffer]' &&
      !(raw instanceof ArrayBuffer)
        ? new Uint8Array(raw as ArrayBuffer).slice().buffer
        : raw;
    if (item instanceof ArrayBuffer) {
      if (!buffers.includes(item)) buffers.push(item);
      return { $buffer: buffers.indexOf(item) };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record);
    if (!keys.some((key) => key.startsWith('$'))) return item;
    return Object.fromEntries(
      keys.map((key) => [key.startsWith('$') ? '$' + key : key, record[key]]),
    );
  });
  return { json, buffers };
}

/**
 * A `PluginHost` start function that runs a plugin's code in this process
 * rather than in a sandboxed Worker — jsdom has neither — with the same wire on
 * both sides: params copied in (buffers moved), the reply encoded as the
 * prelude encodes it and decoded by the real `decodeResult` under the host's
 * limit. For specs only.
 */
export function inProcessStart(code: string): () => Promise<SandboxHandle> {
  return async () => {
    const handlers = new Map<string, (params: unknown) => unknown>();
    const shaderStudio = {
      handle: (method: string, fn: (params: unknown) => unknown) => handlers.set(method, fn),
      notify: () => undefined,
    };
    new Function('shaderStudio', code)(shaderStudio);
    let stopped = false;
    return {
      async call(method, params, options) {
        if (stopped) throw new Error('Plugin was stopped');
        const handler = handlers.get(method);
        if (!handler) throw new Error(`Unknown method: ${method}`);
        const copy = structuredClone(params, { transfer: options?.transfer ?? [] });
        const value = await handler(copy);
        return decodeResult(encodeLikePrelude(value), options?.maxResultBytes ?? Infinity);
      },
      async terminate() {
        stopped = true;
      },
    };
  };
}
