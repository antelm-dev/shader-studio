import { describe, expect, it } from 'vitest';

import {
  PROJECT_LIMITS,
  validatePluginPackage,
  validateProjectCandidate,
  validateProjectExportEnvelope,
  type ProjectImporterContribution,
} from './package';
import { validateCatalogue } from './catalogue';
import { validateWallpaperWebData } from './wallpaper-web';

const projectImporter = {
  kind: 'projectImporter',
  id: 'shadertoy',
  name: 'Shadertoy',
  modes: ['paste', 'provider'],
  provider: 'shadertoy-api/v1',
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
};
const projectExporter = {
  kind: 'projectExporter',
  id: 'wallpaper',
  name: 'Wallpaper',
  runtime: 'wallpaper-web/v1',
  maxInputBytes: 1_000_000,
  maxOutputBytes: 1_000_000,
};

function pkg(contributions: unknown[], protocolVersion = 2) {
  return {
    manifest: {
      id: 'dev.example.project',
      version: '1.0.0',
      protocolVersion,
      appVersionRange: '>=1.4.0 <2.0.0',
      name: 'Project',
      publisher: 'Example',
      license: 'MIT',
      contributions,
    },
    code: 'shaderStudio.handle("projectImporter:shadertoy", () => ({}));',
  };
}

const errors = (input: unknown) => {
  const result = validatePluginPackage(input);
  return result.ok ? [] : result.errors;
};

describe('protocol-2 manifests', () => {
  it('accepts project importers and exporters under protocol 2', () => {
    const result = validatePluginPackage(pkg([projectImporter, projectExporter]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const importer = result.value.manifest.contributions[0] as ProjectImporterContribution;
    expect(importer.modes).toEqual(['paste', 'provider']);
    expect(importer.provider).toBe('shadertoy-api/v1');
  });

  it('keeps protocol 1 working and refuses the new kinds there', () => {
    expect(errors(pkg([projectImporter], 1))[0]).toMatch(/needs protocolVersion 2/);
    const effectOnly = {
      manifest: {
        ...pkg([], 1).manifest,
        contributions: [{ kind: 'effect', id: 'tint', name: 'Tint', controls: [] }],
      },
      glsl: { tint: 'vec4 effect(vec4 c, vec2 uv) { return c; }' },
    };
    expect(validatePluginPackage(effectOnly).ok).toBe(true);
  });

  it('refuses unknown adapters, fields and modes', () => {
    expect(errors(pkg([{ ...projectImporter, provider: 'http-anything/v1' }]))[0]).toMatch(
      /not a supported source provider/,
    );
    expect(errors(pkg([{ ...projectExporter, runtime: 'native/v1' }]))[0]).toMatch(
      /not a supported export runtime/,
    );
    expect(errors(pkg([{ ...projectImporter, url: 'https://x' }]))[0]).toMatch(
      /url is not a known/,
    );
    expect(errors(pkg([{ ...projectImporter, modes: ['upload'] }]))[0]).toMatch(/modes/);
    expect(errors(pkg([{ ...projectImporter, modes: ['paste', 'paste'] }]))[0]).toMatch(/modes/);
    const { provider: _, ...pasteOnly } = projectImporter;
    expect(errors(pkg([{ ...pasteOnly, modes: ['provider'] }]))[0]).toMatch(/provider/);
    expect(validatePluginPackage(pkg([{ ...pasteOnly, modes: ['paste'] }])).ok).toBe(true);
    expect(
      errors(pkg([{ ...pasteOnly, modes: ['paste'], provider: 'shadertoy-api/v1' }]))[0],
    ).toMatch(/only for the "provider" mode/);
  });

  it('bounds the declared limits and requires code', () => {
    expect(
      errors(pkg([{ ...projectImporter, maxInputBytes: PROJECT_LIMITS.inputBytes + 1 }]))[0],
    ).toMatch(/maxInputBytes/);
    expect(errors(pkg([{ ...projectExporter, maxOutputBytes: 0 }]))[0]).toMatch(/maxOutputBytes/);
    const { code: _, ...noCode } = pkg([projectExporter]);
    expect(errors(noCode)[0]).toMatch(/code is required/);
  });
});

const image = {
  id: 'image-1',
  kind: 'image',
  name: 'Image',
  slot: null,
  enabled: true,
  source: 'void main() { gl_FragColor = vec4(1.0); }',
  channels: [
    { kind: 'texture', slot: 2 },
    { kind: 'buffer', passId: 'buffer-a', feedback: false },
    { kind: 'none' },
    { kind: 'none' },
  ],
};
const buffer = { ...image, id: 'buffer-a', kind: 'buffer', name: 'Buffer A', slot: 'A' };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Seascape',
    description: 'Waves',
    credits: { author: 'TDM', sourceUrl: 'https://www.shadertoy.com/view/Ms2SD1' },
    project: { version: 1, vertex: 'void main() {}', passes: [image, buffer], files: [] },
    controls: [],
    values: {},
    textures: [
      {
        asset: '/media/a/abc.png',
        uses: [{ passId: 'image-1', channel: 0 }],
        wrap: 'repeat',
        filter: 'linear',
        flipY: true,
      },
    ],
    warnings: ['one'],
    ...overrides,
  };
}

