/**
 * Contained-surface runtime — reusable registry, controller, geometry gestures,
 * and control seams for Agent 06 migration. Does not replace EditorShell /
 * PreviewShell in this branch.
 */

export {
  availableSurfaceCommands,
  describeSurfaceCommands,
  type SurfaceCommandContext,
  type SurfaceCommandDescriptor,
  type SurfaceCommandId,
} from './surface-commands';

export {
  SurfaceController,
  type SurfaceCommandResult,
  type SurfaceControllerOptions,
} from './surface-controller';

export {
  SURFACE_MINIMIZED_CHROME,
  displayDockSize,
  displayFloatingRect,
  displayMinimizedPoint,
  projectSurfaceFrame,
  recoverContainedBounds,
  surfaceFrameHostClasses,
  type ProjectedSurfaceFrame,
  type SurfaceFrameOptions,
} from './surface-frame';

export {
  SurfaceGeometryGesture,
  type SurfaceGestureCommit,
  type SurfaceGestureKind,
} from './surface-gesture';

export {
  dockResizeEdge,
  dockSeparatorOrientation,
  floatingEdgeAriaOrientation,
  keyboardResizeDocked,
  keyboardResizeFloating,
  type KeyboardResizeResult,
} from './surface-keyboard';

export {
  SURFACE_STACK_Z_BASE,
  SurfaceRegistry,
  type SurfaceRegistrySnapshot,
} from './surface-registry';

export { SurfaceFrameMotionDirective } from './controls/surface-frame-motion';
export {
  SurfaceResizeHandles,
  type SurfaceResizeKey,
  type SurfaceResizePointer,
} from './controls/surface-resize-handles';
export { SurfaceTitleBarDirective } from './controls/surface-title-bar';
export { SurfaceWorkspaceDirective } from './controls/surface-workspace';
export {
  SurfaceLayoutService,
  PREVIEW_SURFACE_ID,
  DEFAULT_EDITOR_SURFACE_ID,
  INSPECTOR_SURFACE_ID,
} from './surface-layout';
