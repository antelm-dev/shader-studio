import type { BrowserWindow } from 'electron';

import type { SurfaceWindowManager } from './surface-window-manager';

export type SurfaceIpcAction = 'open' | 'focus' | 'close' | 'return' | 'list' | 'state' | 'context';

export type SurfaceAuthResult = { allowed: true } | { allowed: false; reason: string };

/**
 * Pure authorization helper used by SurfaceWindowManager and unit tests.
 * Main may manage any surface; a satellite may only act on its own SurfaceId.
 */
export function authorizeSurfaceAction(
  manager: Pick<SurfaceWindowManager, 'getContextForSender'>,
  sender: BrowserWindow,
  action: SurfaceIpcAction,
  targetId?: string,
): SurfaceAuthResult {
  const ctx = manager.getContextForSender(sender);
  if (action === 'context') return { allowed: true };
  if (ctx.role === 'unknown') return { allowed: false, reason: 'unknown-sender' };
  if (ctx.role === 'main') return { allowed: true };
  if (action === 'open' || action === 'list') {
    return { allowed: false, reason: 'satellite-forbidden' };
  }
  if (!targetId) return { allowed: true };
  if (targetId !== ctx.surfaceId) {
    return { allowed: false, reason: 'not-owner' };
  }
  return { allowed: true };
}
