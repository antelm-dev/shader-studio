// Shadergrove ISF plugin — one-pass ISF FX filters to and from custom effects.
//
// Runs inside the plugin Worker: no DOM, no network, no imports; it only sees the
// bytes and form values the host hands it, and the host revalidates and compiles
// whatever it returns. https://docs.isf.video/ref_json, /ref_functions.html
//
// Import keeps the ISF GLSL as it is, between two marker lines, and adapts it with
// the preprocessor only — `#define main isf_main`, the IMG_* macros, TIME,
// RENDERSIZE, one macro per input (via a global where the type differs) — so
// nothing in the author's code is rewritten.
// Export rebuilds the JSON header from the effect's controls and current values.
//
// Supported: ISFVSN 2, one `inputImage`, no PASSES (or one plain pass), inputs of
// type float, bool, long (with VALUES) and color (alpha dropped: controls are RGB).
// Built-ins: isf_FragNormCoord, RENDERSIZE, TIME, IMG_THIS_PIXEL,
// IMG_THIS_NORM_PIXEL, IMG_NORM_PIXEL, IMG_PIXEL, IMG_SIZE. Anything else fails to
// compile, and the host shows where.

const HEADER_MARK = '// ISF-HEADER: ';
const BEGIN_MARK = '// ---- ISF source ----';
const END_MARK = '// ---- end of ISF source ----';
const MAX_CONTROLS = 16;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
// The app's own uniform names, and every name this file defines a macro or a symbol for.
const RESERVED = new Set([
  'clickData',
  'time',
  'resolution',
  'mouse',
  'mouseVel',
  'channel0',
  'channel1',
  'channel2',
  'channel3',
  'main',
  'effect',
  'inputImage',
  'tDiffuse',
  'TIME',
  'RENDERSIZE',
  'IMG_THIS_PIXEL',
  'IMG_THIS_NORM_PIXEL',
  'IMG_NORM_PIXEL',
  'IMG_PIXEL',
  'IMG_SIZE',
]);

const fail = (message) => {
  throw new Error(message);
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function splitIsf(text) {
  const start = text.indexOf('/*');
  if (start < 0 || text.slice(0, start).trim() !== '') {
    fail('Not an ISF file: it must start with a /*{ … }*/ JSON header');
  }
  const end = text.indexOf('*/', start + 2);
  if (end < 0) fail('The ISF JSON header is never closed with */');
  let header;
  try {
    header = JSON.parse(text.slice(start + 2, end));
  } catch (error) {
    fail(`The ISF JSON header is not valid JSON: ${error.message}`);
  }
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    fail('The ISF JSON header must be an object');
  }
  return { header, body: text.slice(end + 2).replace(/^\r?\n/, '') };
}

/**
 * An input whose type differs here is read from a global set before the ISF main runs:
 * a macro expanding to an expression would also rewrite a declaration of that name, such
 * as a function parameter `vec4 color`, into one that does not compile.
 */
function viaGlobal(key, type, value) {
  return {
    macro: `${type} isf_in_${key};\n#define ${key} isf_in_${key}`,
    setup: `  isf_in_${key} = ${value};`,
  };
}

function checkSupported(header) {
  const version = header.ISFVSN;
  if (version === undefined) fail('ISF 1 files (no ISFVSN) are not supported; only ISF 2 is');
  if (!['2', '2.0'].includes(String(version))) {
    fail(`ISF version ${JSON.stringify(version)} is not supported; only ISF 2 is`);
  }
  if (Array.isArray(header.IMPORTED) ? header.IMPORTED.length > 0 : header.IMPORTED) {
    fail('Imported images (IMPORTED) are not supported');
  }
  if (header.PASSES !== undefined) {
    if (!Array.isArray(header.PASSES)) fail('PASSES must be an array');
    if (header.PASSES.length > 1) {
      fail(`Multi-pass ISF is not supported: this file has ${header.PASSES.length} passes`);
    }
    const pass = header.PASSES[0] ?? {};
    if (pass.TARGET || pass.PERSISTENT || pass.FLOAT) {
      fail('Persistent or named pass buffers are not supported');
    }
    // The effect renders at the output size; a pass of its own size would not be the same image.
    if (pass.WIDTH !== undefined || pass.HEIGHT !== undefined) {
      fail('Passes with their own WIDTH or HEIGHT are not supported');
    }
  }
}

const number = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function label(input) {
  return typeof input.LABEL === 'string' && input.LABEL.trim()
    ? { label: input.LABEL.trim().slice(0, 64) }
    : {};
}

