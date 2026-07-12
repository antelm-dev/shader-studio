import { describe, expect, it } from 'vitest';

import { BUNDLE_FORMAT, type ShaderControl, type ShaderPayload } from './model';
import {
  buildCollectionBundle,
  buildShaderBundle,
  defaultParams,
  parseBundle,
  sanitizeParams,
  slugify,
  uniqueId,
  validateControls,
  validateId,
  validateName,
  validateSource,
} from './validate';

const controls: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
  { key: 'mirror', type: 'boolean', default: false },
  { key: 'tint', type: 'color', default: '#ff0000' },
  { key: 'mode', type: 'select', default: 1, options: { Off: 0, On: 1 } },
];

function payload(overrides: Partial<ShaderPayload> = {}): ShaderPayload {
  return {
    id: 'demo',
    name: 'Demo',
    description: '',
    controls,
    render: { bloom: { enabled: false, strength: 0.3, radius: 0.5, threshold: 0.85 } },
    fragment: 'void main() { gl_FragColor = vec4(1.0); }',
    vertex: 'void main() { gl_Position = vec4(position, 1.0); }',
    presets: [],
    ...overrides,
  };
}

describe('validateId', () => {
  it('accepts lowercase slugs', () => {
    expect(validateId('poured-paint').ok).toBe(true);
    expect(validateId('a').ok).toBe(true);
    expect(validateId('shader-2').ok).toBe(true);
  });

  // The id becomes a directory name, so these are the cases that matter.
  it.each([
    ['..', 'parent directory'],
    ['.', 'current directory'],
    ['../etc/passwd', 'traversal'],
    ['..\\windows', 'backslash traversal'],
    ['a/b', 'forward slash'],
    ['a\\b', 'backslash'],
    ['a.b', 'dot'],
    ['UPPER', 'uppercase'],
    ['-leading', 'leading hyphen'],
    ['trailing-', 'trailing hyphen'],
    ['with space', 'whitespace'],
    ['nul', 'reserved windows device name'],
    ['con', 'reserved windows device name'],
    ['', 'empty'],
    ['%2e%2e', 'encoded traversal'],
    ['a'.repeat(65), 'too long'],
  ])('rejects %s (%s)', (id) => {
    expect(validateId(id).ok).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(validateId(undefined).ok).toBe(false);
    expect(validateId(42).ok).toBe(false);
    expect(validateId({}).ok).toBe(false);
  });
});

describe('slugify / uniqueId', () => {
  it('derives a legal id from any name', () => {
    expect(slugify('Poured Paint')).toBe('poured-paint');
    expect(slugify('  Ink & Nacre!  ')).toBe('ink-nacre');
    expect(validateId(slugify('../../etc')).ok).toBe(true);
  });

  it('always produces something valid, even from junk', () => {
    for (const name of ['...', '///', '!!!', '   ']) {
      expect(validateId(slugify(name)).ok).toBe(true);
    }
  });

  it('suffixes until the id is free', () => {
    expect(uniqueId('waves', [])).toBe('waves');
    expect(uniqueId('waves', ['waves'])).toBe('waves-2');
    expect(uniqueId('waves', ['waves', 'waves-2'])).toBe('waves-3');
  });
});

describe('validateName', () => {
  it('trims and accepts', () => {
    const result = validateName('  Hex Pulse  ');
    expect(result).toEqual({ ok: true, value: 'Hex Pulse' });
  });

  it('rejects empty, overlong and control characters', () => {
    expect(validateName('   ').ok).toBe(false);
    expect(validateName('x'.repeat(65)).ok).toBe(false);
    expect(validateName('bad\u0000name').ok).toBe(false);
    expect(validateName('bad\nname').ok).toBe(false);
  });
});

