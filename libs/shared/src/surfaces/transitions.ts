/**
 * Legal surface placement transitions. Rejected transitions are typed failures,
 * never silent no-ops for capability violations.
 */

import type { Point, Rect, Size } from '../geometry';
import { capabilitiesFor } from './capabilities';
import {
  clampDockSize,
  clampFloatingRect,
  clampSurfaceMinimizedPoint,
  clampNativeBounds,
  cloneRestorePoint,
  defaultDockSide,
  defaultDockSize,
  defaultFloatingRectFor,
  defaultRestorePoint,
  isContainedPlacement,
  isNativePlacement,
  placementFromRestorePoint,
  restorePointFromPlacement,
  SURFACE_MIN_SIZES,
} from './placement';
import type {
  ContainedPlacement,
  DockSide,
  NativePlacement,
  RestorePoint,
  SurfaceKind,
  SurfaceRecord,
} from './types';

export type TransitionErrorCode =
  | 'capability-denied'
  | 'invalid-argument'
  | 'invalid-placement'
  | 'singleton-exists'
  | 'last-editor-group'
  | 'externalize-unavailable'
  | 'not-native'
  | 'not-contained'
  | 'dock-side-forbidden';

export interface TransitionFailure {
  ok: false;
  code: TransitionErrorCode;
  message: string;
}

export interface TransitionSuccess {
  ok: true;
  surface: SurfaceRecord;
  /**
   * When returning live-preview-output, the contained preview should adopt this
   * placement (thin adapter until Agent 07 unifies the path).
   */
  previewPlacement?: ContainedPlacement;
}

export type TransitionResult = TransitionSuccess | TransitionFailure;

export interface TransitionContext {
  /** Contained workspace size, when known. */
  viewport?: Size;
  /** Native work-area for the target display, when known. */
  workArea?: Size;
  /** Display id for native placement (informational; may be missing later). */
  displayId?: string;
  /** Electron-only externalize gate. Web must pass false/omit. */
  allowNative?: boolean;
  /**
   * Count of editor groups that would remain after this transition.
   * Required for editor close: closing the last group is rejected.
   */
  remainingEditorGroups?: number;
  /** Existing open surfaces of the same kind (singleton checks). */
  openSiblings?: readonly SurfaceRecord[];
}

function deny(code: TransitionErrorCode, message: string): TransitionFailure {
  return { ok: false, code, message };
}

function succeed(
  surface: SurfaceRecord,
  extra?: Pick<TransitionSuccess, 'previewPlacement'>,
): TransitionSuccess {
  return { ok: true, surface, ...extra };
}

function requireCapability(
  kind: SurfaceKind,
  capability: 'stage' | 'dock' | 'float' | 'maximize' | 'minimize' | 'externalize' | 'return' | 'close',
): TransitionFailure | null {
  if (!capabilitiesFor(kind)[capability]) {
    return deny('capability-denied', `${kind} cannot ${capability}`);
  }
  return null;
}

/** Stage — preview only. */
export function showOnStage(surface: SurfaceRecord): TransitionResult {
  const denied = requireCapability(surface.kind, 'stage');
  if (denied) return denied;

  return succeed({
    ...surface,
    open: true,
    placement: { host: 'contained', mode: 'stage' },
  });
}

/** Dock to an allowed edge. */
export function dock(
  surface: SurfaceRecord,
  side?: DockSide,
  size?: number,
  _context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'dock');
  if (denied) return denied;

  const caps = capabilitiesFor(surface.kind);
  const targetSide = side ?? defaultDockSide(surface.kind);
  if (!caps.allowedDockSides.includes(targetSide)) {
    return deny('dock-side-forbidden', `${surface.kind} cannot dock to ${targetSide}`);
  }

  if (isNativePlacement(surface.placement)) {
    return deny('not-contained', `${surface.kind} must return to workspace before docking`);
  }

  const dockSize = clampDockSize(
    surface.kind,
    size ??
      (surface.placement.mode === 'docked' ? surface.placement.size : defaultDockSize(surface.kind)),
  );

  return succeed({
    ...surface,
    open: true,
    placement: { host: 'contained', mode: 'docked', side: targetSide, size: dockSize },
  });
}