function hex(rgba) {
  const channel = (value) =>
    Math.round(clamp(number(value, 0), 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return Array.isArray(rgba)
    ? `#${channel(rgba[0])}${channel(rgba[1])}${channel(rgba[2])}`
    : '#000000';
}

/** One ISF input as a control, and the macro that makes the ISF name mean that control's uniform. */
function inputToControl(input) {
  const key = input.NAME;
  if (typeof key !== 'string' || !KEY.test(key) || RESERVED.has(key) || key.startsWith('isf_')) {
    fail(
      `Input name ${JSON.stringify(key)} cannot be used here: it must be a plain identifier, not a reserved name`,
    );
  }
  switch (input.TYPE) {
    case 'float': {
      const min = number(input.MIN, 0);
      const max = number(input.MAX, 1);
      if (!(min < max)) fail(`Input "${key}": MIN must be less than MAX`);
      return {
        control: {
          key,
          type: 'number',
          default: clamp(number(input.DEFAULT, min), min, max),
          min,
          max,
          ...label(input),
        },
        macro: `#define ${key} u_${key}`,
      };
    }
    case 'bool':
      return {
        control: { key, type: 'boolean', default: Boolean(input.DEFAULT), ...label(input) },
        macro: `#define ${key} u_${key}`,
      };
    case 'long': {
      const values = input.VALUES;
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 64 ||
        !values.every(Number.isInteger)
      ) {
        fail(`Input "${key}": a long input needs VALUES, a list of at most 64 integers`);
      }
      const labels = Array.isArray(input.LABELS) ? input.LABELS : [];
      const options = {};
      values.forEach((value, index) => {
        const name =
          typeof labels[index] === 'string' && labels[index].trim()
            ? labels[index].trim()
            : String(value);
        options[name in options ? `${name} (${value})` : name] = value;
      });
      return {
        control: {
          key,
          type: 'select',
          default: values.includes(input.DEFAULT) ? input.DEFAULT : values[0],
          options,
          ...label(input),
        },
        ...viaGlobal(key, 'int', `int(u_${key})`),
      };
    }
    case 'color':
      return {
        control: { key, type: 'color', default: hex(input.DEFAULT), ...label(input) },
        ...viaGlobal(key, 'vec4', `vec4(u_${key}, 1.0)`),
      };
    case 'image':
      return fail(
        `Only one image input, inputImage, is supported: "${key}" makes this a transition or a multi-image filter`,
      );
    case 'audio':
    case 'audioFFT':
      return fail(`Input "${key}": audio inputs are not supported`);
    case 'point2D':
      return fail(`Input "${key}": point2D inputs are not supported`);
    case 'event':
      return fail(`Input "${key}": event inputs are not supported`);
    default:
      return fail(`Input "${key}": type ${JSON.stringify(input.TYPE)} is not supported`);
  }
}

function importIsf(text) {
  const { header, body } = splitIsf(text);
  checkSupported(header);
  const inputs = header.INPUTS ?? [];
  if (!Array.isArray(inputs)) fail('INPUTS must be an array');
  const isImage = (input) => input && input.NAME === 'inputImage' && input.TYPE === 'image';
  if (!inputs.some(isImage)) {
    fail('This ISF file has no inputImage: it is a generator, and only FX filters are supported');
  }
  const converted = inputs.filter((input) => !isImage(input)).map(inputToControl);
  if (converted.length > MAX_CONTROLS) fail(`At most ${MAX_CONTROLS} inputs are supported`);

  const controls = converted.map((entry) => entry.control);
  const values = Object.fromEntries(controls.map((control) => [control.key, control.default]));
  const name =
    (typeof header.DESCRIPTION === 'string' && header.DESCRIPTION.trim().slice(0, 64)) ||
    'ISF effect';
  // The header, minus what the controls now hold, so an export can restore CREDIT and the rest.
  const { INPUTS: _inputs, ...kept } = header;
  const source = [
    '// Converted from ISF by the Shadergrove ISF plugin. Edit the ISF code between the',
    '// two marker lines; the lines around them are what lets it run here.',
    HEADER_MARK + JSON.stringify(kept),
    '#define inputImage tDiffuse',
    '#define RENDERSIZE u_resolution',
    '#define TIME u_time',
    '#define IMG_NORM_PIXEL(image, coord) texture2D(tDiffuse, coord)',
    '#define IMG_THIS_NORM_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    '#define IMG_THIS_PIXEL(image) texture2D(tDiffuse, isf_uv)',
    '#define IMG_PIXEL(image, coord) texture2D(tDiffuse, (coord) / u_resolution)',
    '#define IMG_SIZE(image) u_resolution',
    '#define isf_FragNormCoord isf_uv',
    ...converted.map((entry) => entry.macro),
    'vec2 isf_uv;',
    '#define main isf_main',
    '#define effect isf_inner_effect',
    BEGIN_MARK,
    body.replace(/\s+$/, ''),
    END_MARK,
    '#undef effect',
    '#undef main',
    'vec4 effect(vec4 isf_color, vec2 isf_coord) {',
    '  isf_uv = isf_coord;',
    ...converted.flatMap((entry) => (entry.setup ? [entry.setup] : [])),
    '  isf_main();',
    '  return gl_FragColor;',
    '}',
    '',
  ].join('\n');
  return { candidate: { name, source, controls, values } };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function rgba(value) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(value));
  if (!match) return [0, 0, 0, 1];
  return [1, 2, 3].map((i) => Math.round((parseInt(match[i], 16) / 255) * 1000) / 1000).concat(1);
}