describe('validateSource', () => {
  it('rejects empty sources and null bytes', () => {
    expect(validateSource('', 'fragment').ok).toBe(false);
    expect(validateSource('   ', 'fragment').ok).toBe(false);
    expect(validateSource('void main() {}\u0000', 'fragment').ok).toBe(false);
    expect(validateSource(123, 'fragment').ok).toBe(false);
  });

  it('rejects sources beyond the size limit', () => {
    expect(validateSource('x'.repeat(200_001), 'fragment').ok).toBe(false);
  });

  it('accepts ordinary GLSL', () => {
    expect(validateSource('void main() { gl_FragColor = vec4(1.0); }', 'fragment').ok).toBe(true);
  });
});

describe('validateControls', () => {
  it('accepts every control type', () => {
    const result = validateControls(controls);
    expect(result.ok).toBe(true);
  });

  it('rejects a duplicate key', () => {
    const result = validateControls([
      { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
      { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toContain('duplicated');
  });

  it('rejects a default outside its range', () => {
    const result = validateControls([{ key: 'a', type: 'number', default: 5, min: 0, max: 2 }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toContain('must lie within');
  });

  it('rejects min >= max', () => {
    const result = validateControls([{ key: 'a', type: 'number', default: 1, min: 2, max: 2 }]);
    expect(result.ok).toBe(false);
  });

  it('rejects a key that is not a legal GLSL identifier', () => {
    expect(validateControls([{ key: '2fast', type: 'boolean', default: true }]).ok).toBe(false);
    expect(validateControls([{ key: 'has-hyphen', type: 'boolean', default: true }]).ok).toBe(false);
  });

  it('rejects a key reserved by the engine', () => {
    expect(validateControls([{ key: 'clickData', type: 'boolean', default: true }]).ok).toBe(false);
  });

  it('rejects a malformed color default', () => {
    expect(validateControls([{ key: 'c', type: 'color', default: 'red' }]).ok).toBe(false);
    expect(validateControls([{ key: 'c', type: 'color', default: '#fff' }]).ok).toBe(false);
    expect(validateControls([{ key: 'c', type: 'color', default: '#ff00zz' }]).ok).toBe(false);
  });

  it('rejects a select default that is not one of the options', () => {
    const result = validateControls([
      { key: 'm', type: 'select', default: 7, options: { A: 0, B: 1 } },
    ]);
    expect(result.ok).toBe(false);
  });

  it('reports every bad control, not just the first', () => {
    const result = validateControls([
      { key: 'ok', type: 'number', default: 1, min: 0, max: 2 },
      { key: '2bad', type: 'number', default: 1, min: 0, max: 2 },
      { key: 'c', type: 'color', default: 'nope' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toHaveLength(2);
  });

  it('rejects a non-array', () => {
    expect(validateControls({}).ok).toBe(false);
    expect(validateControls(null).ok).toBe(false);
  });
});

describe('defaultParams / sanitizeParams', () => {
  it('takes the default of every control', () => {
    expect(defaultParams(controls)).toEqual({
      speed: 1,
      mirror: false,
      tint: '#ff0000',
      mode: 1,
    });
  });

  it('drops keys that no control declares', () => {
    const result = sanitizeParams(controls, { speed: 1.5, removed: 99 });
    expect(result).not.toHaveProperty('removed');
    expect(result['speed']).toBe(1.5);
  });

  it('clamps a number back into range rather than discarding it', () => {
    // A preset saved before the slider's range was narrowed is still worth
    // keeping — just pulled back into bounds.
    expect(sanitizeParams(controls, { speed: 99 })['speed']).toBe(2);
    expect(sanitizeParams(controls, { speed: -99 })['speed']).toBe(0);
  });

  it('falls back to the default for a value of the wrong type', () => {
    expect(sanitizeParams(controls, { speed: 'fast' })['speed']).toBe(1);
    expect(sanitizeParams(controls, { mirror: 'yes' })['mirror']).toBe(false);
    expect(sanitizeParams(controls, { tint: 'red' })['tint']).toBe('#ff0000');
    expect(sanitizeParams(controls, { speed: NaN })['speed']).toBe(1);
    expect(sanitizeParams(controls, { speed: Infinity })['speed']).toBe(1);
  });

  it('rejects a select value outside its options', () => {
    expect(sanitizeParams(controls, { mode: 5 })['mode']).toBe(1);
    expect(sanitizeParams(controls, { mode: 0 })['mode']).toBe(0);
  });

  it('fills in a missing key with its default', () => {
    expect(sanitizeParams(controls, {})).toEqual(defaultParams(controls));
    expect(sanitizeParams(controls, null)).toEqual(defaultParams(controls));
  });
});

describe('parseBundle', () => {
  it('round-trips a single shader', () => {
    const bundle = buildShaderBundle(payload());
    const parsed = parseBundle(bundle);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.value).toHaveLength(1);
    expect(parsed.ok === true && parsed.value[0].id).toBe('demo');
  });

  it('round-trips a collection', () => {
    const bundle = buildCollectionBundle([
      payload({ id: 'one', name: 'One' }),
      payload({ id: 'two', name: 'Two' }),
    ]);
    const parsed = parseBundle(bundle);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok === true && parsed.value.map((entry) => entry.id)).toEqual(['one', 'two']);
  });

  it('preserves presets, projected onto the schema', () => {
    const bundle = buildShaderBundle(
      payload({
        presets: [
          {
            id: 'warm',
            name: 'Warm',
            createdAt: '2026-01-01T00:00:00.000Z',
            // `stale` no longer exists; `speed` is out of range.
            values: { speed: 99, tint: '#00ff00', stale: 1 },
          },
        ],
      }),
    );

    const parsed = parseBundle(bundle);
    expect(parsed.ok).toBe(true);

    const preset = parsed.ok === true ? parsed.value[0].presets[0] : null;
    expect(preset?.name).toBe('Warm');
    expect(preset?.values).toEqual({ speed: 2, mirror: false, tint: '#00ff00', mode: 1 });
  });

  it('rejects an unknown format', () => {
    const result = parseBundle({ format: 'something/v9', kind: 'shader', shader: payload() });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors[0]).toContain('unsupported bundle format');
  });

  it('rejects a missing format', () => {
    expect(parseBundle({ kind: 'shader', shader: payload() }).ok).toBe(false);
    expect(parseBundle(null).ok).toBe(false);
    expect(parseBundle('a string').ok).toBe(false);
    expect(parseBundle([]).ok).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(parseBundle({ format: BUNDLE_FORMAT, kind: 'other' }).ok).toBe(false);
  });

  it('rejects an empty collection', () => {
    expect(parseBundle({ format: BUNDLE_FORMAT, kind: 'collection', shaders: [] }).ok).toBe(false);
  });

  it('rejects a shader with no fragment source', () => {
    const bundle = buildShaderBundle(payload({ fragment: '' }));
    const result = parseBundle(bundle);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toContain('fragment');
  });

  it('recovers an invalid id from the name instead of failing', () => {
    // Hand-edited bundles are common; an id we can rebuild is not a fatal error.
    const result = parseBundle({
      format: BUNDLE_FORMAT,
      kind: 'shader',
      shader: { ...payload(), id: '../escape' },
    });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.value[0].id).toBe('demo');
  });

  it('fails when the id is unusable and the name cannot save it', () => {
    const result = parseBundle({
      format: BUNDLE_FORMAT,
      kind: 'shader',
      shader: { ...payload(), id: '../escape', name: '' },
    });
    expect(result.ok).toBe(false);
  });

  it('reports which shader in a collection was bad', () => {
    const result = parseBundle({
      format: BUNDLE_FORMAT,
      kind: 'collection',
      shaders: [payload(), { ...payload(), id: 'two', name: 'Two', fragment: 42 }],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.join()).toContain('shaders[1].fragment');
  });
});
