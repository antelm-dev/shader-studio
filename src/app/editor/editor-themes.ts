import type { ResolvedColorScheme } from '../core/preferences';
import type { EditorThemeId } from '../core/editor-prefs';

/**
 * The editor's colour schemes.
 *
 * Held as plain data rather than as Monaco theme objects so that two very
 * different consumers can share one definition: `monaco-loader`, which turns
 * each into a real Monaco theme, and the settings dialog, which paints a swatch
 * from the same colours. A theme that previews as one thing and renders as
 * another is a bug waiting to be filed.
 *
 * Every palette highlights the same ten token types, which are the ones this
 * app's GLSL and JSON tokenizers actually emit — see `monaco-loader`.
 */

export type ThemeBase = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

/** A theme actually registered with Monaco: everything except `auto`. */
export type ConcreteThemeId = Exclude<EditorThemeId, 'auto'>;

export interface EditorThemePalette {
  base: ThemeBase;
  background: string;
  foreground: string;
  lineHighlight: string;
  lineNumber: string;
  tokens: {
    comment: string;
    keyword: string;
    directive: string;
    type: string;
    predefined: string;
    variable: string;
    number: string;
    string: string;
    operator: string;
  };
}

export interface EditorThemeChoice {
  id: ConcreteThemeId;
  label: string;
  description: string;
  dark: boolean;
  /** Meets WCAG AAA against its own background, and says so in the picker. */
  highContrast: boolean;
  palette: EditorThemePalette;
}

export const EDITOR_THEMES: readonly EditorThemeChoice[] = [
  {
    id: 'studio-dark',
    label: 'Studio Dark',
    description: 'The house theme. Cool and quiet behind a lit shader.',
    dark: true,
    highContrast: false,
    palette: {
      base: 'vs-dark',
      background: '#10141c',
      foreground: '#d6deeb',
      lineHighlight: '#1a2130',
      lineNumber: '#3c4759',
      tokens: {
        comment: '#6b7a8d',
        keyword: '#c792ea',
        directive: '#f78c6c',
        type: '#82aaff',
        predefined: '#89ddff',
        variable: '#ffcb6b',
        number: '#f5c078',
        string: '#c3e88d',
        operator: '#89ddff',
      },
    },
  },
  {
    id: 'studio-light',
    label: 'Studio Light',
    description: 'The same hues, darkened until they carry against white.',
    dark: false,
    highContrast: false,
    palette: {
      base: 'vs',
      background: '#fbfcfe',
      foreground: '#2b3445',
      lineHighlight: '#eef2f8',
      lineNumber: '#a5b0c0',
      tokens: {
        comment: '#7c8798',
        keyword: '#8a3fb8',
        directive: '#bf4e18',
        type: '#2758c8',
        predefined: '#0b7285',
        variable: '#96631a',
        number: '#a15c12',
        string: '#3a7d34',
        operator: '#0b7285',
      },
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    description: 'Violet and near-black. Made for a dark room.',
    dark: true,
    highContrast: false,
    palette: {
      base: 'vs-dark',
      background: '#0b0a14',
      foreground: '#e6e3f1',
      lineHighlight: '#181528',
      lineNumber: '#4a4370',
      tokens: {
        comment: '#6c6a94',
        keyword: '#ff79c6',
        directive: '#ffb86c',
        type: '#8be9fd',
        predefined: '#50fa7b',
        variable: '#f1fa8c',
        number: '#bd93f9',
        string: '#f1fa8c',
        operator: '#ff92d0',
      },
    },
  },
  {
    id: 'parchment',
    label: 'Parchment',
    description: 'Warm paper and ink, for reading rather than watching.',
    dark: false,
    highContrast: false,
    palette: {
      base: 'vs',
      background: '#fdf6e3',
      foreground: '#3b4a51',
      lineHighlight: '#eee8d5',
      lineNumber: '#a3a08c',
      tokens: {
        comment: '#8a8677',
        keyword: '#7a6b00',
        directive: '#c4471a',
        type: '#1e6fb8',
        predefined: '#1f7c74',
        variable: '#96631a',
        number: '#bd2f7a',
        string: '#1f7c74',
        operator: '#7a6b00',
      },
    },
  },
  {
    id: 'contrast-dark',
    label: 'High Contrast Dark',
    description: 'Pure black, saturated tokens, visible focus.',
    dark: true,
    highContrast: true,
    palette: {
      base: 'hc-black',
      background: '#000000',
      foreground: '#ffffff',
      lineHighlight: '#1f1f1f',
      lineNumber: '#c8c8c8',
      tokens: {
        comment: '#8fe98f',
        keyword: '#ff9df0',
        directive: '#ffb454',
        type: '#79d0ff',
        predefined: '#5ff0e0',
        variable: '#ffe066',
        number: '#ffd479',
        string: '#b8f77e',
        operator: '#ffffff',
      },
    },
  },
  {
    id: 'contrast-light',
    label: 'High Contrast Light',
    description: 'Pure white and deep ink, for bright rooms and glare.',
    dark: false,
    highContrast: true,
    palette: {
      base: 'hc-light',
      background: '#ffffff',
      foreground: '#000000',
      lineHighlight: '#e6e6e6',
      lineNumber: '#3b3b3b',
      tokens: {
        comment: '#3d6b3d',
        keyword: '#8f0075',
        directive: '#a63200',
        type: '#003ea3',
        predefined: '#005f60',
        variable: '#6b4a00',
        number: '#8a3b00',
        string: '#1f5c1f',
        operator: '#1a1a1a',
      },
    },
  },
];

/**
 * `auto` is not a theme, it is a promise to follow the app — which is what keeps
 * the editor feeling like part of the studio rather than a window onto another
 * one. Everything else is taken literally, including a light editor on a dark
 * app, because someone will want exactly that.
 */
export function resolveThemeId(theme: EditorThemeId, scheme: ResolvedColorScheme): ConcreteThemeId {
  if (theme !== 'auto') return theme;
  return scheme === 'light' ? 'studio-light' : 'studio-dark';
}

export function findTheme(id: ConcreteThemeId): EditorThemeChoice {
  return EDITOR_THEMES.find((theme) => theme.id === id) ?? EDITOR_THEMES[0];
}

/** Monaco's theme registry is global and string-keyed; this is our namespace in it. */
export function monacoThemeId(id: ConcreteThemeId): string {
  return `shader-studio-${id}`;
}
