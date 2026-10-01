import { describe, expect, it, vi, type Mock } from 'vitest';
import { PLUGIN_LIMITS, validatePluginPackage, type PluginPackage } from '@shadergrove/shared';

import { PluginCallError, PluginHost, type SandboxHandle } from './plugin-host';

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
  calls: { method: string; params: unknown; transfer: Transferable[]; timeoutMs?: number }[];
  terminate: Mock<(reason?: string) => Promise<void>>;
}

/** A sandbox that answers `reply`, and can emit events first. */
function host(
  reply: (params: unknown) => unknown,
  events: unknown[] = [],
  timeoutMs?: number,
): { host: PluginHost; sandboxes: Fake[] } {
  const sandboxes: Fake[] = [];
  const instance = new PluginHost(plugin, {
    timeoutMs,
    start: async (_code, { onEvent }) => {
      // Like the real sandbox, terminating rejects whatever call is pending.
      let stop: (error: Error) => void = () => undefined;
      const stopped = new Promise<never>((_, reject) => (stop = reject));
      stopped.catch(() => undefined);
      const sandbox: Fake = {
        calls: [],
        terminate: vi.fn(async (reason?: string) => stop(new Error(reason))),
        async call(method, params, options) {
          sandbox.calls.push({
            method,
            params,
            transfer: options?.transfer ?? [],
            timeoutMs: options?.timeoutMs,
          });
          events.forEach((event) => onEvent?.(event));
          return Promise.race([stopped, Promise.resolve().then(() => reply(params))]);
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
    const { host: h, sandboxes } = host(() => ({ candidate: 1 }), [], 60_000);
    await h.importFile('imp', buffer(1));
    expect(sandboxes[0]!.calls[0]!.timeoutMs).toBe(PLUGIN_LIMITS.callTimeoutMs);
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

  it('rejects malformed, oversize and non-JSON results', async () => {
    const run = (reply: () => unknown) => code(host(reply).host.importFile('imp', buffer(1)));
    expect(await run(() => 'text')).toBe('output-invalid');
    expect(await run(() => ({ candidate: 'x'.repeat(200) }))).toBe('output-too-large');
    expect(await run(() => ({ candidate: buffer(500) }))).toBe('output-too-large');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    // Either bound may trip first on a loop; what matters is that it is refused.
    expect(['output-invalid', 'output-too-large']).toContain(
      await run(() => ({ candidate: cyclic })),
    );
  });

  it('rejects a result that loops back on itself without walking it forever', async () => {
    const loop: Record<string, unknown> = {};
    loop['left'] = loop;
    loop['right'] = loop;
    const started = performance.now();
    const outcome = await code(host(() => ({ candidate: loop })).host.importFile('imp', buffer(1)));
    expect(['output-invalid', 'output-too-large']).toContain(outcome);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('stops a shared-reference event and a binary event before they pass the quota', async () => {
    let shared: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 30; i++) shared = { a: shared, b: shared };
    for (const event of [shared, new ArrayBuffer(PLUGIN_LIMITS.eventBytes + 1)]) {
      const { host: h, sandboxes } = host(() => ({ candidate: 1 }), [event]);
      expect(await code(h.importFile('imp', buffer(1)))).toBe('events-exceeded');
      expect(sandboxes[0]!.terminate).toHaveBeenCalled();
    }
  });

  it('charges a view for its whole backing buffer and a BigInt for its size', async () => {
    const view = new Uint8Array(new ArrayBuffer(PLUGIN_LIMITS.eventBytes * 2), 0, 1);
    const big = 1n << BigInt(PLUGIN_LIMITS.eventBytes * 8 + 8);
    for (const event of [view, big]) {
      const { host: h } = host(() => ({ candidate: 1 }), [event]);
      expect(await code(h.importFile('imp', buffer(1)))).toBe('events-exceeded');
    }
    const result = await code(
      host(() => ({ candidate: new Uint8Array(new ArrayBuffer(500), 0, 1) })).host.importFile(
        'imp',
        buffer(1),
      ),
    );
    expect(result).toBe('output-too-large');
  });

  it('charges a sparse array for its length, not its entries', async () => {
    const huge = await code(
      host(() => ({ candidate: new Array(100_000_000) })).host.importFile('imp', buffer(1)),
    );
    expect(['output-invalid', 'output-too-large']).toContain(huge);
    const flood = host(() => ({ candidate: 1 }), [new Array(PLUGIN_LIMITS.eventBytes + 1)]);
    expect(await code(flood.host.importFile('imp', buffer(1)))).toBe('events-exceeded');
  });

  it('counts deeply nested buffers, and refuses types it cannot measure', async () => {
    let nested: unknown = buffer(500);
    for (let i = 0; i < 40; i++) nested = { n: nested };
    const run = (reply: () => unknown) => code(host(reply).host.importFile('imp', buffer(1)));
    expect(await run(() => ({ candidate: nested }))).toBe('output-invalid');
    expect(await run(() => ({ candidate: new Map([['k', 'x'.repeat(500)]]) }))).toBe(
      'output-invalid',
    );
    const exported = host(() => ({
      bytes: buffer(4),
      mime: 'text/plain',
      fileName: 'a.fs',
      extra: nested,
    }));
    expect(await code(exported.host.exportEffect('exp', {}))).toBe('output-invalid');
  });

  it('charges empty events so they cannot flood the host', async () => {
    const flood = Array.from({ length: PLUGIN_LIMITS.callEventBytes / 64 + 1 }, () => undefined);
    const { host: h, sandboxes } = host(() => ({ candidate: 1 }), flood);
    expect(await code(h.importFile('imp', buffer(1)))).toBe('events-exceeded');
    expect(sandboxes[0]!.terminate).toHaveBeenCalled();
  });

  it('terminates the plugin and rejects when it sends an oversize event', async () => {
    const big = 'x'.repeat(PLUGIN_LIMITS.eventBytes + 1);
    const { host: h, sandboxes } = host(() => ({ candidate: 1 }), [big]);
    expect(await code(h.importFile('imp', buffer(1)))).toBe('events-exceeded');
    expect(sandboxes[0]!.terminate).toHaveBeenCalled();
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
