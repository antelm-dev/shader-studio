/**
 * Viewport-aware projection of a surface placement into a frame rectangle.
 *
 * Stored geometry is not rewritten here — clamping is for display / gesture
 * preview only. Persistence commits happen through SurfaceController on gesture
 * end (or explicit transitions).
 *
 * Pure functions: no DOM, no Angular, safe during SSR evaluation.
 */

import {
  containPoint,
  containRect,
  type Point,
  type Rect,
  type Size,
} from '@shader-studio/shared/geometry';
import { DEFAULT_EDITOR_WINDOW } from '@shader-studio/shared/editor-prefs';
import {
  SURFACE_MIN_SIZES,
  clampDockSize,
  clampFloatingRect,
  clampSurfaceMinimizedPoint,
  COMPACT_VIEWPORT_WIDTH,
  effectiveEditorDockSide,
  isNativePlacement,
  type ContainedPlacement,
  type DockSide,
  type SurfaceKind,
  type SurfaceRecord,
} from '@shader-studio/shared/surfaces';

/** Default collapsed chrome size for non-preview surfaces. */
export const SURFACE_MINIMIZED_CHROME: Size = { width: 232, height: 34 };

export interface SurfaceFrameOptions {
  /** Live pointer/keyboard preview rect (floating). */
  readonly liveRect?: Rect | null;
  /** Live minimized corner. */
  readonly livePoint?: Point | null;
  /** Live dock size along the free edge. */
  readonly liveDockSize?: number | null;
  /** Override minimized chrome size (preview uses a wider bar). */
  readonly minimizedSize?: Size;
  /**
   * Workspace origin in client coordinates. When set, frame x/y are absolute;
   * when omitted, frame is workspace-relative (editor-shell style).
   */
  readonly workspaceOrigin?: Point;
}

export interface ProjectedSurfaceFrame {
  /** null when stage — CSS fills the workspace. */
  readonly frame: Rect | null;
  readonly mode: ContainedPlacement['mode'] | 'native' | 'closed';
  readonly dockSide: DockSide | null;
  readonly dockSize: number | null;
  readonly freeEdge: 'n' | 's' | 'e' | 'w' | null;
  readonly stacked: boolean;
  readonly draggable: boolean;
  readonly resizableFloating: boolean;
  readonly resizableDocked: boolean;
}

function minimizedSizeFor(override?: Size): Size {
  return override ?? SURFACE_MINIMIZED_CHROME;
}

function dockFreeEdge(side: DockSide): 'n' | 's' | 'e' | 'w' {
  if (side === 'bottom') return 'n';
  if (side === 'top') return 's';
  if (side === 'left') return 'e';
  return 'w';
}

function withOrigin(rect: Rect, origin?: Point): Rect {
  if (!origin) return rect;
  return { ...rect, x: origin.x + rect.x, y: origin.y + rect.y };
}

/**
 * Clamp a floating rect for display against the current viewport without
 * mutating the stored record.
 */
export function displayFloatingRect(kind: SurfaceKind, rect: Rect, viewport: Size): Rect {
  return clampFloatingRect(kind, rect, viewport);
}

export function displayMinimizedPoint(
  kind: SurfaceKind,
  point: Point,
  viewport: Size,
  size?: Size,
): Point {
  if (size) {
    return containPoint(point, viewport, size);
  }
  return clampSurfaceMinimizedPoint(kind, point, viewport);
}

export function displayDockSize(kind: SurfaceKind, size: number): number {
  return clampDockSize(kind, size);
}

/**
 * Recover off-screen floating geometry for *display*. Does not write storage.
 */
export function recoverContainedBounds(
  kind: SurfaceKind,
  rect: Rect,
  viewport: Size,
  min?: Size,
): Rect {
  const floor = min ?? SURFACE_MIN_SIZES[kind].floating;
  if (viewport.width <= 0 || viewport.height <= 0) return rect;
  return containRect(rect, viewport, floor);
}

/**
 * Project a surface into the frame a host should render.
 *
 * Native placements return mode `'native'` with `frame: null` — Agent 04 owns
 * OS windows; contained hosts should not paint them.
 */
