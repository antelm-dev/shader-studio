/**
 * A `theme` contribution: a named palette for the app's chrome and for the code
 * editor, as plain data. No CSS, selector, URL, font, script or variable name
 * comes from the package — only a closed set of colour *roles*, each an opaque
 * `#RRGGBB`. The host alone decides which CSS token a role paints, so a palette
 * can recolour the studio and nothing else.
 *
 * ```json
 * { "kind": "theme", "id": "amber-dark", "name": "Amber Dark",
 *   "schemaVersion": 1, "scheme": "dark",
 *   "ui": { "background": "#1a1410", ... },
 *   "editor": { "base": "vs-dark", "background": "#1a1410", ..., "tokens": { ... } } }
 * ```
 *
 * `schemaVersion` versions this shape only. A theme adds no Worker call, so it
 * leaves the package `protocolVersion` alone; a host that predates themes
 * refuses the kind outright rather than half-reading it.
 *
 * Also here: the reference a preference stores to point at one contribution,
 * `plugin:<packageId>/<contributionId>`. It names no version, so updating a
 * package keeps the choice; whether the theme still exists is only ever decided
 * against the current catalogue, never assumed from the string.
 */
import { isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import { CONTRIBUTION_ID_PATTERN, PACKAGE_ID_PATTERN } from './ids';

export const THEME_SCHEMA_VERSION = 1;

/** Every theme states its roles for this scheme; the host paints under it. */
export type ThemeScheme = 'light' | 'dark';

/** Roles a theme must define: the surfaces, text and accent every screen uses. */
export const THEME_REQUIRED_UI_ROLES = [
  'background',
  'on-background',
  'surface',
  'on-surface',
  'on-surface-variant',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'outline',
  'outline-variant',
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
] as const;

/** Roles a theme may define; one left out keeps the built-in value for the theme's scheme. */
export const THEME_OPTIONAL_UI_ROLES = [
  'surface-dim',
  'surface-bright',
  'surface-variant',
  'secondary',
  'on-secondary',
  'secondary-container',
  'on-secondary-container',
  'tertiary',
  'on-tertiary',
  'tertiary-container',
  'on-tertiary-container',
  'inverse-surface',
  'inverse-on-surface',
  'inverse-primary',
  'error',
  'on-error',
  'error-container',
  'on-error-container',
] as const;

export type ThemeRequiredUiRole = (typeof THEME_REQUIRED_UI_ROLES)[number];
export type ThemeOptionalUiRole = (typeof THEME_OPTIONAL_UI_ROLES)[number];
export type ThemeUiRole = ThemeRequiredUiRole | ThemeOptionalUiRole;

export const THEME_UI_ROLES: readonly ThemeUiRole[] = [
  ...THEME_REQUIRED_UI_ROLES,
  ...THEME_OPTIONAL_UI_ROLES,
];

export type ThemeUiPalette = Record<ThemeRequiredUiRole, string> &
  Partial<Record<ThemeOptionalUiRole, string>>;

/** The token colours the editor's GLSL and JSON tokenizers emit. */
export const THEME_EDITOR_TOKENS = [
  'comment',
  'keyword',
  'directive',
  'type',
  'predefined',
  'variable',
  'number',
  'string',
  'operator',
] as const;

export type ThemeEditorToken = (typeof THEME_EDITOR_TOKENS)[number];

/** The editor's palette, in the fields the built-in editor themes use. */
export interface ThemeEditorPalette {
  /** Monaco's base, which must agree with the theme's `scheme`. */
  base: 'vs' | 'vs-dark';
  background: string;
  foreground: string;
  lineHighlight: string;
  lineNumber: string;
  tokens: Record<ThemeEditorToken, string>;
}

export interface ThemeContribution {
  kind: 'theme';
  id: string;
  name: string;
  schemaVersion: typeof THEME_SCHEMA_VERSION;
  scheme: ThemeScheme;
  ui: ThemeUiPalette;
  editor: ThemeEditorPalette;
}

const THEME_KEYS = ['kind', 'id', 'name', 'schemaVersion', 'scheme', 'ui', 'editor'];
const EDITOR_KEYS = ['base', 'background', 'foreground', 'lineHighlight', 'lineNumber', 'tokens'];
const EDITOR_COLOURS = ['background', 'foreground', 'lineHighlight', 'lineNumber'] as const;

/** Opaque, six hex digits, nothing else: no names, functions, alpha or `url()`. */
const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isThemeColour(value: unknown): value is string {
  return typeof value === 'string' && COLOUR_PATTERN.test(value);
}

/**
 * Validate the theme-specific fields of a contribution whose `kind`, `id` and
 * `name` the package validator has already checked. Colours come back lowercase.
 */
export function validateThemeFields(
  input: Record<string, unknown>,
  at: string,
  base: { id: string; name: string },
): Result<ThemeContribution> {
  const unknownKey = Object.keys(input).find((key) => !THEME_KEYS.includes(key));
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);

  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== THEME_SCHEMA_VERSION) {
    return fail(
      `${at}.schemaVersion ${String(schemaVersion)} is not supported (this app reads ${THEME_SCHEMA_VERSION})`,
    );
  }
  const scheme = input['scheme'];
  if (scheme !== 'light' && scheme !== 'dark') {
    return fail(`${at}.scheme must be "light" or "dark"`);
  }

  const ui = uiPalette(input['ui'], `${at}.ui`);
  if (!ui.ok) return ui;
  const editor = editorPalette(input['editor'], `${at}.editor`, scheme);
  if (!editor.ok) return editor;

  return ok({
    kind: 'theme',
    ...base,
    schemaVersion: THEME_SCHEMA_VERSION,
    scheme,
    ui: ui.value,
    editor: editor.value,
  });
}

