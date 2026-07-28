/**
 * Backward-compatible primary-group adapter over shader-scoped editor groups.
 *
 * New code should prefer `EditorGroups` and `@shader-studio/shared/editor-groups`
 * directly. These helpers expose only the primary contained group tab strip.
 */

import { DEFAULT_EDITOR_GROUP_ID } from '@shader-studio/shared/surfaces';
import {
  closeDocumentInGroup,
  closeOtherDocumentsInGroup,
  emptyEditorGroupsState,
  ensureShaderGroups,
  openDocumentInGroup,
  openIdsForGroup,
  pruneStaleDocumentsInShader,
  reorderDocumentInGroup,
  type EditorGroupsState,
} from '@shader-studio/shared/editor-groups';

export type OpenDocumentsState = EditorGroupsState;

export function emptyOpenDocumentsState(): OpenDocumentsState {
  return emptyEditorGroupsState();
}

export function openIdsFor(
  state: OpenDocumentsState,
  shaderId: string | null | undefined,
): readonly string[] {
  return openIdsForGroup(state, shaderId, DEFAULT_EDITOR_GROUP_ID);
}

/** Seed a shader's primary group with `defaultDocId` when it has none yet. */
export function ensureShaderOpen(
  state: OpenDocumentsState,
  shaderId: string,
  defaultDocId: string,
): OpenDocumentsState {
  return ensureShaderGroups(state, shaderId, defaultDocId);
}

/** Add `docId` to the primary group if missing. */
export function openDocument(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): OpenDocumentsState {
  return openDocumentInGroup(state, shaderId, DEFAULT_EDITOR_GROUP_ID, docId);
}

export interface CloseDocumentResult {
  state: OpenDocumentsState;
  closed: boolean;
  nextActiveHint: string | null;
}

export function closeDocument(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): CloseDocumentResult {
  const { state: next, result } = closeDocumentInGroup(
    state,
    shaderId,
    DEFAULT_EDITOR_GROUP_ID,
    docId,
  );
  return { state: next, closed: result.closed, nextActiveHint: result.nextActiveHint };
}

export function closeOtherDocuments(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): OpenDocumentsState {
  return closeOtherDocumentsInGroup(state, shaderId, DEFAULT_EDITOR_GROUP_ID, docId);
}

export function reorderOpenDocument(
  state: OpenDocumentsState,
  shaderId: string,
  sourceId: string,
  targetId: string,
): OpenDocumentsState {
  return reorderDocumentInGroup(state, shaderId, DEFAULT_EDITOR_GROUP_ID, sourceId, targetId);
}

export function pruneOpenDocuments(
  state: OpenDocumentsState,
  shaderId: string,
  existingIds: ReadonlySet<string>,
  fallbackDocId: string,
): OpenDocumentsState {
  return pruneStaleDocumentsInShader(state, shaderId, existingIds, fallbackDocId);
}
