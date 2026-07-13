/**
 * The editor's *appearance* (what it looks like) and its *window* (where it
 * sits), plus the sanitizers that stand between them and the outside world.
 *
 * Deliberately free of Angular and of Monaco. Two reasons:
 *
 *  - `Preferences` has to import this to sanitize what it reads back out of
 *    `localStorage`, and `Preferences` is what the editor services build on.
 *    Keeping the model down here is what stops that becoming a cycle.
 *  - Everything below is a pure function of untrusted input. `localStorage` is
 *    user-writable, survives across versions of this app, and is the one place
 *    a stale or hand-edited value can reach the editor. Nothing is trusted: a
 *    string where a number belongs, a font family carrying a `}` into a CSS
 *    declaration, a floating window remembered at coordinates that no longer
 *    exist — each falls back to a default rather than reaching Monaco.
 *
 * The rectangle, and the rules for pulling an untrusted number into a range,
 * are in `geometry` — the preview window sanitizes its own state the same way,
 * and that much is genuinely common. Nothing else is.
 */

import {
  clamp,
  containRect,
  finite,
  flag,
  numberIn,
  oneOf,
  type Rect,
  type Size,
} from './geometry';

export type { Rect, Size } from './geometry';

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

/**
 * Where the editor is.
 *
 *  - `docked`     an IDE-style panel along one edge of the workspace.
 *  - `floating`   a draggable window over the shader.
 *  - `maximized`  filling the workspace.
 *  - `minimized`  collapsed to its toolbar, so the shader is unobstructed.
 */
export type EditorMode = 'docked' | 'floating' | 'maximized' | 'minimized';

/**
 * Which edge a docked editor sits on. Bottom is the classic IDE strip; left and
 * right put the panel beside the preview instead of under it.
 */
export type EditorDockSide = 'bottom' | 'left' | 'right';

export const EDITOR_DOCK_SIDES: readonly EditorDockSide[] = ['bottom', 'left', 'right'];

/**
 * The modes the editor can be restored *to*. Maximizing and minimizing are
 * departures you come back from; docked and floating are places you live.
 */
export type EditorRestoreMode = 'docked' | 'floating';