describe('validateProjectCandidate', () => {
  it('accepts a candidate and clears texture bindings the plugin wrote itself', () => {
    const result = validateProjectCandidate(candidate());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const imagePass = result.value.project.passes.find((pass) => pass.kind === 'image')!;
    expect(imagePass.channels[0]).toEqual({ kind: 'none' });
    expect(imagePass.channels[1]).toEqual({ kind: 'buffer', passId: 'buffer-a', feedback: false });
    expect(result.value.textures[0]!.uses).toEqual([{ passId: 'image-1', channel: 0 }]);
    expect(result.value.credits.author).toBe('TDM');
  });

  it('refuses unknown fields, missing images, bad uses and oversized parts', () => {
    const bad = (overrides: Record<string, unknown>) => {
      const result = validateProjectCandidate(candidate(overrides));
      return result.ok ? '' : result.errors[0];
    };
    expect(bad({ html: '<script>' })).toMatch(/html is not a known field/);
    expect(bad({ project: { passes: [buffer] } })).toMatch(/Image pass/);
    expect(bad({ project: { passes: [image, { ...buffer, id: 'image-1' }] } })).toMatch(/unique/);
    expect(
      bad({
        textures: [
          {
            asset: 'x',
            uses: [{ passId: 'nope', channel: 0 }],
            wrap: 'repeat',
            filter: 'linear',
            flipY: true,
          },
        ],
      }),
    ).toMatch(/name a pass/);
    expect(
      bad({
        textures: [
          {
            asset: 'x',
            uses: [{ passId: 'image-1', channel: 4 }],
            wrap: 'repeat',
            filter: 'linear',
            flipY: true,
          },
        ],
      }),
    ).toMatch(/channel/);
    expect(
      bad({ warnings: Array.from({ length: PROJECT_LIMITS.warnings + 1 }, () => 'w') }),
    ).toMatch(/warnings/);
    expect(bad({ warnings: ['x'.repeat(PROJECT_LIMITS.warningLength + 1)] })).toMatch(/warnings/);
    expect(bad({ credits: { sourceUrl: 'javascript:alert(1)' } })).toMatch(/https/);
    expect(bad({ project: { passes: [{ ...image, source: 'x'.repeat(200_001) }] } })).toMatch(
      /at most/,
    );
  });
});

describe('validateProjectExportEnvelope', () => {
  it('requires data and bounded warnings only', () => {
    expect(validateProjectExportEnvelope({ data: {}, warnings: [] }).ok).toBe(true);
    expect(validateProjectExportEnvelope({ warnings: [] }).ok).toBe(false);
    expect(validateProjectExportEnvelope({ data: {}, html: '' }).ok).toBe(false);
  });
});

const wallpaper = {
  title: 'Seascape',
  vertex: 'void main() {}',
  passes: [
    {
      id: 'buffer-a',
      name: 'Buffer A',
      kind: 'buffer',
      fragment: 'void main() {}',
      channels: [
        { kind: 'buffer', passId: 'buffer-a', feedback: true },
        { kind: 'none' },
        { kind: 'none' },
        { kind: 'none' },
      ],
      resolution: { mode: 'viewport', scale: 1, width: 512, height: 512 },
      filter: 'linear',
      wrap: 'clamp',
    },
    {
      id: 'image-1',
      name: 'Image',
      kind: 'image',
      fragment: 'void main() {}',
      channels: [
        { kind: 'buffer', passId: 'buffer-a', feedback: false },
        { kind: 'texture', slot: 0 },
        { kind: 'none' },
        { kind: 'none' },
      ],
      resolution: { mode: 'viewport', scale: 1, width: 512, height: 512 },
      filter: 'linear',
      wrap: 'clamp',
    },
  ],
  uniforms: [
    { uniform: 'speed', kind: 'float', value: 1 },
    { uniform: 'glow', kind: 'bool', value: true },
    { uniform: 'tint', kind: 'color', value: '1 0.5 0' },
    { uniform: 'mode', kind: 'float', value: 1 },
    { uniform: 'hidden', kind: 'float', value: 7 },
  ],
  properties: [
    {
      key: 'ssspeed',
      uniform: 'speed',
      text: 'Speed',
      order: 0,
      type: 'slider',
      min: 0,
      max: 2,
      step: 0.01,
      precision: 2,
      value: 1,
    },
    { key: 'ssglow', uniform: 'glow', text: 'Glow', order: 1, type: 'bool', value: true },
    { key: 'sstint', uniform: 'tint', text: 'Tint', order: 2, type: 'color', value: '1 0.5 0' },
    {
      key: 'ssmode',
      uniform: 'mode',
      text: 'Mode',
      order: 3,
      type: 'combo',
      options: [
        { label: 'A', value: '0' },
        { label: 'B', value: '1' },
      ],
      value: '1',
    },
  ],
  channels: [{ slot: 0, wrap: 'repeat', filter: 'linear', flipY: true }],
};

