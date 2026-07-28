/**
 * Placement helpers: restore-point extraction, durable defaults, and geometry
 * policy. Accepts viewport/work-area as pure input — never measures DOM/Electron.
 */

import { containPoint, containRect, type Point, type Rect, type Size } from '../geometry';
import {
  BOTTOM_PANEL_HEIGHT_LIMITS,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTHS,
  PANEL_LIMITS,
} from '../prefs/panel';
import { EDITOR_LIMITS, EDITOR_MIN_FLOATING } from '../prefs/editor';
import {
  DEFAULT_PREVIEW_WINDOW,
  PREVIEW_MIN_FLOATING,
  PREVIEW_MINIMIZED_SIZE,
  defaultFloatingRect,
} from '../prefs/preview';
import { allowsDockSide, capabilitiesFor } from './capabilities';
import type {
  ContainedPlacement,
  DockSide,
  NativePlacement,
  RestorePoint,
  SurfaceKind,
  SurfacePlacement,
  SurfaceRecord,
} from './types';

/** Compact editor viewport threshold (matches EditorWindow FLOATING_MIN_VIEWPORT). */
export const COMPACT_VIEWPORT_WIDTH = 700;

export const SURFACE_MIN_SIZES: Readonly<
  Record<SurfaceKind, { floating: Size; dock: { min: number; max: number } }>
> = {
  preview: {
    floating: PREVIEW_MIN_FLOATING,
    dock: { min: 0, max: 0 },
  },
  editor: {
    floating: EDITOR_MIN_FLOATING,
    dock: { min: EDITOR_LIMITS.dockedHeight.min, max: EDITOR_LIMITS.dockedHeight.max },
  },
  inspector: {
    floating: { width: PANEL_LIMITS.inspectorWidth.min, height: 200 },
    dock: { ...PANEL_LIMITS.inspectorWidth },
  },
  'shader-browser': {
    floating: { width: PANEL_LIMITS.browserWidth.min, height: 200 },
    dock: { ...PANEL_LIMITS.browserWidth },
  },
  'bottom-panel': {
    floating: { width: 360, height: BOTTOM_PANEL_HEIGHT_LIMITS.min },
    dock: { ...BOTTOM_PANEL_HEIGHT_LIMITS },
  },
  'live-preview-output': {
    floating: PREVIEW_MIN_FLOATING,
    dock: { min: 0, max: 0 },
  },
};

export function isContainedPlacement(placement: SurfacePlacement): placement is ContainedPlacement {
  return placement.host === 'contained';
}

export function isNativePlacement(placement: SurfacePlacement): placement is NativePlacement {
  return placement.host === 'native';
}

export function isDurableContainedMode(
  mode: ContainedPlacement['mode'],
): mode is RestorePoint['mode'] {
  return mode === 'stage' || mode === 'docked' || mode === 'floating';
}

/**
 * Snapshot the durable restore point from a contained placement.
 * Transient maximized/minimized reuse their existing restore; never nest.
 */
export function restorePointFromPlacement(placement: ContainedPlacement): RestorePoint {
  switch (placement.mode) {
    case 'stage':
      return { mode: 'stage' };
    case 'docked':
      return { mode: 'docked', side: placement.side, size: placement.size };
    case 'floating':
      return { mode: 'floating', rect: { ...placement.rect } };
    case 'maximized':
    case 'minimized':
      return cloneRestorePoint(placement.restore);
  }
}

export function cloneRestorePoint(restore: RestorePoint): RestorePoint {
  switch (restore.mode) {
    case 'stage':
      return { mode: 'stage' };
    case 'docked':
      return { mode: 'docked', side: restore.side, size: restore.size };
    case 'floating':
      return { mode: 'floating', rect: { ...restore.rect } };
  }
}

export function placementFromRestorePoint(restore: RestorePoint): ContainedPlacement {
  switch (restore.mode) {
    case 'stage':
      return { host: 'contained', mode: 'stage' };
    case 'docked':
      return { host: 'contained', mode: 'docked', side: restore.side, size: restore.size };
    case 'floating':
      return { host: 'contained', mode: 'floating', rect: { ...restore.rect } };
  }
}

