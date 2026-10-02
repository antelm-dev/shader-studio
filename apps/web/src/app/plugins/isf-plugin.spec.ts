import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_VERSION,
  isPluginCompatible,
  parsePluginPackage,
  validateEffectCandidate,
  type EffectCandidate,
  type PluginPackage,
} from '@shadergrove/shared';
import { PluginCallError, PluginHost } from './plugin-host';
import { inProcessStart } from './testing/in-process-sandbox';

/**
 * The ISF plugin, as a user installs it: the committed `.sgplugin.json`, loaded
 * through the real `PluginHost` and its limits, its code run by an in-process
 * stand-in for the Worker (see `testing/in-process-sandbox`). Compiling and
 * drawing the converted effects is the browser E2E's part.
 */
const dir = resolve(import.meta.dirname, '../../../../../tools/workspace/fixtures/plugins/isf');
const read = (path: string) => readFileSync(resolve(dir, path), 'utf8');

function loadPackage(): PluginPackage {
  const parsed = parsePluginPackage(read('isf.sgplugin.json'));
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}

const plugin = loadPackage();
const host = () => new PluginHost(plugin, { start: inProcessStart(plugin.code!) });
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function importIsf(text: string): Promise<EffectCandidate> {
  const result = await host().importFile('isf-import', bytes(text));
  const candidate = validateEffectCandidate(result.candidate);
  if (!candidate.ok) throw new Error(candidate.errors.join('; '));
  return candidate.value;
}

async function exportIsf(effect: EffectCandidate): Promise<string> {
  const result = await host().exportEffect('isf-export', effect);
  expect(result.mime).toBe('text/plain');
  return new TextDecoder().decode(result.bytes);
}

const header = (text: string) =>
  JSON.parse(text.slice(2, text.indexOf('*/'))) as Record<string, unknown>;
const isfBody = (text: string) =>
  text
    .slice(text.indexOf('*/') + 2)
    .replace(/^\r?\n/, '')
    .trimEnd();
const markedBody = (source: string) =>
  source.slice(
    source.indexOf('// ---- ISF source ----\n') + '// ---- ISF source ----\n'.length,
    source.indexOf('\n// ---- end of ISF source ----'),
  );

describe('the ISF plugin package', () => {
  it('is what its manifest and code build, and installs on this app version', () => {
    const built = `${JSON.stringify(
      {
        manifest: JSON.parse(read('manifest.json')),
        code: read('isf-plugin.js').replace(/\r\n/g, '\n'),
      },
      null,
      2,
    )}\n`;
    expect(read('isf.sgplugin.json').replace(/\r\n/g, '\n')).toBe(built);
    expect(isPluginCompatible(plugin.manifest, APP_VERSION)).toBe(true);
    expect(plugin.manifest.contributions.map((c) => `${c.kind}:${c.id}`)).toEqual([
      'importer:isf-import',
      'exporter:isf-export',
    ]);
  });
});

describe('importing ISF FX filters', () => {
  it('converts a plain colour filter, keeping its code untouched between the markers', async () => {
    const text = read('examples/tint.fs');
    const effect = await importIsf(text);

    expect(effect.name).toBe('Warm tint');
    expect(effect.controls).toEqual([]);
    expect(markedBody(effect.source)).toBe(isfBody(text).replace(/\r\n/g, '\n'));
    expect(effect.source).toContain('#define main isf_main');
    expect(effect.source).toMatch(/vec4 effect\(vec4 isf_color, vec2 isf_coord\)/);
  });

  it('converts a filter that samples at offset coordinates with time and render size', async () => {
    const effect = await importIsf(read('examples/uv-offset.fs'));

    expect(effect.name).toBe('Wobble');
    expect(effect.source).toContain(
      '#define IMG_NORM_PIXEL(image, coord) texture2D(tDiffuse, coord)',
    );
    expect(effect.source).toContain('#define TIME u_time');
    expect(effect.source).toContain('#define RENDERSIZE u_resolution');
  });

  it('turns float, bool, color and long inputs into controls with their defaults', async () => {
    const effect = await importIsf(read('examples/controls.fs'));

    expect(effect.controls).toEqual([
      { key: 'levels', type: 'number', default: 4, min: 2, max: 16, label: 'Levels' },
      { key: 'invert', type: 'boolean', default: false, label: 'Invert' },
      { key: 'tint', type: 'color', default: '#ff8040', label: 'Tint' },
      {
        key: 'channel',
        type: 'select',
        default: 0,
        options: { All: 0, Luma: 1, Red: 2 },
        label: 'Channel',
      },
    ]);
    expect(effect.values).toEqual({ levels: 4, invert: false, tint: '#ff8040', channel: 0 });
    // Each ISF name reaches its control's uniform through the preprocessor, as ISF typed it.
    expect(effect.source).toContain('#define levels u_levels');
    expect(effect.source).toContain('#define tint vec4(u_tint, 1.0)');
    expect(effect.source).toContain('#define channel int(u_channel)');
  });
});

