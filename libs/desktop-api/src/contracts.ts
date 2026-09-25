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

/** `disabled` when the build has no account server (`SHADER_STUDIO_ACCOUNT_URL`). */
export type AccountStatus = 'disabled' | 'signed-out' | 'signed-in' | 'reauth-required';

export interface AccountUser {
  id: string;
  name: string;
  email: string;
}

/** What the renderer may know about the account: never a credential. */
export interface AccountState {
  status: AccountStatus;
  user?: AccountUser;
}

export type SignInResult = 'ok' | 'cancelled' | 'timeout' | 'encryption-unavailable' | 'failed';

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

/** C5: how a local shader stands against the signed-in account. Templates have none. */
export type SyncStatus =
  | 'local-only'
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'conflict-resolved'
  | 'reauth-required'
  | 'other-account'
  | 'error';

/** Empty `statuses` when there is no account (disabled or signed out). */
export interface SyncChangedEvent {
  statuses: Record<string, SyncStatus>;
  progress: { done: number; total: number } | null;
  /** Shaders a "keep both" just replaced locally; sent once, with the next event. */
  replaced?: string[];
}
