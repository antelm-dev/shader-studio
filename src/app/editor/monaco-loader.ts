import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

import type { ColorScheme } from '../core/preferences';

/**
 * Loads Monaco once, on demand, in the browser only.
 *
 * The entry point matters. Three are on offer:
 *
 *   editor.api     the API surface and nothing else — no find, no folding, no
 *                  suggestions. Lean, but a poor place to write code.
 *   editor.main    everything, including all ~90 bundled languages and the
 *                  TypeScript/CSS/HTML/JSON language services. Megabytes we
 *                  would never use.
 *   edcore.main    the editor and every one of its contributions, with no
 *                  languages at all.
 *
 * `edcore.main` is the one that fits: this app brings its own two languages
 * (GLSL and JSON, both registered below as Monarch tokenizers, which run on the
 * main thread) and wants the full editing experience for them.
 *
 * Monaco's *stylesheet* is loaded globally, via `angular.json`. The CSS its ESM
 * modules import ends up in a chunk that nothing ever links, which leaves the
 * editor structurally unstyled — bare textarea, no gutter — while the syntax
 * colours, which Monaco injects at runtime, still look right and hide it.
 */

export type MonacoApi = typeof Monaco;

export const GLSL_LANGUAGE_ID = 'glsl';
export const JSON_LANGUAGE_ID = 'json-lite';

export const THEME_IDS: Record<ColorScheme, string> = {
  dark: 'shader-studio-dark',
  light: 'shader-studio-light',
};

let loader: Promise<MonacoApi> | null = null;

export function loadMonaco(): Promise<MonacoApi> {
  loader ??= initialize();
  return loader;
}

async function initialize(): Promise<MonacoApi> {
  // Monaco looks for its worker factory on the global object.
  (globalThis as { MonacoEnvironment?: Monaco.Environment }).MonacoEnvironment = {
    getWorker: () =>
      new Worker(new URL('./monaco.worker', import.meta.url), {
        type: 'module',
        name: 'monaco-editor-worker',
      }),
  };

  // edcore.main ships no type declarations of its own; it re-exports exactly
  // the API that editor.api declares, which is what MonacoApi refers to.
  const monaco = (await import(
    'monaco-editor/esm/vs/editor/edcore.main.js'
  )) as unknown as MonacoApi;

  registerGlsl(monaco);
  registerJson(monaco);
  registerThemes(monaco);

  return monaco;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const GLSL_KEYWORDS = [
  'attribute', 'const', 'uniform', 'varying', 'break', 'continue', 'do', 'for', 'while',
  'if', 'else', 'in', 'out', 'inout', 'return', 'discard', 'struct', 'switch', 'case',
  'default', 'precision', 'highp', 'mediump', 'lowp', 'invariant', 'layout', 'flat',
  'smooth', 'centroid', 'sampler2D', 'samplerCube',
];

const GLSL_TYPES = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4', 'bvec2', 'bvec3', 'bvec4',
  'uvec2', 'uvec3', 'uvec4', 'mat2', 'mat3', 'mat4',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
];

const GLSL_BUILTINS = [
  'abs', 'acos', 'all', 'any', 'asin', 'atan', 'ceil', 'clamp', 'cos', 'cross', 'degrees',
  'dFdx', 'dFdy', 'distance', 'dot', 'equal', 'exp', 'exp2', 'faceforward', 'floor', 'fract',
  'fwidth', 'greaterThan', 'inversesqrt', 'length', 'log', 'log2', 'matrixCompMult', 'max',
  'min', 'mix', 'mod', 'normalize', 'not', 'pow', 'radians', 'reflect', 'refract', 'sign',
  'sin', 'smoothstep', 'sqrt', 'step', 'tan', 'texture2D', 'textureCube', 'transpose',
  'inverse', 'round', 'trunc', 'texture',
];

/** Identifiers the engine or WebGL provides; highlighted so typos stand out. */
const GLSL_PREDEFINED = [
  'gl_FragColor', 'gl_FragCoord', 'gl_Position', 'gl_PointSize', 'gl_PointCoord',
  'gl_FrontFacing', 'gl_FragDepth', 'position', 'uv', 'normal',
  'projectionMatrix', 'modelViewMatrix', 'modelMatrix', 'viewMatrix', 'normalMatrix',
  'cameraPosition',
  'iTime', 'iResolution', 'iMouse', 'iMouseVel', 'u_clickData',
];