describe('exporting and re-importing', () => {
  it('round-trips an imported filter: code, controls, current values and the rest of the header', async () => {
    const original = read('examples/controls.fs');
    const imported = await importIsf(original);
    const tuned = { ...imported, values: { levels: 8, invert: true, tint: '#00ff00', channel: 2 } };

    const exported = await exportIsf(tuned);
    expect(header(exported)).toMatchObject({
      ISFVSN: '2',
      DESCRIPTION: 'Posterize',
      CREDIT: 'Shadergrove fixture',
      CATEGORIES: ['Stylize'],
    });
    expect(isfBody(exported)).toBe(isfBody(original).replace(/\r\n/g, '\n'));

    const again = await importIsf(exported);
    expect(again.controls).toEqual(
      imported.controls.map((control) => ({
        ...control,
        default: tuned.values[control.key as keyof typeof tuned.values],
      })),
    );
    expect(again.values).toEqual(tuned.values);
    expect(markedBody(again.source)).toBe(markedBody(imported.source));
  });

  it('exports an effect written here as ISF that imports back with the same controls', async () => {
    const native: EffectCandidate = {
      name: 'Gain & tint',
      source:
        'vec4 effect(vec4 color, vec2 uv) {\n  vec4 shifted = texture2D(tDiffuse, uv + vec2(0.01, 0.0));\n  return vec4(mix(color.rgb, shifted.rgb, 0.5) * u_gain * u_tint, color.a);\n}',
      controls: [
        { key: 'gain', type: 'number', default: 1, min: 0, max: 2 },
        { key: 'tint', type: 'color', default: '#ffffff' },
      ],
      values: { gain: 1.5, tint: '#ff0000' },
    };

    const exported = await exportIsf(native);
    expect(header(exported)['INPUTS']).toEqual([
      { NAME: 'inputImage', TYPE: 'image' },
      { NAME: 'gain', TYPE: 'float', DEFAULT: 1.5, MIN: 0, MAX: 2 },
      { NAME: 'tint', TYPE: 'color', DEFAULT: [1, 0, 0, 1] },
    ]);
    expect(exported).toContain('#define u_gain gain');
    expect(exported).toContain(
      'gl_FragColor = effect(IMG_THIS_PIXEL(inputImage), isf_FragNormCoord);',
    );

    const again = await importIsf(exported);
    expect(again.name).toBe('Gain & tint');
    expect(again.controls.map((control) => control.key)).toEqual(['gain', 'tint']);
    expect(again.values).toEqual({ gain: 1.5, tint: '#ff0000' });
    // Its own `effect` is renamed by the preprocessor so the wrapper's can exist.
    expect(again.source).toContain('#define effect isf_inner_effect');
  });
});

describe('what the ISF plugin refuses, with a reason', () => {
  const isf = (
    json: Record<string, unknown>,
    body = 'void main() { gl_FragColor = IMG_THIS_PIXEL(inputImage); }',
  ) => `/*${JSON.stringify(json)}*/\n${body}`;
  const image = { NAME: 'inputImage', TYPE: 'image' };
  const failure = (text: string) =>
    host()
      .importFile('isf-import', bytes(text))
      .then(
        () => 'imported',
        (error: Error) => error.message,
      );

  it.each([
    ['a generator', isf({ ISFVSN: '2', INPUTS: [] }), /generator/],
    [
      'a transition',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'startImage', TYPE: 'image' }] }),
      /transition/,
    ],
    [
      'an audio input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'wave', TYPE: 'audio' }] }),
      /audio/,
    ],
    [
      'a point2D input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'centre', TYPE: 'point2D' }] }),
      /point2D/,
    ],
    [
      'an event input',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'bang', TYPE: 'event' }] }),
      /event/,
    ],
    ['several passes', isf({ ISFVSN: '2', INPUTS: [image], PASSES: [{}, {}] }), /Multi-pass/],
    [
      'a persistent buffer',
      isf({ ISFVSN: '2', INPUTS: [image], PASSES: [{ TARGET: 'acc', PERSISTENT: true }] }),
      /Persistent/,
    ],
    [
      'imported images',
      isf({ ISFVSN: '2', INPUTS: [image], IMPORTED: { noise: { PATH: 'noise.png' } } }),
      /IMPORTED/,
    ],
    ['an ISF 1 file', isf({ INPUTS: [image] }), /ISF 1/],
    ['an unknown version', isf({ ISFVSN: '3', INPUTS: [image] }), /version "3"/],
    [
      'a reserved input name',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'time', TYPE: 'float' }] }),
      /reserved/,
    ],
    [
      'a long without VALUES',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'mode', TYPE: 'long' }] }),
      /VALUES/,
    ],
    [
      'a float whose MIN is not below MAX',
      isf({ ISFVSN: '2', INPUTS: [image, { NAME: 'k', TYPE: 'float', MIN: 1, MAX: 1 }] }),
      /MIN/,
    ],
    ['a header that is not JSON', '/*{ nope */\nvoid main() {}', /not valid JSON/],
    ['a file with no header', 'void main() {}', /must start with/],
  ])('refuses %s', async (_what, text, reason) => {
    expect(await failure(text)).toMatch(reason);
  });

  it('refuses a file that is not UTF-8 text', async () => {
    const latin1 = new Uint8Array([0x2f, 0x2a, 0xff, 0xfe]).buffer;
    await expect(host().importFile('isf-import', latin1)).rejects.toThrow(/not UTF-8/);
  });

  it('refuses a file over the size its manifest allows before the plugin sees it', async () => {
    const tooBig = new ArrayBuffer(262_145);
    await expect(host().importFile('isf-import', tooBig)).rejects.toMatchObject({
      code: 'input-too-large',
    } satisfies Partial<PluginCallError>);
  });
});