/** Float in workspace (contained). Not externalize. */
export function floatSurface(
  surface: SurfaceRecord,
  rect?: Rect,
  context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'float');
  if (denied) return denied;

  if (isNativePlacement(surface.placement)) {
    return deny('not-contained', `${surface.kind} must return to workspace before floating`);
  }

  const nextRect = clampFloatingRect(
    surface.kind,
    rect ??
      (isContainedPlacement(surface.placement) && surface.placement.mode === 'floating'
        ? surface.placement.rect
        : defaultFloatingRectFor(surface.kind, context.viewport)),
    context.viewport,
  );

  return succeed({
    ...surface,
    open: true,
    placement: { host: 'contained', mode: 'floating', rect: nextRect },
  });
}

/**
 * Maximize. Records restore from a durable mode; preserves restore when already
 * transient (maximize ↔ minimize).
 */
export function maximize(surface: SurfaceRecord, context: TransitionContext = {}): TransitionResult {
  const denied = requireCapability(surface.kind, 'maximize');
  if (denied) return denied;

  if (isNativePlacement(surface.placement)) {
    const bounds = clampNativeBounds(
      surface.placement.bounds,
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      open: true,
      placement: { ...surface.placement, bounds, maximized: true, fullscreen: false },
    });
  }

  if (surface.placement.mode === 'maximized') {
    return succeed(surface);
  }

  const restore =
    surface.placement.mode === 'minimized'
      ? cloneRestorePoint(surface.placement.restore)
      : restorePointFromPlacement(surface.placement);

  return succeed({
    ...surface,
    open: true,
    placement: { host: 'contained', mode: 'maximized', restore },
  });
}

/** Minimize. Same restore-point preservation rule as maximize. */
export function minimize(
  surface: SurfaceRecord,
  point?: Point,
  context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'minimize');
  if (denied) return denied;

  if (isNativePlacement(surface.placement)) {
    const bounds = clampNativeBounds(
      surface.placement.bounds,
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      open: true,
      placement: { ...surface.placement, bounds, maximized: false },
    });
  }

  if (surface.placement.mode === 'minimized') {
    const nextPoint =
      point !== undefined
        ? clampSurfaceMinimizedPoint(surface.kind, point, context.viewport)
        : surface.placement.point;
    return succeed({
      ...surface,
      open: true,
      placement: {
        host: 'contained',
        mode: 'minimized',
        restore: cloneRestorePoint(surface.placement.restore),
        ...(nextPoint ? { point: nextPoint } : {}),
      },
    });
  }

  const restore = restorePointFromPlacement(surface.placement);
  const nextPoint =
    point !== undefined ? clampSurfaceMinimizedPoint(surface.kind, point, context.viewport) : undefined;

  return succeed({
    ...surface,
    open: true,
    placement: {
      host: 'contained',
      mode: 'minimized',
      restore,
      ...(nextPoint ? { point: nextPoint } : {}),
    },
  });
}

/** Restore from maximized/minimized (or clear native OS maximize). */
export function restore(surface: SurfaceRecord, context: TransitionContext = {}): TransitionResult {
  if (isNativePlacement(surface.placement)) {
    const bounds = clampNativeBounds(
      surface.placement.bounds,
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      open: true,
      placement: {
        ...surface.placement,
        bounds,
        maximized: false,
        fullscreen: false,
      },
    });
  }

  if (surface.placement.mode !== 'maximized' && surface.placement.mode !== 'minimized') {
    return succeed(surface);
  }

  return succeed({
    ...surface,
    open: true,
    placement: placementFromRestorePoint(surface.placement.restore),
  });
}

