import { describe, expect, it, vi, type Mock } from 'vitest';
import { PLUGIN_LIMITS, validatePluginPackage, type PluginPackage } from '@shadergrove/shared';

import { PluginCallError, PluginHost, type SandboxHandle } from './plugin-host';
import { decodeResult } from './plugin-sandbox';
import { encodeLikePrelude } from './testing/in-process-sandbox';

const raw = {
  manifest: {
    id: 'dev.example.pack',
    version: '1.0.0',
    protocolVersion: 1,
    appVersionRange: '>=1.4.0',
    name: 'Pack',
    publisher: 'Example',
    license: 'MIT',
    contributions: [
      {
        kind: 'importer',
        id: 'imp',
        name: 'Import',
        mime: [],
        extensions: ['.fs'],
        maxInputBytes: 100,
        maxOutputBytes: 100,
        params: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
      },
      {
        kind: 'exporter',
        id: 'exp',
        name: 'Export',
        mime: 'text/plain',
        extension: '.fs',
        maxInputBytes: 100,
        maxOutputBytes: 100,
        params: [],
      },
    ],
  },
  code: 'void 0',
};
const parsed = validatePluginPackage(raw);
if (!parsed.ok) throw new Error(parsed.errors.join());
const plugin: PluginPackage = parsed.value;

interface Fake extends SandboxHandle {
  calls: {
    method: string;
    params: unknown;
    transfer: Transferable[];
    timeoutMs?: number;
    maxResultBytes?: number;
  }[];
  terminate: Mock<(reason?: string | Error) => Promise<void>>;
}

/** A sandbox whose plugin answers `reply`, sent over the real wire encoding. */
function host(
  reply: (params: unknown) => unknown,
  timeoutMs?: number,
): { host: PluginHost; sandboxes: Fake[] } {
  const sandboxes: Fake[] = [];
  const instance = new PluginHost(plugin, {
    timeoutMs,
    start: async () => {
      // Like the real sandbox, terminating rejects whatever call is pending with the reason.
      let stop: (error: Error) => void = () => undefined;
      const stopped = new Promise<never>((_, reject) => (stop = reject));
      stopped.catch(() => undefined);
      const sandbox: Fake = {
        calls: [],
        terminate: vi.fn(async (reason?: string | Error) =>
          stop(reason instanceof Error ? reason : new Error(reason)),
        ),
        async call(method, params, options) {
          sandbox.calls.push({
            method,
            params,
            transfer: options?.transfer ?? [],
            timeoutMs: options?.timeoutMs,
            maxResultBytes: options?.maxResultBytes,
          });
          const value = await Promise.race([stopped, Promise.resolve().then(() => reply(params))]);
          return decodeResult(encodeLikePrelude(value), options?.maxResultBytes ?? Infinity);
        },
      };
      sandboxes.push(sandbox);
      return sandbox;
    },
  });
  return { host: instance, sandboxes };
}

const buffer = (n: number) => new ArrayBuffer(n);
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (error: unknown) => (error instanceof PluginCallError ? error.code : String(error)),
  );

