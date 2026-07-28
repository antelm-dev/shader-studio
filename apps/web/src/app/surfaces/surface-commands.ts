/**
 * Capability-filtered command descriptors for contained (and native-aware)
 * surface chrome. Content wrappers decide labels/icons; this only answers
 * "which actions are legal right now?".
 *
 * Detach/externalize ≠ float — both appear as separate descriptors when allowed.
 */

import {
  capabilitiesFor,
  isContainedPlacement,
  isNativePlacement,
  type DockSide,
  type SurfaceCapabilities,
  type SurfaceRecord,
} from '@shader-studio/shared/surfaces';

export type SurfaceCommandId =
  | 'showOnStage'
  | 'dock'
  | 'float'
  | 'maximize'
  | 'minimize'
  | 'restore'
  | 'reset'
  | 'externalize'
  | 'return'
  | 'close';

export interface SurfaceCommandDescriptor {
  readonly id: SurfaceCommandId;
  /** Capability + placement allow this command. */
  readonly available: boolean;
  /** Soft hint for menus — e.g. already docked on this side. */
  readonly active?: boolean;
  /** Dock target when id === 'dock'. */
  readonly dockSide?: DockSide;
}

export interface SurfaceCommandContext {
  /** Electron host may pass true; web must omit/false. */
  readonly allowNative?: boolean;
  /**
   * Editor groups that would remain after a close. Required for close on
   * editors; omit for non-editors.
   */
  readonly remainingEditorGroups?: number;
}

type BooleanCapability = {
  [K in keyof SurfaceCapabilities]: SurfaceCapabilities[K] extends boolean ? K : never;
}[keyof SurfaceCapabilities];

const COMMAND_CAPABILITY: Record<SurfaceCommandId, BooleanCapability | null> = {
  showOnStage: 'stage',
  dock: 'dock',
  float: 'float',
  maximize: 'maximize',
  minimize: 'minimize',
  restore: null,
  reset: null,
  externalize: 'externalize',
  return: 'return',
  close: 'close',
};

function capabilityAllows(surface: SurfaceRecord, id: SurfaceCommandId): boolean {
  const key = COMMAND_CAPABILITY[id];
  if (key === null) return true;
  return capabilitiesFor(surface.kind)[key];
}

function placementAllows(
  surface: SurfaceRecord,
  id: SurfaceCommandId,
  ctx: SurfaceCommandContext,
): boolean {
  const placement = surface.placement;

  switch (id) {
    case 'showOnStage':
      return isContainedPlacement(placement) && placement.mode !== 'stage';
    case 'dock':
      return !isNativePlacement(placement);
    case 'float':
      return (
        !isNativePlacement(placement) &&
        !(isContainedPlacement(placement) && placement.mode === 'floating')
      );
    case 'maximize':
      if (isNativePlacement(placement)) return !placement.maximized;
      return isContainedPlacement(placement) && placement.mode !== 'maximized';
    case 'minimize':
      if (isNativePlacement(placement)) return true;
      return isContainedPlacement(placement) && placement.mode !== 'minimized';
    case 'restore':
      if (isNativePlacement(placement)) return Boolean(placement.maximized || placement.fullscreen);
      return (
        isContainedPlacement(placement) &&
        (placement.mode === 'maximized' || placement.mode === 'minimized')
      );
    case 'reset':
      return surface.open;
    case 'externalize':
      return Boolean(ctx.allowNative) && !isNativePlacement(placement);
    case 'return':
      if (surface.kind === 'live-preview-output') return true;
      return isNativePlacement(placement);
    case 'close':
      if (!surface.open) return false;
      if (surface.kind === 'editor') {
        const remaining = ctx.remainingEditorGroups;
        if (remaining === undefined) return false;
        return remaining >= 1;
      }
      return true;
  }
}

function isActive(surface: SurfaceRecord, id: SurfaceCommandId, dockSide?: DockSide): boolean {
  const placement = surface.placement;
  if (id === 'dock' && dockSide && isContainedPlacement(placement)) {
    if (placement.mode === 'docked') return placement.side === dockSide;
    if (
      (placement.mode === 'maximized' || placement.mode === 'minimized') &&
      placement.restore.mode === 'docked'
    ) {
      return placement.restore.side === dockSide;
    }
  }
  if (id === 'float' && isContainedPlacement(placement) && placement.mode === 'floating') {
    return true;
  }
  if (id === 'showOnStage' && isContainedPlacement(placement) && placement.mode === 'stage') {
    return true;
  }
  if (id === 'maximize') {
    if (isNativePlacement(placement)) return Boolean(placement.maximized);
    return isContainedPlacement(placement) && placement.mode === 'maximized';
  }
  if (id === 'minimize') {
    return isContainedPlacement(placement) && placement.mode === 'minimized';
  }
  return false;
}

/**
 * Ordered command list for menus/toolbars. Always returns every vocabulary id
 * the kind could ever use, with `available` reflecting current state — so chrome
 * can hide or disable without forking capability matrices.
 */
export function describeSurfaceCommands(
  surface: SurfaceRecord,
  ctx: SurfaceCommandContext = {},
): SurfaceCommandDescriptor[] {
  const caps = capabilitiesFor(surface.kind);
  const descriptors: SurfaceCommandDescriptor[] = [];

  const push = (id: SurfaceCommandId, dockSide?: DockSide): void => {
    if (!capabilityAllows(surface, id)) return;
    if (id === 'dock' && dockSide && !caps.allowedDockSides.includes(dockSide)) return;

    descriptors.push({
      id,
      available: placementAllows(surface, id, ctx),
      active: isActive(surface, id, dockSide),
      ...(dockSide ? { dockSide } : {}),
    });
  };

  push('showOnStage');
  for (const side of caps.allowedDockSides) {
    push('dock', side);
  }
  push('float');
  push('maximize');
  push('minimize');
  push('restore');
  push('reset');
  push('externalize');
  push('return');
  push('close');

  return descriptors;
}

/** Convenience: only currently actionable commands. */
export function availableSurfaceCommands(
  surface: SurfaceRecord,
  ctx: SurfaceCommandContext = {},
): SurfaceCommandDescriptor[] {
  return describeSurfaceCommands(surface, ctx).filter((d) => d.available);
}
