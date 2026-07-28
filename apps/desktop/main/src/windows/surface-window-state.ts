/**
 * Persist native surface geometry by durable SurfaceId — never by BrowserWindow.id
 * or webContents.id, which are process-lifetime only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Rect, Size } from '@shader-studio/shared/geometry';
import type { SurfaceId, SurfaceKind } from '@shader-studio/shared/surfaces';
import { SURFACE_MIN_SIZES } from '@shader-studio/shared/surfaces';

export const SURFACE_WINDOW_STATE_VERSION = 1 as const;

export interface DisplayWorkArea {
  id: string;
  workArea: Rect;
}

export interface PersistedSurfaceWindowState {
  bounds: Rect;
  displayId?: string;
  maximized?: boolean;
  fullscreen?: boolean;
}

export interface SurfaceWindowsStateFile {
  version: typeof SURFACE_WINDOW_STATE_VERSION;
  /** Keyed by SurfaceId string. */
  surfaces: Record<string, PersistedSurfaceWindowState>;
}

export interface ResolvedSurfaceBounds {
  bounds: Rect;
  displayId?: string;
  maximized: boolean;
  fullscreen: boolean;
}

const EMPTY_FILE: SurfaceWindowsStateFile = {
  version: SURFACE_WINDOW_STATE_VERSION,
  surfaces: {},
};

export function minSizeForKind(kind: SurfaceKind): Size {
  return SURFACE_MIN_SIZES[kind].floating;
}

/** True when the rectangle intersects at least one display work area. */
export function boundsIntersectAnyDisplay(
  bounds: Rect,
  displays: readonly DisplayWorkArea[],
): boolean {
  return displays.some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  });
}

export function findDisplay(
  displays: readonly DisplayWorkArea[],
  displayId: string | undefined,
): DisplayWorkArea | undefined {
  if (!displayId) return undefined;
  return displays.find((d) => d.id === displayId);
}

/**
 * Clamp absolute screen bounds into a display work area (multi-monitor safe).
 * Shared `clampNativeBounds` assumes a 0,0 viewport and is for contained hosts.
 */
export function clampBoundsToWorkArea(bounds: Rect, workArea: Rect, min: Size): Rect {
  const width = Math.round(Math.min(Math.max(bounds.width, min.width), workArea.width));
  const height = Math.round(Math.min(Math.max(bounds.height, min.height), workArea.height));
  return {
    width,
    height,
    x: Math.round(
      Math.min(Math.max(bounds.x, workArea.x), workArea.x + Math.max(0, workArea.width - width)),
    ),
    y: Math.round(
      Math.min(Math.max(bounds.y, workArea.y), workArea.y + Math.max(0, workArea.height - height)),
    ),
  };
}

/**
 * Validate and recover remembered bounds against the current display set.
 * Missing displays fall back to centering on the primary work area.
 */
export function resolveSurfaceBounds(options: {
  remembered?: PersistedSurfaceWindowState;
  kind: SurfaceKind;
  displays: readonly DisplayWorkArea[];
  fallback: Rect;
}): ResolvedSurfaceBounds {
  const min = minSizeForKind(options.kind);
  const remembered = options.remembered;
  const preferred = findDisplay(options.displays, remembered?.displayId);
  const overlapping =
    remembered?.bounds &&
    options.displays.find((d) => {
      const a = d.workArea;
      const b = remembered.bounds!;
      return (
        b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y
      );
    });
  const target = preferred ?? overlapping ?? options.displays[0];
  const raw = remembered?.bounds ?? options.fallback;

  let bounds: Rect;
  if (
    remembered?.bounds &&
    target &&
    boundsIntersectAnyDisplay(remembered.bounds, options.displays)
  ) {
    bounds = clampBoundsToWorkArea(remembered.bounds, target.workArea, min);
  } else if (target) {
    bounds = centerInWorkArea(
      target.workArea,
      raw.width || options.fallback.width,
      raw.height || options.fallback.height,
      min,
    );
  } else {
    bounds = {
      x: Math.round(options.fallback.x),
      y: Math.round(options.fallback.y),
      width: Math.round(Math.max(options.fallback.width, min.width)),
      height: Math.round(Math.max(options.fallback.height, min.height)),
    };
  }

  return {
    bounds,
    displayId: target?.id,
    maximized: Boolean(remembered?.maximized),
    fullscreen: Boolean(remembered?.fullscreen),
  };
}

export function centerInWorkArea(workArea: Rect, width: number, height: number, min: Size): Rect {
  const w = Math.round(Math.min(Math.max(width, min.width), workArea.width));
  const h = Math.round(Math.min(Math.max(height, min.height), workArea.height));
  return {
    x: workArea.x + Math.max(0, Math.round((workArea.width - w) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - h) / 2)),
    width: w,
    height: h,
  };
}

export function parseSurfaceWindowsState(raw: unknown): SurfaceWindowsStateFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_FILE, surfaces: {} };
  const record = raw as Record<string, unknown>;
  const version =
    record['version'] === SURFACE_WINDOW_STATE_VERSION
      ? SURFACE_WINDOW_STATE_VERSION
      : SURFACE_WINDOW_STATE_VERSION;
  const surfacesIn = record['surfaces'];
  const surfaces: Record<string, PersistedSurfaceWindowState> = {};
  if (surfacesIn && typeof surfacesIn === 'object') {
    for (const [id, value] of Object.entries(surfacesIn as Record<string, unknown>)) {
      const parsed = parseOne(value);
      if (parsed) surfaces[id] = parsed;
    }
  }
  return { version, surfaces };
}

function parseOne(value: unknown): PersistedSurfaceWindowState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  const bounds = item['bounds'];
  if (!bounds || typeof bounds !== 'object') return undefined;
  const b = bounds as Record<string, unknown>;
  if (
    ![b['x'], b['y'], b['width'], b['height']].every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    )
  ) {
    return undefined;
  }
  return {
    bounds: {
      x: Math.round(b['x'] as number),
      y: Math.round(b['y'] as number),
      width: Math.round(b['width'] as number),
      height: Math.round(b['height'] as number),
    },
    displayId: typeof item['displayId'] === 'string' ? item['displayId'] : undefined,
    maximized: Boolean(item['maximized']),
    fullscreen: Boolean(item['fullscreen']),
  };
}

export class SurfaceWindowStateStore {
  private file: SurfaceWindowsStateFile = { ...EMPTY_FILE, surfaces: {} };
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      this.file = parseSurfaceWindowsState(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      this.file = { ...EMPTY_FILE, surfaces: {} };
    }
    this.loaded = true;
  }

  get(surfaceId: SurfaceId): PersistedSurfaceWindowState | undefined {
    return this.file.surfaces[surfaceId];
  }

  set(surfaceId: SurfaceId, state: PersistedSurfaceWindowState): void {
    this.file.surfaces[surfaceId] = {
      bounds: { ...state.bounds },
      displayId: state.displayId,
      maximized: state.maximized,
      fullscreen: state.fullscreen,
    };
  }

  remove(surfaceId: SurfaceId): void {
    delete this.file.surfaces[surfaceId];
  }

  async save(): Promise<void> {
    if (!this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.file, null, 2), 'utf8');
  }
}
