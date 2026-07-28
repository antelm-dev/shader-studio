import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import {
  closeDocument,
  closeOtherDocuments,
  emptyOpenDocumentsState,
  ensureShaderOpen,
  openDocument,
  openIdsFor,
  pruneOpenDocuments,
  reorderOpenDocument,
  type OpenDocumentsState,
} from './open-documents-state';

/**
 * Session UI state for which editor documents have open tabs.
 *
 * Scoped by shader id. Not persisted. Does not own active selection —
 * `ShaderStore.activeDoc()` stays authoritative; this service only tracks
 * membership/order and asks the store to activate a neighbor on close.
 *
 * Last-tab rule (see `closeDocument`): at least one tab stays open per shader.
 */
@Injectable({ providedIn: 'root' })
export class OpenDocuments {
  private readonly store = inject(ShaderStore);
  private readonly state = signal<OpenDocumentsState>(emptyOpenDocumentsState());

  /** Open document ids for the current shader, in tab order. */
  readonly openIds = computed(() => openIdsFor(this.state(), this.store.selectedId()));

  /** Open documents resolved against the live project list (rename updates labels). */
  readonly openDocs = computed<readonly EditorDocument[]>(() => {
    const byId = new Map(this.store.documents().map((doc) => [doc.id, doc]));
    return this.openIds()
      .map((id) => byId.get(id))
      .filter((doc): doc is EditorDocument => doc !== undefined);
  });

  /** False when only one tab is open — close affordance should be disabled. */
  readonly canClose = computed(() => this.openIds().length > 1);

  constructor() {
    // Any path that activates a document (explorer, Problems, shortcuts, MCP)
    // must ensure its tab is open. Prune stale ids when files/buffers disappear.
    effect(() => {
      const shaderId = this.store.selectedId();
      const documents = this.store.documents();
      const activeId = this.store.activeDoc()?.id ?? null;

      if (!shaderId || !activeId || documents.length === 0) return;

      untracked(() => {
        this.state.update((current) => {
          let next = ensureShaderOpen(current, shaderId, activeId);
          next = openDocument(next, shaderId, activeId);
          const existing = new Set(documents.map((doc) => doc.id));
          const fallback = documents[0]?.id ?? activeId;
          return pruneOpenDocuments(next, shaderId, existing, fallback);
        });
      });
    });
  }

  /** Activate a document and ensure its tab is open (idempotent). */
  activate(docId: string): void {
    const shaderId = this.store.selectedId();
    if (shaderId) {
      this.state.update((current) => openDocument(current, shaderId, docId));
    }
    this.store.selectDoc(docId);
  }

  /**
   * Close a tab. Never deletes the underlying file/pass.
   * When closing the active tab, activates the deterministic neighbor.
   */
  close(docId: string): boolean {
    const shaderId = this.store.selectedId();
    if (!shaderId) return false;

    const activeId = this.store.activeDoc()?.id ?? null;
    const result = closeDocument(this.state(), shaderId, docId);
    if (!result.closed) return false;

    this.state.set(result.state);
    if (activeId === docId && result.nextActiveHint) {
      this.store.selectDoc(result.nextActiveHint);
    }
    return true;
  }

  /** Close every open tab except `docId`, then activate it. */
  closeOthers(docId: string): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;

    this.state.update((current) => closeOtherDocuments(current, shaderId, docId));
    this.store.selectDoc(docId);
  }

  /** Session-only reorder of the open tab strip. */
  reorder(sourceId: string, targetId: string): void {
    const shaderId = this.store.selectedId();
    if (!shaderId) return;
    this.state.update((current) => reorderOpenDocument(current, shaderId, sourceId, targetId));
  }

  /** Cycle among open tabs only (Ctrl+PageUp/PageDown). */
  cycle(step: 1 | -1): void {
    const ids = this.openIds();
    if (ids.length === 0) return;

    const activeId = this.store.activeDoc()?.id ?? null;
    const current = ids.findIndex((id) => id === activeId);
    const index = current < 0 ? 0 : (current + step + ids.length) % ids.length;
    this.activate(ids[index]!);
  }

  /** Snapshot helper for tests. */
  peekState(): OpenDocumentsState {
    return this.state();
  }
}
