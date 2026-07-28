import type { ChannelIndex } from '@shader-studio/shared/project';

import type { ExplorerViewMode } from './contract';

/**
 * Deterministic explorer node ids.
 *
 * Selectable document rows use `EditorDocument.id` directly (see contract).
 * These helpers cover groups and pipeline channel rows so ids never depend on
 * array indexes alone.
 */

const PREFIX = 'explorer';

export const FILES_GROUP_IDS = {
  passes: `${PREFIX}:files:group:passes`,
  includes: `${PREFIX}:files:group:includes`,
  project: `${PREFIX}:files:group:project`,
} as const;

export const PIPELINE_GROUP_IDS = {
  common: `${PREFIX}:pipeline:group:common`,
  execution: `${PREFIX}:pipeline:group:execution`,
  disabled: `${PREFIX}:pipeline:group:disabled`,
} as const;

export function filesGroupId(key: keyof typeof FILES_GROUP_IDS): string {
  return FILES_GROUP_IDS[key];
}

export function pipelineGroupId(key: keyof typeof PIPELINE_GROUP_IDS): string {
  return PIPELINE_GROUP_IDS[key];
}

export function passChannelsGroupId(passId: string): string {
  return `${PREFIX}:pipeline:pass:${passId}:channels`;
}

export function passChannelId(passId: string, channel: ChannelIndex): string {
  return `${PREFIX}:pipeline:pass:${passId}:channel:${channel}`;
}

export type ChannelBindingIdKind = 'none' | 'texture' | 'buffer' | 'feedback';

export function channelBindingId(
  passId: string,
  channel: ChannelIndex,
  binding: { kind: ChannelBindingIdKind; targetId?: string; textureSlot?: ChannelIndex },
): string {
  const base = passChannelId(passId, channel);
  switch (binding.kind) {
    case 'none':
      return `${base}:binding:none`;
    case 'texture':
      return `${base}:binding:texture:${binding.textureSlot ?? channel}`;
    case 'buffer':
      return `${base}:binding:buffer:${binding.targetId ?? 'unknown'}`;
    case 'feedback':
      return `${base}:binding:feedback:${binding.targetId ?? 'unknown'}`;
  }
}

/** True when `id` is a stable explorer-scoped identifier (not a document id). */
export function isExplorerScopedId(id: string): boolean {
  return id.startsWith(`${PREFIX}:`);
}

/** Document ids used as selectable node ids must not use the explorer prefix. */
export function assertSelectableNodeId(docId: string): void {
  if (isExplorerScopedId(docId)) {
    throw new Error(`Selectable explorer nodes must use EditorDocument.id, not "${docId}"`);
  }
}

export function groupIdForView(view: ExplorerViewMode, groupKey: string): string {
  return `${PREFIX}:${view}:group:${groupKey}`;
}
