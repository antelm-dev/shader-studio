import { Injectable, signal } from '@angular/core';

import {
  buildClaimOwnershipCommand,
  buildMoveDocumentCommand,
  buildReleaseOwnershipCommand,
  editorGroupClientId,
  type EditorDocumentViewTransfer,
} from '@shader-studio/shared/editor-groups';
import type { SessionCommand, SessionEditorViewState } from '@shader-studio/shared/session';
import type { EditorGroupId } from '@shader-studio/shared/surfaces';

/**
 * In-process ownership bridge until the workspace session broker is wired in
 * the web shell. Tracks pending view-state transfers for cross-group moves.
 */
@Injectable({ providedIn: 'root' })
export class EditorGroupSession {
  private readonly pendingTransfers = signal<ReadonlyMap<string, EditorDocumentViewTransfer>>(
    new Map(),
  );

  /** Last recorded view transfer for a document (Monaco metadata only). */
  viewTransfer(documentId: string): EditorDocumentViewTransfer | null {
    return this.pendingTransfers().get(documentId) ?? null;
  }

  recordViewTransfer(transfer: EditorDocumentViewTransfer): void {
    const next = new Map(this.pendingTransfers());
    next.set(transfer.documentId, transfer);
    this.pendingTransfers.set(next);
  }

  consumeViewTransfer(documentId: string): EditorDocumentViewTransfer | null {
    const current = this.pendingTransfers().get(documentId) ?? null;
    if (!current) return null;
    const next = new Map(this.pendingTransfers());
    next.delete(documentId);
    this.pendingTransfers.set(next);
    return current;
  }

  claimForGroup(groupId: EditorGroupId, documentId: string): SessionCommand {
    const command = buildClaimOwnershipCommand(documentId);
    void editorGroupClientId(groupId);
    return command;
  }

  releaseFromGroup(groupId: EditorGroupId, documentId: string): SessionCommand {
    const command = buildReleaseOwnershipCommand(documentId);
    void editorGroupClientId(groupId);
    return command;
  }

  moveToGroup(
    documentId: string,
    targetGroupId: EditorGroupId,
    viewState: SessionEditorViewState | null,
  ): SessionCommand {
    return buildMoveDocumentCommand(documentId, targetGroupId, viewState);
  }
}
