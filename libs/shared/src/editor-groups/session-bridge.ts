/**
 * Bridge editor groups to session client ownership.
 *
 * Each editor group maps to a stable SessionClientId for cross-renderer moves.
 * Same-renderer moves update group state locally; cross-renderer moves use
 * `moveDocument` / `claimOwnership` on the session broker.
 */

import { asSessionClientId, type SessionClientId } from '../session/ids';
import type { SessionCommand, SessionEditorViewState } from '../session/types';
import type { EditorGroupId } from '../surfaces/types';
import type { EditorDocumentViewTransfer, EditorGroupPresentation } from './types';

const CLIENT_PREFIX = 'editor-group-client:';

export function editorGroupClientId(groupId: EditorGroupId): SessionClientId {
  return asSessionClientId(`${CLIENT_PREFIX}${groupId}`);
}

export function sessionClientToEditorGroupId(clientId: SessionClientId): EditorGroupId | null {
  const value = clientId as string;
  if (!value.startsWith(CLIENT_PREFIX)) return null;
  return value.slice(CLIENT_PREFIX.length) as EditorGroupId;
}

export function buildClaimOwnershipCommand(documentId: string): SessionCommand {
  return { type: 'claimOwnership', documentId };
}

export function buildReleaseOwnershipCommand(documentId: string): SessionCommand {
  return { type: 'releaseOwnership', documentId };
}

export function buildMoveDocumentCommand(
  documentId: string,
  targetGroupId: EditorGroupId,
  viewState?: SessionEditorViewState | null,
): SessionCommand {
  return {
    type: 'moveDocument',
    documentId,
    targetClientId: editorGroupClientId(targetGroupId),
    viewState,
  };
}

export function toViewTransfer(
  documentId: string,
  viewState: SessionEditorViewState | null,
  presentation?: EditorGroupPresentation,
): EditorDocumentViewTransfer {
  return { documentId, viewState, presentation };
}

export interface EditorGroupSessionSnapshotGroup {
  readonly groupId: EditorGroupId;
  readonly openDocumentIds: readonly string[];
  readonly activeDocumentId: string | null;
  readonly presentation: EditorGroupPresentation;
  readonly ownerClientId: SessionClientId;
}

export function serializeEditorGroupsForSession(
  groups: readonly {
    readonly id: EditorGroupId;
    readonly documentIds: readonly string[];
    readonly activeDocumentId: string | null;
    readonly presentation: EditorGroupPresentation;
  }[],
): readonly EditorGroupSessionSnapshotGroup[] {
  return groups.map((group) => ({
    groupId: group.id,
    openDocumentIds: [...group.documentIds],
    activeDocumentId: group.activeDocumentId,
    presentation: group.presentation,
    ownerClientId: editorGroupClientId(group.id),
  }));
}