describe('validateWallpaperWebData', () => {
  it('accepts every supported property type', () => {
    const result = validateWallpaperWebData(wallpaper);
    expect(result.ok).toBe(true);
  });

  it('refuses templates, bad keys, out-of-range defaults and dangling buffers', () => {
    const bad = (value: unknown) => {
      const result = validateWallpaperWebData(value);
      return result.ok ? '' : result.errors[0];
    };
    expect(bad({ ...wallpaper, html: '<script>' })).toMatch(/html is not a known field/);
    expect(bad({ ...wallpaper, passes: [...wallpaper.passes].reverse() })).toMatch(/end with/);
    expect(
      bad({ ...wallpaper, properties: [{ ...wallpaper.properties[0], key: 'Bad Key' }] }),
    ).toMatch(/key/);
    expect(bad({ ...wallpaper, properties: [{ ...wallpaper.properties[0], value: 9 }] })).toMatch(
      /slider/,
    );
    expect(
      bad({ ...wallpaper, properties: [{ ...wallpaper.properties[2], value: '#ff0000' }] }),
    ).toMatch(/r g b/);
    expect(bad({ ...wallpaper, properties: [{ ...wallpaper.properties[3], value: '7' }] })).toMatch(
      /one of its options/,
    );
    expect(
      bad({
        ...wallpaper,
        properties: [wallpaper.properties[0], { ...wallpaper.properties[1], key: 'ssspeed' }],
      }),
    ).toMatch(/duplicated/);
    expect(bad({ ...wallpaper, passes: [wallpaper.passes[1]] })).toMatch(/not exported/);
  });

  it('ties every property to a uniform of its kind, and keeps uniforms without properties', () => {
    const bad = (value: unknown) => {
      const result = validateWallpaperWebData(value);
      return result.ok ? '' : result.errors[0];
    };
    const result = validateWallpaperWebData(wallpaper);
    expect(result.ok && result.value.uniforms.find((u) => u.uniform === 'hidden')).toEqual({
      uniform: 'hidden',
      kind: 'float',
      value: 7,
    });
    expect(bad({ ...wallpaper, uniforms: wallpaper.uniforms.slice(1) })).toMatch(/float uniform/);
    expect(bad({ ...wallpaper, uniforms: [...wallpaper.uniforms, wallpaper.uniforms[0]] })).toMatch(
      /duplicated/,
    );
    expect(
      bad({ ...wallpaper, uniforms: [{ uniform: 'x', kind: 'color', value: '#fff' }] }),
    ).toMatch(/uniforms\[0\]/);
  });

  it('accepts any finite combo value written exactly, such as 1e-7', () => {
    const combo = {
      ...wallpaper.properties[3],
      options: [
        { label: 'Zero', value: '0' },
        { label: 'Tiny', value: '1e-7' },
      ],
      value: '1e-7',
    };
    expect(validateWallpaperWebData({ ...wallpaper, properties: [combo] }).ok).toBe(true);
    const sloppy = {
      ...combo,
      options: [{ label: 'Tiny', value: '0.00000010' }],
      value: '0.00000010',
    };
    expect(validateWallpaperWebData({ ...wallpaper, properties: [sloppy] }).ok).toBe(false);
  });
});

describe('validateCatalogue', () => {
  const entry = {
    id: 'dev.shadergrove.shadertoy',
    version: '1.0.0',
    name: 'Shadertoy Import',
    description: 'Imports Shadertoy shaders.',
    publisher: 'Shadergrove',
    license: 'Apache-2.0',
    protocolVersion: 2,
    appVersionRange: '>=1.5.0 <2.0.0',
    file: 'dev.shadergrove.shadertoy-1.0.0.sgplugin.json',
    bytes: 1000,
    sha256: 'a'.repeat(64),
    contributions: [{ kind: 'projectImporter', id: 'shadertoy', name: 'Shadertoy' }],
  };

  it('accepts entries and refuses paths, duplicate ids and bad hashes', () => {
    const catalogue = (packages: unknown[]) => ({
      format: 'shadergrove-plugin-catalogue/v1',
      packages,
    });
    expect(validateCatalogue(catalogue([entry])).ok).toBe(true);
    expect(validateCatalogue(catalogue([{ ...entry, file: '../evil.sgplugin.json' }])).ok).toBe(
      false,
    );
    expect(validateCatalogue(catalogue([{ ...entry, file: 'https://x/a.sgplugin.json' }])).ok).toBe(
      false,
    );
    expect(validateCatalogue(catalogue([entry, entry])).ok).toBe(false);
    expect(validateCatalogue(catalogue([{ ...entry, sha256: 'A'.repeat(64) }])).ok).toBe(false);
    expect(validateCatalogue(catalogue([{ ...entry, code: 'x' }])).ok).toBe(false);
    expect(validateCatalogue({ format: 'other', packages: [] }).ok).toBe(false);
  });
});