export function defaultDockSide(kind: SurfaceKind): DockSide {
  const sides = capabilitiesFor(kind).allowedDockSides;
  if (sides.length === 0) return 'bottom';
  return sides[0]!;
}

export function defaultDockSize(kind: SurfaceKind): number {
  switch (kind) {
    case 'editor':
      return 340;
    case 'inspector':
      return DEFAULT_PANEL_WIDTHS.inspector;
    case 'shader-browser':
      return DEFAULT_PANEL_WIDTHS.browser;
    case 'bottom-panel':
      return DEFAULT_BOTTOM_PANEL_HEIGHT;
    default:
      return 300;
  }
}

export function defaultFloatingRectFor(kind: SurfaceKind, viewport?: Size): Rect {
  if (kind === 'preview' || kind === 'live-preview-output') {
    return viewport ? defaultFloatingRect(viewport) : { ...DEFAULT_PREVIEW_WINDOW.floating };
  }
  if (kind === 'editor') {
    return { x: 48, y: 48, width: 760, height: 460 };
  }
  const min = SURFACE_MIN_SIZES[kind].floating;
  return { x: 48, y: 48, width: Math.max(min.width, 360), height: Math.max(min.height, 280) };
}

export function defaultRestorePoint(kind: SurfaceKind): RestorePoint {
  const caps = capabilitiesFor(kind);
  if (caps.stage) return { mode: 'stage' };
  if (caps.dock) {
    return { mode: 'docked', side: defaultDockSide(kind), size: defaultDockSize(kind) };
  }
  return { mode: 'floating', rect: defaultFloatingRectFor(kind) };
}

export function defaultContainedPlacement(kind: SurfaceKind): ContainedPlacement {
  return placementFromRestorePoint(defaultRestorePoint(kind));
}

export function clampDockSize(kind: SurfaceKind, size: number): number {
  const limits = SURFACE_MIN_SIZES[kind].dock;
  if (limits.max <= 0) return size;
  return Math.round(Math.min(Math.max(size, limits.min), limits.max));
}

export function clampFloatingRect(kind: SurfaceKind, rect: Rect, viewport?: Size): Rect {
  const min = SURFACE_MIN_SIZES[kind].floating;
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(Math.max(rect.width, min.width)),
      height: Math.round(Math.max(rect.height, min.height)),
    };
  }
  return containRect(rect, viewport, min);
}

export function clampSurfaceMinimizedPoint(
  kind: SurfaceKind,
  point: Point,
  viewport?: Size,
): Point {
  const size =
    kind === 'preview' || kind === 'live-preview-output'
      ? PREVIEW_MINIMIZED_SIZE
      : { width: 232, height: 34 };
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return { x: Math.round(point.x), y: Math.round(point.y) };
  }
  return containPoint(point, viewport, size);
}

/**
 * Recover native bounds when the remembered display is missing or the work area
 * shrank. Zero work-area passes bounds through (unmeasured).
 */
export function clampNativeBounds(bounds: Rect, workArea?: Size, min?: Size): Rect {
  const floor = min ?? PREVIEW_MIN_FLOATING;
  if (!workArea || workArea.width <= 0 || workArea.height <= 0) {
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(Math.max(bounds.width, floor.width)),
      height: Math.round(Math.max(bounds.height, floor.height)),
    };
  }
  return containRect(bounds, workArea, floor);
}

/** Compact viewports force the editor's *rendered* dock to bottom; stored side stays. */
export function effectiveEditorDockSide(side: DockSide, viewportWidth: number): DockSide {
  if (viewportWidth > 0 && viewportWidth < COMPACT_VIEWPORT_WIDTH) return 'bottom';
  return side;
}

export function assertAllowedDockSide(kind: SurfaceKind, side: DockSide): boolean {
  return allowsDockSide(kind, side);
}

export function withPlacement(surface: SurfaceRecord, placement: SurfacePlacement): SurfaceRecord {
  return { ...surface, placement };
}

export function withOpen(surface: SurfaceRecord, open: boolean): SurfaceRecord {
  return { ...surface, open };
}
