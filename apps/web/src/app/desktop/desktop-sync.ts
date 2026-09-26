import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  SyncChangedEvent,
  SyncRemoveRequest,
  SyncRemoveResult,
  SyncStatus,
} from '@shader-studio/desktop-api/contracts';
import { I18n } from '../i18n/i18n';
import { ShaderStore } from '../workspace/shader-store';

/** Statuses of a shader linked to the signed-in account (also while it needs signing in again). */
const LINKED = new Set<SyncStatus>([
  'synced',
  'pending',
  'syncing',
  'conflict-resolved',
  'reauth-required',
  'error',
]);

/**
 * The account sync status of each local shader, pushed from the main process.
 * Empty on the web and whenever no account is signed in, so nothing renders.
 */
@Injectable({ providedIn: 'root' })
export class DesktopSync {
  readonly statuses = signal<Record<string, SyncStatus>>({});
  readonly progress = signal<SyncChangedEvent['progress']>(null);
  readonly hasLocalOnly = computed(() => Object.values(this.statuses()).includes('local-only'));
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);
  private readonly available = typeof window !== 'undefined' && 'electron' in window;

  constructor() {
    if (!this.available) return;
    const bridge = window.electron.bridge.sync;
    void bridge.statuses().then((event) => this.apply(event));
    bridge.onSyncChanged((event) => this.apply(event));
    window.addEventListener('online', () => void bridge.run());
  }

  upload(ids: string[]): void {
    if (this.available) void window.electron.bridge.sync.upload(ids);
  }

  /** A failed shader: re-uploads it if unlinked (a linked one is skipped), then pushes. */
  retry(id: string): void {
    if (!this.available) return;
    const bridge = window.electron.bridge.sync;
    void bridge.upload([id]).then(() => bridge.run());
  }

  /** Whether deleting it should offer "Delete everywhere"; main has the last word (`not-linked`). */
  isLinked(id: string): boolean {
    return LINKED.has(this.statuses()[id]);
  }

  /** Deletes a linked shader through sync, as the user confirmed it. */
  async remove(request: SyncRemoveRequest): Promise<SyncRemoveResult> {
    return this.available ? window.electron.bridge.sync.remove(request) : 'not-linked';
  }

  uploadAll(): void {
    if (this.available) void window.electron.bridge.sync.uploadAll();
  }

  private apply(event: SyncChangedEvent): void {
    const ended = this.progress() !== null && event.progress === null;
    this.statuses.set(event.statuses);
    this.progress.set(event.progress);
    // A conflict adds a copy and replaces a shader locally: show it.
    if (ended) void this.store.refreshList();
    if (event.replaced?.length) void this.store.reloadReplaced(event.replaced);
    const names = event.notices?.map((notice) => notice.name);
    if (names?.length) {
      const text = this.i18n.t('sync.restoredAfterDelete', { name: names.join(', ') });
      this.store.notice.set({ text, error: false });
    }
  }
}
