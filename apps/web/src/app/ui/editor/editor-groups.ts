import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import {
  activateEditorGroup,
  activeDocumentForGroup,
  closeDocumentInGroup,
  closeEditorGroup,
  closeOtherDocumentsInGroup,
  createEditorGroup,
  editorGroupIdsFor,
  emptyEditorGroupsState,
  ensureShaderGroups,
  groupOwningDocumentFor,
  mergeEditorGroups,
  moveDocumentBetweenGroups,
  openDocumentInGroup,
  openIdsForGroup,
  pruneEmptyEditorGroups,
  pruneStaleDocumentsInShader,
  reorderDocumentInGroup,
  selectDocumentInGroup,
  shaderEditorGroupsFor,
  type EditorDocumentViewTransfer,
  type EditorGroupPresentation,
  type EditorGroupsState,
} from '@shader-studio/shared/editor-groups';
import { DEFAULT_EDITOR_GROUP_ID, type EditorGroupId } from '@shader-studio/shared/surfaces';

import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { EditorGroupSession } from './editor-group-session';

/**
 * Shader-scoped editor groups: ordered tabs, active document, and ownership
 * per group. The primary contained group remains the default editing surface.
 */
@Injectable({ providedIn: 'root' })
export class EditorGroups {
  readonly primaryGroupId = DEFAULT_EDITOR_GROUP_ID;

  private readonly store = inject(ShaderStore);
  private readonly session = inject(EditorGroupSession);
  private readonly state = signal<EditorGroupsState>(emptyEditorGroupsState());

  readonly groupIds = computed(() => editorGroupIdsFor(this.state(), this.store.selectedId()));

  readonly activeGroupId = computed(
    () => shaderEditorGroupsFor(this.state(), this.store.selectedId())?.activeGroupId ?? null,
  );

  readonly canCloseGroup = computed(() => this.groupIds().length > 1);

  constructor() {
    effect(() => {
      const shaderId = this.store.selectedId();
      const documents = this.store.documents();
      const activeId = this.store.activeDoc()?.id ?? null;

      if (!shaderId || !activeId || documents.length === 0) return;

      untracked(() => {
        this.state.update((current) => {
          let next = ensureShaderGroups(current, shaderId, activeId);
          next = openDocumentInGroup(next, shaderId, this.primaryGroupId, activeId);
          const existing = new Set(documents.map((doc) => doc.id));
          const fallback = documents[0]?.id ?? activeId;
          next = pruneStaleDocumentsInShader(next, shaderId, existing, fallback);
          return pruneEmptyEditorGroups(next, shaderId);
        });
      });
    });
  }

  openIds(groupId: EditorGroupId = this.primaryGroupId): readonly string[] {
    return openIdsForGroup(this.state(), this.store.selectedId(), groupId);
  }

  activeDocumentId(groupId: EditorGroupId = this.primaryGroupId): string | null {
    return activeDocumentForGroup(this.state(), this.store.selectedId(), groupId);
  }

  openDocs(groupId: EditorGroupId = this.primaryGroupId): readonly EditorDocument[] {
    const byId = new Map(this.store.documents().map((doc) => [doc.id, doc]));
    return this.openIds(groupId)
      .map((id) => byId.get(id))
      .filter((doc): doc is EditorDocument => doc !== undefined);
  }

  canClose(groupId: EditorGroupId = this.primaryGroupId): boolean {
    return this.openIds(groupId).length > 1;
  }

  presentation(groupId: EditorGroupId = this.primaryGroupId): EditorGroupPresentation {
    const shaderGroups = shaderEditorGroupsFor(this.state(), this.store.selectedId());
    return shaderGroups?.groups.find((group) => group.id === groupId)?.presentation ?? 'full';
  }

  ownerGroupId(documentId: string): EditorGroupId | null {
    const shaderId = this.store.selectedId();
    if (!shaderId) return null;
    return groupOwningDocumentFor(this.state(), shaderId, documentId);
  }

  activateGroup(groupId: EditorGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    this.state.update((current) => {
      const result = activateEditorGroup(current, shaderId, groupId);
      return result.ok ? result.state : current;
    });
  }

