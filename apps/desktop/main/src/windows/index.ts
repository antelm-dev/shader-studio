export { authorizeSurfaceAction } from './surface-ipc-auth';
export type { SurfaceAuthResult, SurfaceIpcAction } from './surface-ipc-auth';

export {
  applyNavigationPolicy,
  assertSafeSurfacePath,
  createAppUrlChecker,
  createSecureBrowserWindow,
} from './browser-window-factory';
export type { NavigationPolicyOptions, SecureWindowOptions } from './browser-window-factory';

export { SurfaceWindowRegistry } from './surface-window-registry';
export type {
  RegistryOpenDecision,
  SurfaceWindowEntry,
  SurfaceWindowRole,
} from './surface-window-registry';

export {
  SurfaceWindowStateStore,
  boundsIntersectAnyDisplay,
  centerInWorkArea,
  clampBoundsToWorkArea,
  minSizeForKind,
  parseSurfaceWindowsState,
  resolveSurfaceBounds,
} from './surface-window-state';
export type {
  DisplayWorkArea,
  PersistedSurfaceWindowState,
  ResolvedSurfaceBounds,
  SurfaceWindowsStateFile,
} from './surface-window-state';

export { SurfaceWindowManager } from './surface-window-manager';
export type {
  NativeSurfaceSnapshot,
  OpenSurfaceRequest,
  SurfaceContext,
  SurfaceManagerResult,
  SurfaceWindowManagerOptions,
} from './surface-window-manager';