/** Externalize to a native window (Electron only). Distinct from float. */
export function externalize(
  surface: SurfaceRecord,
  bounds: Rect,
  context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'externalize');
  if (denied) return denied;

  if (!context.allowNative) {
    return deny('externalize-unavailable', 'externalize requires a native host');
  }

  if (isNativePlacement(surface.placement)) {
    return deny('invalid-placement', `${surface.kind} is already native`);
  }

  const returnPoint = restorePointFromPlacement(surface.placement);
  const nextBounds = clampNativeBounds(
    bounds,
    context.workArea,
    SURFACE_MIN_SIZES[surface.kind].floating,
  );

  const placement: NativePlacement = {
    host: 'native',
    bounds: nextBounds,
    ...(context.displayId !== undefined ? { displayId: context.displayId } : {}),
  };

  return succeed({
    ...surface,
    open: true,
    placement,
    returnPoint,
  });
}

/**
 * Return from native to contained restore point.
 * live-preview-output also yields previewPlacement for the contained preview host.
 */
export function returnToWorkspace(
  surface: SurfaceRecord,
  context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'return');
  if (denied) return denied;

  if (surface.kind === 'live-preview-output') {
    const restore =
      surface.returnPoint ??
      (isNativePlacement(surface.placement)
        ? defaultRestorePoint('preview')
        : isContainedPlacement(surface.placement)
          ? restorePointFromPlacement(surface.placement)
          : defaultRestorePoint('preview'));
    const previewPlacement = placementFromRestorePoint(restore);
    return succeed(
      {
        ...surface,
        open: false,
        placement: surface.placement,
        returnPoint: cloneRestorePoint(restore),
      },
      { previewPlacement },
    );
  }

  if (!isNativePlacement(surface.placement)) {
    return deny('not-native', `${surface.kind} is not externalized`);
  }

  const restore = surface.returnPoint ?? defaultRestorePoint(surface.kind);
  let placement = placementFromRestorePoint(restore);

  if (placement.mode === 'floating') {
    placement = {
      host: 'contained',
      mode: 'floating',
      rect: clampFloatingRect(surface.kind, placement.rect, context.viewport),
    };
  } else if (placement.mode === 'docked') {
    placement = {
      host: 'contained',
      mode: 'docked',
      side: placement.side,
      size: clampDockSize(surface.kind, placement.size),
    };
  }

  return succeed({
    ...surface,
    open: true,
    placement,
    returnPoint: undefined,
  });
}

/** Move a floating contained window or native bounds origin. */
export function move(
  surface: SurfaceRecord,
  position: Point,
  context: TransitionContext = {},
): TransitionResult {
  if (isNativePlacement(surface.placement)) {
    const bounds = clampNativeBounds(
      {
        ...surface.placement.bounds,
        x: position.x,
        y: position.y,
      },
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      placement: { ...surface.placement, bounds },
    });
  }

  if (surface.placement.mode === 'floating') {
    const rect = clampFloatingRect(
      surface.kind,
      { ...surface.placement.rect, x: position.x, y: position.y },
      context.viewport,
    );
    return succeed({
      ...surface,
      placement: { host: 'contained', mode: 'floating', rect },
    });
  }

  if (surface.placement.mode === 'minimized') {
    const point = clampSurfaceMinimizedPoint(surface.kind, position, context.viewport);
    return succeed({
      ...surface,
      placement: { ...surface.placement, point },
    });
  }

  return deny('invalid-placement', `${surface.kind} placement cannot move`);
}