export function projectSurfaceFrame(
  surface: SurfaceRecord,
  viewport: Size,
  options: SurfaceFrameOptions = {},
): ProjectedSurfaceFrame {
  if (!surface.open) {
    return {
      frame: null,
      mode: 'closed',
      dockSide: null,
      dockSize: null,
      freeEdge: null,
      stacked: false,
      draggable: false,
      resizableFloating: false,
      resizableDocked: false,
    };
  }

  if (isNativePlacement(surface.placement)) {
    return {
      frame: null,
      mode: 'native',
      dockSide: null,
      dockSize: null,
      freeEdge: null,
      stacked: false,
      draggable: false,
      resizableFloating: false,
      resizableDocked: false,
    };
  }

  const placement = surface.placement;
  const origin = options.workspaceOrigin;
  const minChrome = minimizedSizeFor(options.minimizedSize);

  switch (placement.mode) {
    case 'stage':
      return {
        frame: null,
        mode: 'stage',
        dockSide: null,
        dockSize: null,
        freeEdge: null,
        stacked: false,
        draggable: false,
        resizableFloating: false,
        resizableDocked: false,
      };
    case 'maximized':
      return {
        frame: withOrigin(
          { x: 0, y: 0, width: Math.max(0, viewport.width), height: Math.max(0, viewport.height) },
          origin,
        ),
        mode: 'maximized',
        dockSide: null,
        dockSize: null,
        freeEdge: null,
        stacked: true,
        draggable: false,
        resizableFloating: false,
        resizableDocked: false,
      };
    case 'minimized': {
      const raw = options.livePoint ?? placement.point ?? { x: 24, y: 24 };
      const point = displayMinimizedPoint(surface.kind, raw, viewport, minChrome);
      return {
        frame: withOrigin({ ...point, ...minChrome }, origin),
        mode: 'minimized',
        dockSide: null,
        dockSize: null,
        freeEdge: null,
        stacked: true,
        draggable: true,
        resizableFloating: false,
        resizableDocked: false,
      };
    }
    case 'floating': {
      if (
        surface.kind === 'editor' &&
        viewport.width > 0 &&
        viewport.width < COMPACT_VIEWPORT_WIDTH
      ) {
        const side = effectiveEditorDockSide('bottom', viewport.width);
        const fallbackSize = displayDockSize(
          surface.kind,
          options.liveDockSize ?? DEFAULT_EDITOR_WINDOW.dockedHeight,
        );
        return {
          frame: null,
          mode: 'docked',
          dockSide: side,
          dockSize: fallbackSize,
          freeEdge: dockFreeEdge(side),
          stacked: false,
          draggable: false,
          resizableFloating: false,
          resizableDocked: true,
        };
      }

      const raw = options.liveRect ?? placement.rect;
      const rect = displayFloatingRect(surface.kind, raw, viewport);
      return {
        frame: withOrigin(rect, origin),
        mode: 'floating',
        dockSide: null,
        dockSize: null,
        freeEdge: null,
        stacked: true,
        draggable: true,
        resizableFloating: true,
        resizableDocked: false,
      };
    }
    case 'docked': {
      const side =
        surface.kind === 'editor'
          ? effectiveEditorDockSide(placement.side, viewport.width)
          : placement.side;
      const size = displayDockSize(surface.kind, options.liveDockSize ?? placement.size);
      return {
        frame: null,
        mode: 'docked',
        dockSide: side,
        dockSize: size,
        freeEdge: dockFreeEdge(side),
        stacked: false,
        draggable: false,
        resizableFloating: false,
        resizableDocked: true,
      };
    }
  }
}

/** Host CSS class list for reduced-motion-safe transitions. */
export function surfaceFrameHostClasses(options: {
  dragging: boolean;
  reducedMotion: boolean;
  mode: ProjectedSurfaceFrame['mode'];
}): Record<string, boolean> {
  return {
    'surface-frame': true,
    'surface-frame--dragging': options.dragging,
    'surface-frame--animating': !options.dragging && !options.reducedMotion,
    [`surface-frame--${options.mode}`]: true,
  };
}
