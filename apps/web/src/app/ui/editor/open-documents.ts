import { computed, inject, Injectable } from '@angular/core';

import { EditorGroups } from './editor-groups';
import type { OpenDocumentsState } from './open-documents-state';

/**
 * Primary-group compatibility facade over `EditorGroups`.
 *
 * Existing shortcuts and panels keep using this service while multi-group UI
 * targets `EditorGroups` directly.
 */
@Injectable({ providedIn: 'root' })
export class OpenDocuments {
  private readonly groups = inject(EditorGroups);

  readonly openIds = computed(() => this.groups.openIds(this.groups.primaryGroupId));
  readonly openDocs = computed(() => this.groups.openDocs(this.groups.primaryGroupId));
  readonly canClose = computed(() => this.groups.canClose(this.groups.primaryGroupId));

  activate(docId: string): void {
    this.groups.activate(docId, this.groups.primaryGroupId);
  }

  close(docId: string): boolean {
    return this.groups.close(docId, this.groups.primaryGroupId);
  }

  closeOthers(docId: string): void {
    this.groups.closeOthers(docId, this.groups.primaryGroupId);
  }

  reorder(sourceId: string, targetId: string): void {
    this.groups.reorder(sourceId, targetId, this.groups.primaryGroupId);
  }

  cycle(step: 1 | -1): void {
    this.groups.cycle(step, this.groups.primaryGroupId);
  }

  peekState(): OpenDocumentsState {
    return this.groups.peekState();
  }
}