/** A control back as an ISF input, its DEFAULT the effect's current value. */
function controlToInput(control, values) {
  const value = values[control.key] ?? control.default;
  const named = { NAME: control.key, ...(control.label ? { LABEL: control.label } : {}) };
  switch (control.type) {
    case 'number':
      return { ...named, TYPE: 'float', DEFAULT: value, MIN: control.min, MAX: control.max };
    case 'boolean':
      return { ...named, TYPE: 'bool', DEFAULT: Boolean(value) };
    case 'select': {
      const entries = Object.entries(control.options);
      return {
        ...named,
        TYPE: 'long',
        DEFAULT: value,
        VALUES: entries.map((entry) => entry[1]),
        LABELS: entries.map((entry) => entry[0]),
      };
    }
    case 'color':
      return { ...named, TYPE: 'color', DEFAULT: rgba(value) };
    default:
      return fail(`Control "${control.key}" cannot be expressed in ISF`);
  }
}

/** The ISF code and kept header of an effect this plugin imported, or null for any other effect. */
function extractIsf(source) {
  const lines = source.split('\n');
  const headerLine = lines.find((line) => line.startsWith(HEADER_MARK));
  const begin = lines.indexOf(BEGIN_MARK);
  const end = lines.indexOf(END_MARK);
  if (!headerLine || begin < 0 || end < begin) return null;
  let header;
  try {
    header = JSON.parse(headerLine.slice(HEADER_MARK.length));
  } catch {
    return null;
  }
  return { header, body: lines.slice(begin + 1, end).join('\n') };
}

/**
 * Any other custom effect: its own code, made to read ISF's names, under an ISF main.
 * A control is read through a function declared at global scope, where its name can
 * only be the ISF input — a macro expanding to the bare name would bind to whatever
 * the effect's code declares under it, like `effect(vec4 color, …)` for a control `color`.
 */
function wrapNative(effect) {
  const readers = effect.controls.flatMap((control) => {
    const [type, value] =
      control.type === 'color'
        ? ['vec3', `${control.key}.rgb`]
        : control.type === 'select'
          ? ['float', `float(${control.key})`]
          : control.type === 'boolean'
            ? ['bool', control.key]
            : ['float', control.key];
    return [
      `${type} isf_u_${control.key}() { return ${value}; }`,
      `#define u_${control.key} isf_u_${control.key}()`,
    ];
  });
  return [
    '// Exported from a Shadergrove custom effect: vec4 effect(vec4 color, vec2 uv) runs on',
    '// every pixel of inputImage. The defines map its names onto ISF’s.',
    '#define tDiffuse inputImage',
    '#define vUv isf_FragNormCoord',
    '#define u_resolution RENDERSIZE',
    '#define u_time TIME',
    ...readers,
    effect.source.replace(/\s+$/, ''),
    'void main() {',
    '  gl_FragColor = effect(IMG_THIS_PIXEL(inputImage), isf_FragNormCoord);',
    '}',
    // Imported back, this code is followed by Shadergrove's own main, which reads `vUv`.
    ...['tDiffuse', 'vUv', 'u_resolution', 'u_time']
      .concat(effect.controls.map((control) => `u_${control.key}`))
      .map((name) => `#undef ${name}`),
    '',
  ].join('\n');
}

function exportIsf(effect) {
  if (!effect || typeof effect.source !== 'string' || !Array.isArray(effect.controls)) {
    fail('Not an effect definition');
  }
  const values = effect.values && typeof effect.values === 'object' ? effect.values : {};
  const imported = extractIsf(effect.source);
  const header = {
    ...(imported ? imported.header : { ISFVSN: '2.0', CATEGORIES: ['Shadergrove'] }),
    DESCRIPTION: String(effect.name ?? 'Effect'),
    INPUTS: [
      { NAME: 'inputImage', TYPE: 'image' },
      ...effect.controls.map((control) => controlToInput(control, values)),
    ],
  };
  const body = imported ? `${imported.body.replace(/\s+$/, '')}\n` : wrapNative(effect);
  const text = `/*${JSON.stringify(header, null, 2)}*/\n${body}`;
  const stem =
    String(effect.name ?? 'effect')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'effect';
  return {
    bytes: new TextEncoder().encode(text).buffer,
    mime: 'text/plain',
    fileName: `${stem}.fs`,
  };
}

shaderStudio.handle('importer:isf-import', ({ bytes }) => {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('The file is not UTF-8 text');
  }
  return importIsf(text);
});

shaderStudio.handle('exporter:isf-export', ({ effect }) => exportIsf(effect));
