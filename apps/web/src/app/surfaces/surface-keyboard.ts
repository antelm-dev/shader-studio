/**
 * Keyboard resize helpers for floating eight-edge grips and docked free-edge
 * separators. Pure — no DOM; callers preventDefault and commit.
 */

import {
  arrowKeyDelta,
  resizeRect,
  type Rect,
  type ResizeEdge,
  type Size,
} from '@shader-studio/shared/geometry';
import {
  SURFACE_MIN_SIZES,
  clampDockSize,
  clampFloatingRect,
  type DockSide,
  type SurfaceKind,
} from '@shader-studio/shared/surfaces';

export interface KeyboardResizeResult {
  readonly rect?: Rect;
  readonly dockSize?: number;
}

/**
 * Apply an arrow-key nudge to a floating rect from the focused edge.
 * Returns null when the event is not a resize key.
 */
export function keyboardResizeFloating(
  kind: SurfaceKind,
  rect: Rect,
  edge: ResizeEdge,
  event: { readonly key: string; readonly shiftKey: boolean },
  viewport?: Size,
): Rect | null {
  const delta = arrowKeyDelta(event);
  if (!delta) return null;
  const [dx, dy] = delta;
  const min = SURFACE_MIN_SIZES[kind].floating;
  return clampFloatingRect(kind, resizeRect(rect, edge, dx, dy, min), viewport);
}

/**
 * Docked free-edge keyboard resize. Bottom grows with ArrowUp; left with
 * ArrowRight; right with ArrowLeft; top with ArrowDown.
 */
export function keyboardResizeDocked(
  kind: SurfaceKind,
  side: DockSide,
  size: number,
  event: { readonly key: string; readonly shiftKey: boolean },
  viewport?: Size,
): number | null {
  const delta = arrowKeyDelta(event);
  if (!delta) return null;
  const [dx, dy] = delta;

  let next = size;
  if (side === 'bottom') next = size - dy;
  else if (side === 'top') next = size + dy;
  else if (side === 'left') next = size + dx;
  else next = size - dx;

  const clamped = clampDockSize(kind, next);
  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const maxSpan =
      side === 'bottom' || side === 'top' ? viewport.height * 0.75 : viewport.width * 0.75;
    const limits = SURFACE_MIN_SIZES[kind].dock;
    const floor = limits.min > 0 ? limits.min : 120;
    return Math.round(Math.min(Math.max(clamped, floor), maxSpan));
  }
  return clamped;
}

/** Aria orientation for a dock free-edge separator. */
export function dockSeparatorOrientation(side: DockSide): 'horizontal' | 'vertical' {
  return side === 'bottom' || side === 'top' ? 'horizontal' : 'vertical';
}

/** Which ResizeEdge the docked free-edge separator exposes. */
export function dockResizeEdge(side: DockSide): ResizeEdge {
  if (side === 'bottom') return 'n';
  if (side === 'top') return 's';
  if (side === 'left') return 'e';
  return 'w';
}

export function floatingEdgeAriaOrientation(edge: ResizeEdge): 'horizontal' | 'vertical' {
  return edge === 'n' || edge === 's' ? 'horizontal' : 'vertical';
}