function uiPalette(input: unknown, at: string): Result<ThemeUiPalette> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = Object.keys(input).find(
    (key) => !(THEME_UI_ROLES as readonly string[]).includes(key),
  );
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known colour role`);

  const palette: Partial<Record<ThemeUiRole, string>> = {};
  for (const role of THEME_UI_ROLES) {
    const value = input[role];
    if (value === undefined) {
      if ((THEME_REQUIRED_UI_ROLES as readonly string[]).includes(role)) {
        return fail(`${at}.${role} is required`);
      }
      continue;
    }
    if (!isThemeColour(value)) return fail(`${at}.${role} must be a colour like #1a2b3c`);
    palette[role] = value.toLowerCase();
  }
  return ok(palette as ThemeUiPalette);
}

function editorPalette(
  input: unknown,
  at: string,
  scheme: ThemeScheme,
): Result<ThemeEditorPalette> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = Object.keys(input).find((key) => !EDITOR_KEYS.includes(key));
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);

  const base = input['base'];
  const expected = scheme === 'dark' ? 'vs-dark' : 'vs';
  if (base !== expected) return fail(`${at}.base must be "${expected}" for a ${scheme} theme`);

  const colours: Partial<Record<(typeof EDITOR_COLOURS)[number], string>> = {};
  for (const key of EDITOR_COLOURS) {
    const value = input[key];
    if (!isThemeColour(value)) return fail(`${at}.${key} must be a colour like #1a2b3c`);
    colours[key] = value.toLowerCase();
  }

  const tokensInput = input['tokens'];
  if (!isRecord(tokensInput)) return fail(`${at}.tokens must be an object`);
  const unknownToken = Object.keys(tokensInput).find(
    (key) => !(THEME_EDITOR_TOKENS as readonly string[]).includes(key),
  );
  if (unknownToken) return fail(`${at}.tokens.${unknownToken} is not a known token`);
  const tokens: Partial<Record<ThemeEditorToken, string>> = {};
  for (const token of THEME_EDITOR_TOKENS) {
    const value = tokensInput[token];
    if (!isThemeColour(value)) return fail(`${at}.tokens.${token} must be a colour like #1a2b3c`);
    tokens[token] = value.toLowerCase();
  }

  return ok({
    base: expected,
    ...(colours as Record<(typeof EDITOR_COLOURS)[number], string>),
    tokens: tokens as Record<ThemeEditorToken, string>,
  });
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/** What a preference stores to name one theme contribution of one package. */
export type PluginThemeRef = `plugin:${string}/${string}`;

const REF_PREFIX = 'plugin:';
/** The longest reference the two id patterns allow. */
export const PLUGIN_THEME_REF_MAX_LENGTH = REF_PREFIX.length + 64 + 1 + 48;

export function pluginThemeRef(packageId: string, contributionId: string): PluginThemeRef {
  if (!PACKAGE_ID_PATTERN.test(packageId) || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
    throw new Error(`Not a theme reference: ${packageId}/${contributionId}`);
  }
  return `${REF_PREFIX}${packageId}/${contributionId}`;
}

/**
 * Split a reference into its two ids, or `null` for anything that is not
 * exactly one. Syntax only: a well-formed reference may still name a theme that
 * is not installed.
 */
export function parsePluginThemeRef(
  value: unknown,
): { packageId: string; contributionId: string } | null {
  if (typeof value !== 'string' || value.length > PLUGIN_THEME_REF_MAX_LENGTH) return null;
  if (!value.startsWith(REF_PREFIX)) return null;
  const rest = value.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const packageId = rest.slice(0, slash);
  const contributionId = rest.slice(slash + 1);
  if (!PACKAGE_ID_PATTERN.test(packageId) || !CONTRIBUTION_ID_PATTERN.test(contributionId)) {
    return null;
  }
  return { packageId, contributionId };
}

export function isPluginThemeRef(value: unknown): value is PluginThemeRef {
  return parsePluginThemeRef(value) !== null;
}

// ---------------------------------------------------------------------------
// The app's theme preference
// ---------------------------------------------------------------------------

/**
 * Which palette dresses the app: `builtin` (the studio's own, in the remembered
 * light, dark or system scheme) or one plugin theme, which brings its scheme.
 */
export type AppThemeId = 'builtin' | PluginThemeRef;

export const DEFAULT_APP_THEME_ID: AppThemeId = 'builtin';

/** A stored value, read back: a well-formed reference survives, anything else is `builtin`. */
export function sanitizeAppThemeId(value: unknown): AppThemeId {
  return isPluginThemeRef(value) ? value : DEFAULT_APP_THEME_ID;
}
