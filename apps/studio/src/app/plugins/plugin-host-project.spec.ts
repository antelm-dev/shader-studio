import { describe, expect, it } from 'vitest';

import { PROJECT_LIMITS, validatePluginPackage, type PluginPackage } from '@shadergrove/shared';
import { PluginHost, type SandboxHandle } from './plugin-host';
import { inProcessStart } from './testing/in-process-sandbox';

/**
 * A synthetic protocol-2 package: the foundation's contract exercised through
 * the real `PluginHost`, before any official package exists. Its importer
 * echoes what it was sent into the candidate's warnings, so a test can see
 * exactly what crossed into the Worker.
 */
const code = `
const image = (source) => ({
  id: 'image-1', kind: 'image', name: 'Image', slot: null, enabled: true, source,
  channels: [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }, { kind: 'none' }],
});
shaderStudio.handle('projectImporter:demo', (input) => {
  if (input.mode === 'paste' && input.text === 'malformed') return { name: 'x', html: '<b>' };
  if (input.mode === 'paste' && input.text === 'hang') return new Promise(() => {});
  return {
    name: input.mode === 'paste' ? input.name : 'From provider',
    description: '',
    credits: {},
    project: { version: 1, vertex: 'void main() {}', passes: [image('void main() {}')], files: [] },
    controls: [],
    values: {},
    textures: [],
    warnings: [JSON.stringify(input).slice(0, 300)],
  };
});
shaderStudio.handle('projectExporter:demo-export', (snapshot) => ({
  data: { title: snapshot.name, passes: snapshot.project.passes.length },
  warnings: snapshot.postProcessingActive ? ['post-processing omitted'] : [],
}));
`;

const parsed = validatePluginPackage({
  manifest: {
    id: 'dev.example.demo',
    version: '1.0.0',
    protocolVersion: 2,
    appVersionRange: '>=1.0.0',
    name: 'Demo',
    publisher: 'Example',
    license: 'MIT',
    contributions: [
      {
        kind: 'projectImporter',
        id: 'demo',
        name: 'Demo import',
        modes: ['paste', 'provider'],
        provider: 'shadertoy-api/v1',
        maxInputBytes: 1_000_000,
        maxOutputBytes: 100_000,
      },
      {
        kind: 'projectExporter',
        id: 'demo-export',
        name: 'Demo export',
        runtime: 'wallpaper-web/v1',
        maxInputBytes: 100_000,
        maxOutputBytes: 100_000,
      },
    ],
  },
  code,
});
if (!parsed.ok) throw new Error(parsed.errors.join());
const plugin: PluginPackage = parsed.value;

/** The in-process sandbox, recording every request that crosses into it. */
function recordingHost(): { host: PluginHost; sent: unknown[] } {
  const sent: unknown[] = [];
  const start = inProcessStart(plugin.code!);
  return {
    sent,
    host: new PluginHost(plugin, {
      timeoutMs: 200,
      start: async () => {
        const inner = await start();
        let stop: (error: Error) => void = () => undefined;
        const stopped = new Promise<never>((_, reject) => (stop = reject));
        stopped.catch(() => undefined);
        const handle: SandboxHandle = {
          call: (method, params, options) => {
            sent.push(structuredClone(params));
            const timer = setTimeout(() => stop(new Error('timed out')), options?.timeoutMs);
            return Promise.race([inner.call(method, params, options), stopped]).finally(() =>
              clearTimeout(timer),
            );
          },
          terminate: async (reason) => {
            stop(reason instanceof Error ? reason : new Error(String(reason)));
            await inner.terminate();
          },
        };
        return handle;
      },
    }),
  };
}

describe('PluginHost project calls', () => {
  it('imports pasted text and validates the candidate', async () => {
    const { host, sent } = recordingHost();
    const candidate = await host.importProject('demo', {
      mode: 'paste',
      name: 'Pasted',
      text: 'void mainImage() {}',
    });
    expect(candidate.name).toBe('Pasted');
    expect(candidate.project.passes.some((pass) => pass.kind === 'image')).toBe(true);
    expect(sent).toEqual([{ mode: 'paste', name: 'Pasted', text: 'void mainImage() {}' }]);
  });

  it('sends a provider source document and nothing else — no credential crosses', async () => {
    const { host, sent } = recordingHost();
    const input = {
      mode: 'provider' as const,
      provider: 'shadertoy-api/v1' as const,
      sourceId: 'XsBSRR',
      source: { Shader: { info: { id: 'XsBSRR' } } },
      apiKey: 'secret-key',
    };
    await host.importProject('demo', input);
    expect(JSON.stringify(sent)).not.toContain('secret-key');
    expect(sent[0]).toEqual({
      mode: 'provider',
      provider: 'shadertoy-api/v1',
      sourceId: 'XsBSRR',
      source: { Shader: { info: { id: 'XsBSRR' } } },
    });
  });

  it('refuses undeclared modes, other providers, oversize input and malformed replies', async () => {
    const { host, sent } = recordingHost();
    await expect(
      host.importProject('demo', {
        mode: 'provider',
        provider: 'other/v1' as never,
        sourceId: 'x',
        source: {},
      }),
    ).rejects.toMatchObject({ code: 'input-invalid' });
    await expect(
      host.importProject('demo', {
        mode: 'paste',
        name: 'Big',
        text: 'x'.repeat(PROJECT_LIMITS.pasteBytes + 1),
      }),
    ).rejects.toMatchObject({ code: 'input-too-large' });
    await expect(
      host.importProject('demo', {
        mode: 'provider',
        provider: 'shadertoy-api/v1',
        sourceId: 'x',
        source: { blob: 'x'.repeat(PROJECT_LIMITS.sourceBytes) },
      }),
    ).rejects.toMatchObject({ code: 'input-too-large' });
    expect(sent).toEqual([]);
    await expect(
      host.importProject('demo', { mode: 'paste', name: 'x', text: 'malformed' }),
    ).rejects.toMatchObject({ code: 'output-invalid' });
    await expect(
      host.importProject('demo-export', { mode: 'paste', name: 'x', text: '' }),
    ).rejects.toMatchObject({ code: 'unknown-contribution' });
  });

  it('cancels and times out without a result', async () => {
    const { host } = recordingHost();
    const controller = new AbortController();
    const call = host.importProject(
      'demo',
      { mode: 'paste', name: 'x', text: 'hang' },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await expect(call).rejects.toThrow();
    await expect(
      recordingHost().host.importProject('demo', { mode: 'paste', name: 'x', text: 'hang' }),
    ).rejects.toThrow(/timed out/);
  });

  it('exports a snapshot and checks only the envelope', async () => {
    const { host } = recordingHost();
    const result = await host.exportProject('demo-export', {
      name: 'Seascape',
      project: { version: 1, vertex: '', passes: [], files: [] },
      controls: [],
      params: {},
      channels: [],
      postProcessingActive: true,
    });
    expect(result).toEqual({
      data: { title: 'Seascape', passes: 0 },
      warnings: ['post-processing omitted'],
    });
  });
});