function registerGlsl(monaco: MonacoApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === GLSL_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: GLSL_LANGUAGE_ID, extensions: ['.glsl', '.frag', '.vert'] });

  monaco.languages.setLanguageConfiguration(GLSL_LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
  });

  registerGlslCompletions(monaco);

  monaco.languages.setMonarchTokensProvider(GLSL_LANGUAGE_ID, {
    defaultToken: '',
    keywords: GLSL_KEYWORDS,
    types: GLSL_TYPES,
    builtins: GLSL_BUILTINS,
    predefined: GLSL_PREDEFINED,

    tokenizer: {
      root: [
        [/^\s*#\s*\w+/, 'keyword.directive'],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@types': 'type',
              '@builtins': 'predefined',
              '@predefined': 'variable.predefined',
              '@default': 'identifier',
            },
          },
        ],
        { include: '@whitespace' },
        [/\d*\.\d+(?:[eE][-+]?\d+)?[fF]?/, 'number.float'],
        [/\d+[fFuU]?/, 'number'],
        [/[{}()[\]]/, '@brackets'],
        [/[<>=!+\-*/%&|^~?:]+/, 'operator'],
        [/[;,.]/, 'delimiter'],
      ],

      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
    },
  });
}

/**
 * Completions for GLSL.
 *
 * Monaco's built-in word-based suggestions only offer words already in the
 * file, which is useless for the things you actually need to recall: the
 * engine's built-in uniforms and the GLSL standard library.
 */
function registerGlslCompletions(monaco: MonacoApi): void {
  const documented: Record<string, string> = {
    iTime: 'float — seconds since the shader started, pausable',
    iResolution: 'vec2 — drawing-buffer size in pixels',
    iMouse: 'vec4 — xy: pointer in pixels, z: 1 while pressed',
    iMouseVel: 'vec2 — pointer velocity, pixels per second',
    u_clickData: 'vec3[] — per click: xy in pixels, z: birth time (<= 0 unused)',
  };

  monaco.languages.registerCompletionItemProvider(GLSL_LANGUAGE_ID, {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const item = (
        label: string,
        kind: Monaco.languages.CompletionItemKind,
        detail?: string,
      ): Monaco.languages.CompletionItem => ({
        label,
        kind,
        insertText: label,
        range,
        ...(detail ? { detail } : {}),
      });

      const { CompletionItemKind } = monaco.languages;

      return {
        suggestions: [
          ...Object.entries(documented).map(([name, detail]) =>
            item(name, CompletionItemKind.Variable, detail),
          ),
          ...GLSL_BUILTINS.map((name) => item(name, CompletionItemKind.Function)),
          ...GLSL_TYPES.map((name) => item(name, CompletionItemKind.TypeParameter)),
          ...GLSL_KEYWORDS.map((name) => item(name, CompletionItemKind.Keyword)),
        ],
      };
    },
  });
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Highlighting only. Validation of the config comes from `shared/validate`,
 * which knows what a *control schema* is — far more useful than a generic
 * "unexpected token" — and is the same code the API will run.
 */
function registerJson(monaco: MonacoApi): void {
  if (monaco.languages.getLanguages().some((language) => language.id === JSON_LANGUAGE_ID)) {
    return;
  }

  monaco.languages.register({ id: JSON_LANGUAGE_ID, extensions: ['.json'] });

  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });

  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    defaultToken: '',
    tokenizer: {
      root: [
        [/"(?:[^"\\]|\\.)*"\s*(?=:)/, 'type'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[:,]/, 'delimiter'],
        [/\s+/, ''],
      ],
    },
  });
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/**
 * One theme per colour mode, each tuned to sit on the app's own surfaces without
 * fighting the shader behind it. Monaco's theme is a global setting rather than
 * a per-editor one, so the panel switches all three editors with a single call.
 */
function registerThemes(monaco: MonacoApi): void {
  monaco.editor.defineTheme(THEME_IDS.dark, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7a8d', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'keyword.directive', foreground: 'f78c6c' },
      { token: 'type', foreground: '82aaff' },
      { token: 'predefined', foreground: '89ddff' },
      { token: 'variable.predefined', foreground: 'ffcb6b' },
      { token: 'number', foreground: 'f5c078' },
      { token: 'number.float', foreground: 'f5c078' },
      { token: 'string', foreground: 'c3e88d' },
      { token: 'operator', foreground: '89ddff' },
    ],
    colors: {
      'editor.background': '#10141c',
      'editor.lineHighlightBackground': '#1a2130',
      'editorLineNumber.foreground': '#3c4759',
      'editorGutter.background': '#10141c',
    },
  });

  // The same hues, darkened until they carry their weight against white.
  monaco.editor.defineTheme(THEME_IDS.light, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7c8798', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8a3fb8' },
      { token: 'keyword.directive', foreground: 'bf4e18' },
      { token: 'type', foreground: '2758c8' },
      { token: 'predefined', foreground: '0b7285' },
      { token: 'variable.predefined', foreground: '96631a' },
      { token: 'number', foreground: 'a15c12' },
      { token: 'number.float', foreground: 'a15c12' },
      { token: 'string', foreground: '3a7d34' },
      { token: 'operator', foreground: '0b7285' },
    ],
    colors: {
      'editor.background': '#fbfcfe',
      'editor.lineHighlightBackground': '#eef2f8',
      'editorLineNumber.foreground': '#a5b0c0',
      'editorGutter.background': '#fbfcfe',
    },
  });
}