  activate(docId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;

    this.state.update((current) => {
      let next = openDocumentInGroup(current, shaderId, groupId, docId);
      next = selectDocumentInGroup(next, shaderId, groupId, docId);
      return next;
    });
    this.session.claimForGroup(groupId, docId);
    this.store.selectDoc(docId);
  }

  close(docId: string, groupId: EditorGroupId = this.primaryGroupId): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const activeId = this.store.activeDoc()?.id ?? null;
    const { state: next, result } = closeDocumentInGroup(this.state(), shaderId, groupId, docId);
    if (!result.closed) return false;

    this.state.set(next);
    if (activeId === docId && result.nextActiveHint) {
      this.store.selectDoc(result.nextActiveHint);
    }
    return true;
  }

  closeOthers(docId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;

    this.state.update((current) => closeOtherDocumentsInGroup(current, shaderId, groupId, docId));
    this.store.selectDoc(docId);
  }

  reorder(sourceId: string, targetId: string, groupId: EditorGroupId = this.primaryGroupId): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    this.state.update((current) =>
      reorderDocumentInGroup(current, shaderId, groupId, sourceId, targetId),
    );
  }

  cycle(step: 1 | -1, groupId: EditorGroupId = this.primaryGroupId): void {
    const ids = this.openIds(groupId);
    if (ids.length === 0) return;

    const activeId = this.store.activeDoc()?.id ?? null;
    const current = ids.findIndex((id) => id === activeId);
    const index = current < 0 ? 0 : (current + step + ids.length) % ids.length;
    this.activate(ids[index]!, groupId);
  }

  createGroup(
    options: { presentation?: EditorGroupPresentation; activate?: boolean } = {},
  ): EditorGroupId | null {
    const shaderId = this.store.selectedId();
    if (!shaderId) return null;

    let createdId: EditorGroupId | null = null;
    this.state.update((current) => {
      const result = createEditorGroup(current, shaderId, options);
      if (!result.ok) return current;
      createdId = result.value ?? null;
      return result.state;
    });
    return createdId;
  }

  closeGroup(groupId: EditorGroupId, mergeTargetId?: EditorGroupId): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const result = closeEditorGroup(this.state(), shaderId, groupId, mergeTargetId);
    if (!result.ok) return false;

    this.state.set(result.state);
    const targetId = result.value?.targetGroupId ?? this.primaryGroupId;
    const active = activeDocumentForGroup(this.state(), shaderId, targetId);
    if (active) this.store.selectDoc(active);
    return true;
  }

  mergeGroups(sourceGroupId: EditorGroupId, targetGroupId: EditorGroupId): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const result = mergeEditorGroups(this.state(), shaderId, sourceGroupId, targetGroupId);
    if (!result.ok) return false;
    this.state.set(result.state);
    return true;
  }

  moveDocument(
    documentId: string,
    targetGroupId: EditorGroupId,
    options: {
      sourceGroupId?: EditorGroupId;
      index?: number;
      transfer?: EditorDocumentViewTransfer | null;
    } = {},
  ): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const result = moveDocumentBetweenGroups(
      this.state(),
      shaderId,
      documentId,
      targetGroupId,
      options,
    );
    if (!result.ok) return false;

    let next = result.state;
    next = pruneEmptyEditorGroups(next, shaderId);
    this.state.set(next);

    if (options.transfer?.viewState) {
      this.session.recordViewTransfer(options.transfer);
    }
    this.session.moveToGroup(documentId, targetGroupId, options.transfer?.viewState ?? null);
    this.activate(documentId, targetGroupId);
    return true;
  }

  moveToNewGroup(documentId: string, groupId?: EditorGroupId): boolean {
    const targetGroupId = groupId ?? this.createGroup({ activate: true });
    if (!targetGroupId) return false;
    return this.moveDocument(documentId, targetGroupId);
  }

  otherGroupIds(groupId: EditorGroupId = this.primaryGroupId): readonly EditorGroupId[] {
    return this.groupIds().filter((id) => id !== groupId);
  }

  peekState(): EditorGroupsState {
    return this.state();
  }
}
