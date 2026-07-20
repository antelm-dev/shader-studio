import { describe, expect, it } from 'vitest';

import { DEFAULT_VERTEX, makePass, type ShaderProject } from '@shader-studio/shared/project';
import type { TextureChannelPayloads } from '@shader-studio/shared/model';

import {
  buildWallpaperDocument,
  prepareWallpaperFragment,
  WALLPAPER_RUNTIME,
} from './wallpaper-export';

function project(): ShaderProject {
  const buffer = makePass({
    id: 'buffer-a',
    kind: 'buffer',
    name: 'Buffer A',
    slot: 'A',
    source: 'void main() { gl_FragColor = vec4(u_speed); }',
  });
  const image = makePass({
    id: 'image',
    kind: 'image',
    name: 'Image',
    source:
      '#include "palette.glsl"\nvoid main() { float edge = fwidth(vUv.x); gl_FragColor = texture2D(iChannel0, vUv) * tint() * edge; }',
    channels: [
      { kind: 'buffer', passId: buffer.id, feedback: false },
      { kind: 'texture', slot: 0 },
      { kind: 'none' },
      { kind: 'none' },
    ],
  });
  return {
    version: 1,
    vertex: DEFAULT_VERTEX,
    passes: [
      image,
      makePass({
        id: 'common',
        kind: 'common',
        name: 'Common',
        source: 'float commonValue() { return 1.0; }',
      }),
      buffer,
    ],
    files: [
      {
        id: 'palette',
        name: 'palette.glsl',
        source: 'vec4 tint() { return vec4(commonValue()); }',
      },
    ],
  };
}

const channels: TextureChannelPayloads = [
  {
    ext: 'png',
    width: 1,
    height: 1,
    wrap: 'repeat',
    filter: 'nearest',
    flipY: true,
    data: 'AQIDBA==',
  },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
  { ext: null, width: 0, height: 0, wrap: 'clamp', filter: 'linear', flipY: true, data: null },
];

describe('Wallpaper Engine HTML export', () => {
  it('packages a directly importable local web wallpaper with composed passes and assets', async () => {
    const result = buildWallpaperDocument({
      name: 'Neon / Rain',
      project: project(),
      controls: [{ key: 'speed_rate', type: 'number', default: 1, min: 0, max: 4 }],
      params: { speed_rate: 2.5 },
      channels,
      bloomEnabled: false,
    });
    const html = await result.document.text();
    expect(result.filename).toBe('Neon-Rain-wallpaper-engine.html');
    expect(html).toContain('data:image/png;base64,AQIDBA==');

    const config = html;
    expect(config).toContain('commonValue()');
    expect(config).toContain('vec4 tint()');
    expect(config).toContain('uniform float u_speed_rate;');
    expect(config.indexOf('"id": "buffer-a"')).toBeLessThan(config.indexOf('"id": "image"'));
    expect(config).toContain('"wallpaperKey": "ssspeedrate"');
    expect(config).toContain('"speed_rate": 2.5');
    const prepared = prepareWallpaperFragment(
      'uniform float generated;\nprecision highp float;\nvoid main(){ float x=fwidth(1.0); }',
    );
    expect(prepared).toMatch(
      /^#extension GL_OES_standard_derivatives : enable\nprecision highp float;\nuniform float generated;/,
    );

    expect(html).toContain('window.__SHADER_STUDIO_WALLPAPER__');
    expect(html).toContain('window.wallpaperPropertyListener');
    expect(() => new Function(WALLPAPER_RUNTIME)).not.toThrow();
  });

  it('reports bloom as an explicit compatibility warning', async () => {
    const result = buildWallpaperDocument({
      name: 'Bloom',
      project: project(),
      controls: [],
      params: {},
      channels,
      bloomEnabled: true,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Bloom is not included');
  });

  it('ships a self-contained runtime with Wallpaper Engine property and multipass support', () => {
    expect(WALLPAPER_RUNTIME).toContain('window.wallpaperPropertyListener');
    expect(WALLPAPER_RUNTIME).toContain('binding.feedback');
    expect(WALLPAPER_RUNTIME).not.toMatch(/https?:\/\//);
  });
});