/** Resize floating rect, dock size, or native bounds. */
export function resize(
  surface: SurfaceRecord,
  next: { rect?: Rect; size?: number; bounds?: Rect },
  context: TransitionContext = {},
): TransitionResult {
  if (isNativePlacement(surface.placement)) {
    if (!next.bounds) {
      return deny('invalid-argument', 'native resize requires bounds');
    }
    const bounds = clampNativeBounds(
      next.bounds,
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      placement: { ...surface.placement, bounds },
    });
  }

  if (surface.placement.mode === 'floating') {
    if (!next.rect) {
      return deny('invalid-argument', 'floating resize requires rect');
    }
    const rect = clampFloatingRect(surface.kind, next.rect, context.viewport);
    return succeed({
      ...surface,
      placement: { host: 'contained', mode: 'floating', rect },
    });
  }

  if (surface.placement.mode === 'docked') {
    if (next.size === undefined) {
      return deny('invalid-argument', 'docked resize requires size');
    }
    return succeed({
      ...surface,
      placement: {
        host: 'contained',
        mode: 'docked',
        side: surface.placement.side,
        size: clampDockSize(surface.kind, next.size),
      },
    });
  }

  return deny('invalid-placement', `${surface.kind} placement cannot resize`);
}

/** Reset geometry to kind defaults without changing durable mode family when possible. */
export function resetGeometry(
  surface: SurfaceRecord,
  context: TransitionContext = {},
): TransitionResult {
  if (isNativePlacement(surface.placement)) {
    const bounds = clampNativeBounds(
      defaultFloatingRectFor(surface.kind, context.workArea ?? context.viewport),
      context.workArea,
      SURFACE_MIN_SIZES[surface.kind].floating,
    );
    return succeed({
      ...surface,
      placement: { ...surface.placement, bounds, maximized: false, fullscreen: false },
    });
  }

  if (surface.placement.mode === 'floating' || surface.placement.mode === 'stage') {
    if (capabilitiesFor(surface.kind).stage && surface.placement.mode === 'stage') {
      return succeed(surface);
    }
    return floatSurface(surface, defaultFloatingRectFor(surface.kind, context.viewport), context);
  }

  if (surface.placement.mode === 'docked') {
    return dock(surface, surface.placement.side, defaultDockSize(surface.kind), context);
  }

  if (surface.placement.mode === 'maximized' || surface.placement.mode === 'minimized') {
    const restored = restore(surface, context);
    if (!restored.ok) return restored;
    return resetGeometry(restored.surface, context);
  }

  return succeed(surface);
}

/**
 * Close / hide a surface. Never discards drafts.
 *
 * Preview cannot close. Closing the last editor group is rejected — if that
 * group is external, callers must return-to-workspace instead.
 */
export function closeSurface(
  surface: SurfaceRecord,
  context: TransitionContext = {},
): TransitionResult {
  const denied = requireCapability(surface.kind, 'close');
  if (denied) return denied;

  if (surface.kind === 'editor') {
    const remaining = context.remainingEditorGroups;
    if (remaining === undefined) {
      return deny(
        'invalid-argument',
        'closing an editor requires remainingEditorGroups in context',
      );
    }
    if (remaining < 1) {
      if (isNativePlacement(surface.placement)) {
        return deny(
          'last-editor-group',
          'closing the last editor group is rejected; return to workspace instead',
        );
      }
      return deny('last-editor-group', 'closing the last editor group is rejected');
    }
  }

  return succeed({
    ...surface,
    open: false,
  });
}

/** Open / show a previously closed surface without changing placement. */
export function openSurface(surface: SurfaceRecord): TransitionResult {
  return succeed({ ...surface, open: true });
}

/** Whether a new instance of this kind may be created given open siblings. */
export function canCreateInstance(
  kind: SurfaceKind,
  openSiblings: readonly SurfaceRecord[],
): TransitionResult | { ok: true } {
  const caps = capabilitiesFor(kind);
  if (caps.singleton && openSiblings.some((s) => s.kind === kind && s.open)) {
    return deny('singleton-exists', `${kind} already has an open instance`);
  }
  if (!caps.multiInstance && openSiblings.some((s) => s.kind === kind)) {
    return deny('singleton-exists', `${kind} allows only one instance`);
  }
  return { ok: true };
}

export function durableRestoreOf(surface: SurfaceRecord): RestorePoint {
  if (isNativePlacement(surface.placement)) {
    return surface.returnPoint ?? defaultRestorePoint(surface.kind);
  }
  return restorePointFromPlacement(surface.placement);
}
