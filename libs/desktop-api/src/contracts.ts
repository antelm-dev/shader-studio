export type DialogResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type MigrationResult =
  | { status: 'ok'; imported: number; skipped: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export type UpdateStatus =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}

/** Mirrors @shader-studio/shared SurfaceKind for the preload boundary. */
export type NativeSurfaceKind =
  | 'preview'
  | 'editor'
  | 'inspector'
  | 'shader-browser'
  | 'bottom-panel'
  | 'live-preview-output';

export interface NativeSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Open a native satellite. `path` is an app pathname only (e.g. `/output`) —
 * never editable source or session snapshots.
 */
export interface NativeSurfaceOpenRequest {
  surfaceId: string;
  kind: NativeSurfaceKind;
  path: string;
  bounds?: NativeSurfaceBounds;
  maximized?: boolean;
  fullscreen?: boolean;
}

export interface NativeSurfaceSnapshot {
  surfaceId: string;
  kind: NativeSurfaceKind;
  path: string;
  bounds: NativeSurfaceBounds;
  displayId?: string;
  maximized: boolean;
  fullscreen: boolean;
}

export type NativeSurfaceResult =
  | { status: 'ok'; surface: NativeSurfaceSnapshot }
  | { status: 'focused'; surface: NativeSurfaceSnapshot }
  | { status: 'closed'; surfaceId: string }
  | { status: 'returned'; surfaceId: string }
  | { status: 'rejected'; reason: string };

export type NativeSurfaceContext =
  | { role: 'main' }
  | { role: 'satellite'; surfaceId: string; kind: NativeSurfaceKind; path: string }
  | { role: 'unknown' };

export type NativeSurfaceChangedEvent =
  | (NativeSurfaceSnapshot & { open: true })
  | { surfaceId: string; open: false };