describe('PluginHost.importFile', () => {
  it('transfers the file, sanitizes params and returns the candidate', async () => {
    const { host: h, sandboxes } = host(() => ({ candidate: { name: 'x' } }));
    const bytes = buffer(8);
    const result = await h.importFile('imp', bytes, { gain: 99, rogue: 1 });
    expect(result).toEqual({ candidate: { name: 'x' } });
    const [call] = sandboxes[0]!.calls;
    expect(call!.method).toBe('importer:imp');
    expect(call!.transfer).toEqual([bytes]);
    expect((call!.params as { params: unknown }).params).toEqual({ gain: 2 });
    expect(call!.timeoutMs).toBe(PLUGIN_LIMITS.callTimeoutMs);
    expect(sandboxes[0]!.terminate).toHaveBeenCalled();
  });

  it('never allows more than the package time limit', async () => {
    const { host: h, sandboxes } = host(() => ({ candidate: 1 }), 60_000);
    await h.importFile('imp', buffer(1));
    expect(sandboxes[0]!.calls[0]!.timeoutMs).toBe(PLUGIN_LIMITS.callTimeoutMs);
    // The contribution's own output limit bounds what the sandbox will decode.
    expect(sandboxes[0]!.calls[0]!.maxResultBytes).toBe(100);
  });

  it('refuses an oversize file before starting a Worker', async () => {
    const { host: h, sandboxes } = host(() => ({ candidate: 1 }));
    expect(await code(h.importFile('imp', buffer(101)))).toBe('input-too-large');
    expect(sandboxes).toHaveLength(0);
  });

  it('refuses an unknown or wrong-kind contribution', async () => {
    const { host: h } = host(() => ({ candidate: 1 }));
    expect(await code(h.importFile('nope', buffer(1)))).toBe('unknown-contribution');
    expect(await code(h.importFile('exp', buffer(1)))).toBe('unknown-contribution');
  });

  it('returns a candidate exactly as the plugin built it, "$" keys included', async () => {
    const candidate = { $buffer: 0, $$x: { $: 'y' }, list: [{ $buffer: 1 }] };
    const { host: h } = host(() => ({ candidate, bytes: buffer(2) }));
    expect((await h.importFile('imp', buffer(1))).candidate).toEqual(candidate);
  });

  it('rejects a result without a candidate, or one over the contribution limit', async () => {
    const run = (reply: () => unknown) => code(host(reply).host.importFile('imp', buffer(1)));
    expect(await run(() => 'text')).toBe('output-invalid');
    expect(await run(() => ({ candidate: 'x'.repeat(200) }))).toBe('output-too-large');
    expect(await run(() => ({ candidate: buffer(500) }))).toBe('output-too-large');
  });

  it('terminates on cancellation and surfaces a plugin failure unchanged', async () => {
    const controller = new AbortController();
    const { host: h, sandboxes } = host(() => new Promise(() => undefined));
    const pending = code(h.importFile('imp', buffer(1), {}, { signal: controller.signal }));
    await vi.waitFor(() => expect(sandboxes[0]?.calls).toHaveLength(1));
    controller.abort();
    expect(await pending).toBe('cancelled');
    expect(sandboxes[0]!.terminate).toHaveBeenCalled();

    const failing = host(() => {
      throw new Error('boom');
    });
    expect(await code(failing.host.importFile('imp', buffer(1)))).toBe('Error: boom');
  });

  it('runs one call at a time', async () => {
    let active = 0;
    let peak = 0;
    const { host: h } = host(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return { candidate: 1 };
    });
    await Promise.all([h.importFile('imp', buffer(1)), h.importFile('imp', buffer(1))]);
    expect(peak).toBe(1);
  });
});

describe('PluginHost.exportEffect', () => {
  const ok = { bytes: buffer(4), mime: 'text/plain', fileName: 'effect.fs' };

  it('sends only the chosen effect and returns validated bytes', async () => {
    const { host: h, sandboxes } = host(() => ok);
    const result = await h.exportEffect('exp', { name: 'e' });
    expect(result).toEqual(ok);
    expect(sandboxes[0]!.calls[0]!.params).toEqual({ effect: { name: 'e' }, params: {} });
  });

  it('refuses an oversize effect before starting a Worker', async () => {
    const { host: h, sandboxes } = host(() => ok);
    expect(await code(h.exportEffect('exp', { source: 'x'.repeat(200) }))).toBe('input-too-large');
    expect(sandboxes).toHaveLength(0);
  });

  it('counts params against the exporter input limit', async () => {
    const tight = validatePluginPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        contributions: [
          {
            ...raw.manifest.contributions[1],
            maxInputBytes: 20,
            params: [{ key: 'gain', type: 'number', default: 1, min: 0, max: 2 }],
          },
        ],
      },
    });
    if (!tight.ok) throw new Error(tight.errors.join());
    const sandboxes: unknown[] = [];
    const h = new PluginHost(tight.value, { start: async () => (sandboxes.push(1), {} as never) });
    // '{"effect":1,"params":{"gain":1}}' is over 20 bytes although the effect alone is 1.
    expect(await code(h.exportEffect('exp', 1))).toBe('input-too-large');
    expect(sandboxes).toHaveLength(0);
  });

  it('rejects a wrong MIME, a path-like file name and non-ArrayBuffer bytes', async () => {
    for (const bad of [
      { ...ok, mime: 'text/html' },
      { ...ok, fileName: '../evil.fs' },
      { ...ok, fileName: 'C:\\evil.fs' },
      { ...ok, bytes: new Uint8Array(4) },
    ]) {
      expect(await code(host(() => bad).host.exportEffect('exp', {}))).toBe('output-invalid');
    }
  });
});
