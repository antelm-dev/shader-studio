/**
 * The geometry and the sanitizers that the editor's window and the preview's
 * window both need.
 *
 * This is the only thing the two window models share, and it is deliberately the
 * smallest thing they *could* share: a rectangle, a size, and the rules for
 * pulling an untrusted number into a range. Neither window's state is here, and
 * neither knows the other exists — the editor docks, tabs and diagnoses, the
 * preview does none of that, and a common base class for the two would be an
 * abstraction over one accident of resemblance.
 *
 * Everything below is a pure function of untrusted input. `localStorage` is
 * user-writable and outlives any given build, so a string where a number belongs,
 * a NaN, or a window remembered at coordinates that no longer exist all have to
 * fall back rather than reach the DOM.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** A finite number, or `null` for anything else — including `NaN` and strings. */
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = finite(value);
  return parsed === null ? fallback : clamp(parsed, min, max);
}

export function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

/**
 * Bring a rect fully inside a viewport.
 *
 * The rect is shrunk to fit *before* it is moved, so the result is always wholly
 * visible rather than merely reachable — a title bar peeking in from the edge is
 * not a recovered window. `min` is itself capped by the viewport, because a
 * window that cannot be smaller than the space it has to fit in has no solution.
 *
 * A zero-sized viewport means nothing has been measured yet (the server, or the
 * first frame). The rect passes through untouched, to be clamped a moment later
 * once there is something to clamp it against.
 */
export function containRect(rect: Rect, viewport: Size, min: Size): Rect {
  if (viewport.width <= 0 || viewport.height <= 0) return rect;

  const width = clamp(rect.width, Math.min(min.width, viewport.width), viewport.width);
  const height = clamp(rect.height, Math.min(min.height, viewport.height), viewport.height);

  return {
    width: Math.round(width),
    height: Math.round(height),
    x: Math.round(clamp(rect.x, 0, Math.max(0, viewport.width - width))),
    y: Math.round(clamp(rect.y, 0, Math.max(0, viewport.height - height))),
  };
}

/**
 * The same, for something whose size is not negotiable: a collapsed title bar
 * has one width and one height, and only its corner can move.
 */
export function containPoint(point: Point, viewport: Size, size: Size): Point {
  if (viewport.width <= 0 || viewport.height <= 0) return point;

  return {
    x: Math.round(clamp(point.x, 0, Math.max(0, viewport.width - size.width))),
    y: Math.round(clamp(point.y, 0, Math.max(0, viewport.height - size.height))),
  };
}

/** Which edges a resize gesture is pulling. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** All eight, in the order the editor and preview windows both draw their grips. */
export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** How far the arrow keys move or resize a window, and how far with Shift. */
export const RESIZE_NUDGE = 16;
export const RESIZE_NUDGE_FAST = 64;

/**
 * Resize a rect from whichever edges a gesture holds, by the pointer movement
 * (`dx`, `dy`) since the gesture began.
 *
 * The north and west edges move the origin as well as the size, and both are
 * clamped to `min` so that pulling an edge *past* its opposite one stops at
 * the minimum size rather than turning the rect inside out. The result is not
 * itself contained to a viewport — pass it through `containRect` for that.
 */
export function resizeRect(rect: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size): Rect {
  let { x, y, width, height } = rect;

  if (edge.includes('e')) width = rect.width + dx;
  if (edge.includes('s')) height = rect.height + dy;

  if (edge.includes('w')) {
    width = Math.max(min.width, rect.width - dx);
    x = rect.x + (rect.width - width);
  }
  if (edge.includes('n')) {
    height = Math.max(min.height, rect.height - dy);
    y = rect.y + (rect.height - height);
  }

  return { x, y, width, height };
}
