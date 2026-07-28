/**
 * Session-local editor group model. Framework-free; no Monaco or Angular.
 *
 * Each shader owns one or more editor groups. A document may appear in at most
 * one group's tab set (writable ownership). Group state is not persisted in
 * layout preferences and never stores source text.
 */

import type { EditorGroupId } from '../surfaces/types';
import type { SessionEditorViewState } from '../session/types';

/** Contained full chrome vs simplified satellite presentation. */
export type EditorGroupPresentation = 'full' | 'simple';

export const EDITOR_GROUP_PRESENTATIONS: readonly EditorGroupPresentation[] = [
  'full',
  'simple',
] as const;

export interface EditorGroupRecord {
  readonly id: EditorGroupId;
  /** Open tab order. */
  readonly documentIds: readonly string[];
  /** Active tab within the group; null when the group has no tabs yet. */
  readonly activeDocumentId: string | null;
  readonly presentation: EditorGroupPresentation;
}

export interface ShaderEditorGroups {
  readonly groups: readonly EditorGroupRecord[];
  readonly primaryGroupId: EditorGroupId;
  /** Last-focused group within the shader. */
  readonly activeGroupId: EditorGroupId;
}

/** Shader id → per-shader editor groups. */
export type EditorGroupsState = ReadonlyMap<string, ShaderEditorGroups>;

/** Serializable view-state handoff when moving tabs across groups/renderers. */
export interface EditorDocumentViewTransfer {
  readonly documentId: string;
  readonly viewState: SessionEditorViewState | null;
  readonly presentation?: EditorGroupPresentation;
}

export type EditorGroupMutationCode =
  | 'not-found'
  | 'last-tab'
  | 'last-group'
  | 'duplicate-document'
  | 'empty-primary'
  | 'invalid-target';

export interface EditorGroupMutationFailure {
  readonly ok: false;
  readonly code: EditorGroupMutationCode;
}

export interface EditorGroupMutationSuccess<T = void> {
  readonly ok: true;
  readonly state: EditorGroupsState;
  readonly value?: T;
}

export type EditorGroupMutationResult<T = void> =
  | EditorGroupMutationSuccess<T>
  | EditorGroupMutationFailure;

export interface CloseDocumentInGroupResult {
  readonly closed: boolean;
  /** When the closed tab was active: right neighbor, else left. */
  readonly nextActiveHint: string | null;
}

export interface CloseEditorGroupResult {
  readonly mergedDocumentIds: readonly string[];
  readonly targetGroupId: EditorGroupId;
}
