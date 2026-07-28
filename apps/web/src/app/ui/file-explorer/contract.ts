import type { BufferSlot, ChannelIndex } from '@shader-studio/shared/project';

/**
 * Contract types for the editor-local file explorer.
 *
 * Pure data shapes only — no Angular, no Material tree types. The projection
 * layer (agent 02) builds `ExplorerTree`; the panel (agent 03) renders it.
 */

/** Persisted and in-memory view selection. */
export const EXPLORER_VIEW_MODES = ['files', 'pipeline'] as const;
export type ExplorerViewMode = (typeof EXPLORER_VIEW_MODES)[number];

/** Selectable row kinds — each maps to an `EditorDocument.id`. */
export type ExplorerSelectableKind =
  | 'image-pass'
  | 'common-pass'
  | 'buffer-pass'
  | 'source-file'
  | 'vertex'
  | 'config';

/** Non-document rows — groups, channels, and binding detail. */
export type ExplorerInformationalKind =
  | 'group'
  | 'channel'
  | 'channel-none'
  | 'channel-texture'
  | 'channel-buffer'
  | 'channel-feedback';

export type ExplorerNodeKind = ExplorerSelectableKind | ExplorerInformationalKind;

/** User intents the panel may emit for integration to handle. */
export type ExplorerContextCommand =
  | 'rename'
  | 'duplicate'
  | 'delete'
  | 'enable'
  | 'disable'
  | 'create-buffer'
  | 'create-file';

/** Drag-and-drop reorder within buffer or file lists (same rules as editor tabs). */
export interface ExplorerReorderIntent {
  sourceDocId: string;
  targetDocId: string;
  list: 'buffer' | 'file';
}

export interface ExplorerNodeCapabilities {
  selectable: boolean;
  rename: boolean;
  duplicate: boolean;
  delete: boolean;
  reorder: boolean;
  toggleEnabled: boolean;
}

export interface ExplorerNodeStatus {
  active: boolean;
  disabled: boolean;
  dirty: boolean;
  compiling: boolean;
  errorCount: number;
}

/**
 * One row in the explorer tree.
 *
 * Selectable nodes use `id === docId`. Informational nodes use deterministic
 * ids from `node-id.ts`.
 */
export interface ExplorerNode {
  id: string;
  kind: ExplorerNodeKind;
  /** Set when the row opens an editor document. */
  docId?: string;
  /** i18n key when the label is not `name` (groups, channels, bindings). */
  labelKey?: string;
  /** Document display name for passes and files. */
  name?: string;
  slot?: BufferSlot | null;
  depth: number;
  children: readonly ExplorerNode[];
  capabilities: ExplorerNodeCapabilities;
  status: ExplorerNodeStatus;
  /** Material icon ligature name — not user-facing text. */
  icon: string;
  /** Suggested initial expansion for groups; panel may override session-local. */
  defaultExpanded?: boolean;
  channelIndex?: ChannelIndex;
  channelTargetPassId?: string;
  textureSlot?: ChannelIndex;
}

export type ExplorerEmptyReason = 'loading' | 'no-project' | 'no-documents';

export interface ExplorerTree {
  view: ExplorerViewMode;
  nodes: readonly ExplorerNode[];
  emptyReason?: ExplorerEmptyReason;
}

export interface ExplorerSelectEvent {
  docId: string;
}

export interface ExplorerCommandEvent {
  command: ExplorerContextCommand;
  docId?: string;
}

/** Capabilities for a non-interactive informational row. */
export const INFORMATIONAL_CAPABILITIES: ExplorerNodeCapabilities = {
  selectable: false,
  rename: false,
  duplicate: false,
  delete: false,
  reorder: false,
  toggleEnabled: false,
};

/** Default status for informational rows. */
export const INACTIVE_STATUS: ExplorerNodeStatus = {
  active: false,
  disabled: false,
  dirty: false,
  compiling: false,
  errorCount: 0,
};

export function isSelectableKind(kind: ExplorerNodeKind): kind is ExplorerSelectableKind {
  return kind !== 'group' && !kind.startsWith('channel');
}

export function isExplorerViewMode(value: unknown): value is ExplorerViewMode {
  return typeof value === 'string' && (EXPLORER_VIEW_MODES as readonly string[]).includes(value);
}
