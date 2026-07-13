/**
 * Where the shader preview sits, and the sanitizers that stand between that and
 * `localStorage`.
 *
 * The editor has a window model; this is the preview's, and it is deliberately
 * the smaller one. The preview does not dock, does not have tabs, and cannot be
 * closed — it is the thing the whole app exists to show, so the only questions it
 * has to answer are "is it the background, or is it a window?" and, if it is a
 * window, "where?".
 *
 * Free of Angular, and a pure function of untrusted input: `Preferences` calls
 * into here to sanitize what it reads back out of storage, and a rect remembered
 * against a monitor that no longer exists has to be recovered rather than
 * rendered. See `geometry`, which the editor sanitizes through as well.
 */

import {
  clamp,
  containPoint,
  containRect,
  numberIn,
  oneOf,
  type Point,
  type Rect,
  type Size,
} from './geometry';

/**
 * Where the preview is.
 *
 *  - `stage`      the full workspace background, which is where it starts and
 *                 what the app looks like when nothing is in the way.
 *  - `floating`   a movable, resizable window over the workspace.
 *  - `maximized`  filling the workspace.
 *  - `minimized`  collapsed to its title bar, so the stage behind it is clear.
 */
export type PreviewMode = 'stage' | 'floating' | 'maximized' | 'minimized';

export const PREVIEW_MODES: readonly PreviewMode[] = [
  'stage',
  'floating',
  'maximized',
  'minimized',
];

/**
 * The modes the preview can be restored *to*. Maximizing and minimizing are
 * departures you come back from; the stage and a floating window are places you
 * live.
 */
export type PreviewRestoreMode = 'stage' | 'floating';

export const PREVIEW_RESTORE_MODES: readonly PreviewRestoreMode[] = ['stage', 'floating'];

export interface PreviewWindowState {
  mode: PreviewMode;
  /** Where `restore()` goes. Preserved across maximize and minimize. */
  restoreMode: PreviewRestoreMode;
  /** The floating window's rect, relative to the workspace, in pixels. */
  floating: Rect;
  /** The collapsed title bar's corner, relative to the workspace, in pixels. */
  minimized: Point;
}

export const PREVIEW_LIMITS = {
  floatingWidth: { min: 240, max: 6000 },
  floatingHeight: { min: 180, max: 6000 },
} as const;

/**
 * The title bar's height, and the width it keeps when it is all that is left.
 *
 * The height matches the editor toolbar's `min-height`, which is what makes the
 * two windows read as members of the same interface rather than as two designs
 * that happen to be open at once. Both are mirrored in `preview-shell`'s styles;
 * they are here because the *clamping* needs them — a collapsed bar has to be
 * held inside the workspace by its real size, not by a guess.
 */
export const PREVIEW_TITLE_BAR_HEIGHT = 34;
export const PREVIEW_MINIMIZED_WIDTH = 232;

/** The smallest a floating preview is allowed to be pulled. */
export const PREVIEW_MIN_FLOATING: Size = {
  width: PREVIEW_LIMITS.floatingWidth.min,
  height: PREVIEW_LIMITS.floatingHeight.min,
};

/** The footprint of the collapsed title bar, which is the only size it has. */
export const PREVIEW_MINIMIZED_SIZE: Size = {
  width: PREVIEW_MINIMIZED_WIDTH,
  height: PREVIEW_TITLE_BAR_HEIGHT,
};

export const DEFAULT_PREVIEW_WINDOW: PreviewWindowState = {
  // The shader is the page. Everything else is something you asked for.
  mode: 'stage',
  restoreMode: 'floating',
  floating: { x: 48, y: 48, width: 720, height: 480 },
  minimized: { x: 24, y: 24 },
};

/**
 * The rect "Reset window" goes back to: two thirds of the workspace, centred.
 *
 * Centred rather than offset from a corner, which is where the editor's default
 * floating window goes. The two are answering different questions: a floating
 * editor is a tool you put *beside* your work, so it keeps out of the way of the
 * parameter rail; a floating preview *is* the work, so it belongs in the middle
 * of the space it has.
 */
export function defaultFloatingRect(viewport: Size): Rect {
  if (viewport.width <= 0 || viewport.height <= 0) return DEFAULT_PREVIEW_WINDOW.floating;

  const width = clamp(
    Math.round(viewport.width * 0.66),
    Math.min(PREVIEW_MIN_FLOATING.width, viewport.width),
    viewport.width,
  );
  const height = clamp(
    Math.round(viewport.height * 0.66),
    Math.min(PREVIEW_MIN_FLOATING.height, viewport.height),
    viewport.height,
  );

  return clampPreviewRect(
    {
      x: Math.round((viewport.width - width) / 2),
      y: Math.round((viewport.height - height) / 2),
      width,
      height,
    },
    viewport,
  );
}

/** Bring a floating preview fully back inside the workspace. */
export function clampPreviewRect(rect: Rect, viewport: Size): Rect {
  return containRect(rect, viewport, PREVIEW_MIN_FLOATING);
}

/** The same, for the collapsed bar, whose size is not negotiable. */
export function clampMinimizedPoint(point: Point, viewport: Size): Point {
  return containPoint(point, viewport, PREVIEW_MINIMIZED_SIZE);
}

export function sanitizePreviewWindow(value: unknown): PreviewWindowState {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const defaults = DEFAULT_PREVIEW_WINDOW;
  const limits = PREVIEW_LIMITS;

  const floating = (
    typeof input['floating'] === 'object' && input['floating'] !== null ? input['floating'] : {}
  ) as Record<string, unknown>;

  const minimized = (
    typeof input['minimized'] === 'object' && input['minimized'] !== null ? input['minimized'] : {}
  ) as Record<string, unknown>;

  return {
    mode: oneOf(input['mode'], PREVIEW_MODES, defaults.mode),
    restoreMode: oneOf(input['restoreMode'], PREVIEW_RESTORE_MODES, defaults.restoreMode),
    floating: {
      // Positions are not clamped here: they are only meaningful against a
      // workspace, which storage knows nothing about. `clampPreviewRect` does
      // that, every time the stage is measured.
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
    minimized: {
      x: Math.round(
        numberIn(
          minimized['x'],
          defaults.minimized.x,
          -limits.floatingWidth.max,
          limits.floatingWidth.max,
        ),
      ),
      y: Math.round(
        numberIn(
          minimized['y'],
          defaults.minimized.y,
          -limits.floatingHeight.max,
          limits.floatingHeight.max,
        ),
      ),
    },
  };
}