export interface EditorWindowState {
  mode: EditorMode;
  /** Where `restore()` goes. Preserved across maximize and minimize. */
  restoreMode: EditorRestoreMode;
  /** Which edge the docked panel occupies. */
  dockSide: EditorDockSide;
  /** Height of the bottom-docked panel, in pixels. */
  dockedHeight: number;
  /** Width of a left- or right-docked panel, in pixels. */
  dockedWidth: number;
  /** The floating window's rect, relative to the workspace, in pixels. */
  floating: Rect;
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export type WordWrapMode = 'off' | 'on' | 'bounded';
export type CursorBlinking = 'blink' | 'smooth' | 'solid';

/**
 * `auto` tracks the application's own light/dark setting, which is what most
 * people want and what makes the editor read as part of the app rather than an
 * iframe someone dropped into it. The rest pin the editor to one scheme.
 */
export type EditorThemeId =
  | 'auto'
  | 'studio-dark'
  | 'studio-light'
  | 'midnight'
  | 'parchment'
  | 'contrast-dark'
  | 'contrast-light';

export const EDITOR_THEME_IDS: readonly EditorThemeId[] = [
  'auto',
  'studio-dark',
  'studio-light',
  'midnight',
  'parchment',
  'contrast-dark',
  'contrast-light',
];

export interface EditorAppearance {
  fontFamily: string;
  fontSize: number;
  /** A multiplier on the font size, which is how Monaco reads values under 8. */
  lineHeight: number;
  fontWeight: number;
  ligatures: boolean;
  tabSize: number;
  wordWrap: WordWrapMode;
  minimap: boolean;
  lineNumbers: boolean;
  bracketPairs: boolean;
  renderWhitespace: boolean;
  stickyScroll: boolean;
  cursorBlinking: CursorBlinking;
  theme: EditorThemeId;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const EDITOR_LIMITS = {
  fontSize: { min: 9, max: 32 },
  /** Below ~1 the lines collide; above ~2.4 you are reading a poem. */
  lineHeight: { min: 1, max: 2.4 },
  fontWeight: { min: 300, max: 700 },
  tabSize: { min: 1, max: 8 },
  dockedHeight: { min: 180, max: 4000 },
  dockedWidth: { min: 280, max: 4000 },
  floatingWidth: { min: 360, max: 6000 },
  floatingHeight: { min: 200, max: 6000 },
} as const;

/**
 * A CSS font family we are willing to interpolate into a Monaco option, and
 * from there into a `font-family` declaration. Letters, digits, spaces and the
 * two joining characters — nothing that could close a quote or a rule.
 */
const FONT_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/;

/**
 * What the chosen family falls back to. Ordered so that a machine which cannot
 * reach Google Fonts still lands on something monospaced and readable.
 */
export const FONT_FALLBACKS = `'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, 'Courier New', monospace`;

export const DEFAULT_EDITOR_APPEARANCE: EditorAppearance = {
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
  lineHeight: 1.5,
  fontWeight: 400,
  ligatures: true,
  tabSize: 2,
  wordWrap: 'off',
  minimap: false,
  lineNumbers: true,
  bracketPairs: true,
  renderWhitespace: false,
  stickyScroll: false,
  cursorBlinking: 'blink',
  theme: 'auto',
};

export const DEFAULT_EDITOR_WINDOW: EditorWindowState = {
  mode: 'docked',
  restoreMode: 'docked',
  dockSide: 'bottom',
  dockedHeight: 340,
  dockedWidth: 480,
  // Offset from the corner rather than centred: the parameter rail lives on the
  // right, and a floating editor that opens on top of it hides the very knobs
  // you would be turning while you edit.
  floating: { x: 48, y: 48, width: 760, height: 460 },
};

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------

/**
 * Font weights are a hundreds scale; a value of 437 is not a weight, it is a
 * typo. Snap to the nearest step rather than rejecting, so a font that only
 * offers 400 and 700 can still nudge a stored 500 into range.
 */
function fontWeight(value: unknown): number {
  const parsed = finite(value);
  if (parsed === null) return DEFAULT_EDITOR_APPEARANCE.fontWeight;

  const { min, max } = EDITOR_LIMITS.fontWeight;
  return clamp(Math.round(parsed / 100) * 100, min, max);
}

export function isValidFontFamily(value: unknown): value is string {
  return typeof value === 'string' && FONT_FAMILY_PATTERN.test(value);
}

/** The `font-family` value for a chosen family: the family, then the fallbacks. */
export function fontFamilyStack(family: string): string {
  if (!isValidFontFamily(family)) return FONT_FALLBACKS;
  return `'${family}', ${FONT_FALLBACKS}`;
}

export function sanitizeAppearance(value: unknown): EditorAppearance {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const defaults = DEFAULT_EDITOR_APPEARANCE;
  const limits = EDITOR_LIMITS;

  return {
    fontFamily: isValidFontFamily(input['fontFamily']) ? input['fontFamily'] : defaults.fontFamily,
    fontSize: Math.round(
      numberIn(input['fontSize'], defaults.fontSize, limits.fontSize.min, limits.fontSize.max),
    ),
    // Rounded to the slider's own step, so a value read back from storage lands
    // exactly on a tick instead of a hair beside it.
    lineHeight:
      Math.round(
        numberIn(
          input['lineHeight'],
          defaults.lineHeight,
          limits.lineHeight.min,
          limits.lineHeight.max,
        ) * 20,
      ) / 20,
    fontWeight: fontWeight(input['fontWeight']),
    ligatures: flag(input['ligatures'], defaults.ligatures),
    tabSize: Math.round(
      numberIn(input['tabSize'], defaults.tabSize, limits.tabSize.min, limits.tabSize.max),
    ),
    wordWrap: oneOf(input['wordWrap'], ['off', 'on', 'bounded'] as const, defaults.wordWrap),
    minimap: flag(input['minimap'], defaults.minimap),
    lineNumbers: flag(input['lineNumbers'], defaults.lineNumbers),
    bracketPairs: flag(input['bracketPairs'], defaults.bracketPairs),
    renderWhitespace: flag(input['renderWhitespace'], defaults.renderWhitespace),
    stickyScroll: flag(input['stickyScroll'], defaults.stickyScroll),
    cursorBlinking: oneOf(
      input['cursorBlinking'],
      ['blink', 'smooth', 'solid'] as const,
      defaults.cursorBlinking,
    ),
    theme: oneOf(input['theme'], EDITOR_THEME_IDS, defaults.theme),
  };
}

export function sanitizeWindowState(value: unknown): EditorWindowState {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const defaults = DEFAULT_EDITOR_WINDOW;
  const limits = EDITOR_LIMITS;

  const floating = (
    typeof input['floating'] === 'object' && input['floating'] !== null ? input['floating'] : {}
  ) as Record<string, unknown>;

  return {
    mode: oneOf(
      input['mode'],
      ['docked', 'floating', 'maximized', 'minimized'] as const,
      defaults.mode,
    ),
    restoreMode: oneOf(input['restoreMode'], ['docked', 'floating'] as const, defaults.restoreMode),
    dockSide: oneOf(input['dockSide'], EDITOR_DOCK_SIDES, defaults.dockSide),
    dockedHeight: Math.round(
      numberIn(
        input['dockedHeight'],
        defaults.dockedHeight,
        limits.dockedHeight.min,
        limits.dockedHeight.max,
      ),
    ),
    dockedWidth: Math.round(
      numberIn(
        input['dockedWidth'],
        defaults.dockedWidth,
        limits.dockedWidth.min,
        limits.dockedWidth.max,
      ),
    ),
    floating: {
      // Position is not clamped here: it is only meaningful against a viewport,
      // which storage knows nothing about. `clampToViewport` does that, every
      // time the workspace is measured.
      x: Math.round(
        numberIn(
          floating['x'],
          defaults.floating.x,
          -limits.floatingWidth.max,
          limits.floatingWidth.max,
        ),
      ),
      y: Math.round(
        numberIn(
          floating['y'],
          defaults.floating.y,
          -limits.floatingHeight.max,
          limits.floatingHeight.max,
        ),
      ),
      width: Math.round(
        numberIn(
          floating['width'],
          defaults.floating.width,
          limits.floatingWidth.min,
          limits.floatingWidth.max,
        ),
      ),
      height: Math.round(
        numberIn(
          floating['height'],
          defaults.floating.height,
          limits.floatingHeight.min,
          limits.floatingHeight.max,
        ),
      ),
    },
  };
}

/** The smallest a floating editor is allowed to be pulled. */
export const EDITOR_MIN_FLOATING: Size = {
  width: EDITOR_LIMITS.floatingWidth.min,
  height: EDITOR_LIMITS.floatingHeight.min,
};

/**
 * Bring a floating rect back inside the workspace.
 *
 * Called on every resize of the workspace and on every read of the persisted
 * position, which is what recovers a window left at coordinates that made sense
 * on yesterday's monitor.
 */
export function clampToViewport(rect: Rect, viewport: Size): Rect {
  return containRect(rect, viewport, EDITOR_MIN_FLOATING);
}
