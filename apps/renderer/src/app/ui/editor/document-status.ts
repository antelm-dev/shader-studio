import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';

import { ShaderStore } from '../../workspace/shader-store';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';

/**
 * What the open document is doing, and whether it can be saved.
 *
 * This exists because `!store.dirty() || store.saving() || !store.configValid()`
 * was written out by hand in three templates — the toolbar, the desktop File
 * menu and the editor's own menu — with no explanation attached to any of them.
 * The user was left with a greyed-out Save button and three different places to
 * guess why.
 *
 * So the predicate lives here once, and — more importantly — so does the *reason*.
 * Every disabled Save in the app now points at `saveHint()`, which says which of
 * the four possible reasons is the one in force.
 *
 * Note that errors and the save state are deliberately independent. A GLSL
 * compile error does *not* stop you saving: half-written shaders are the normal
 * state of a shader you are working on, and refusing to save one would lose work.
 * A malformed *config* does, because the controls schema is what the record is
 * built from — there is nothing coherent to write. Only the second one gates
 * `canSave`; both show up in `errorCount`.
 */

export type DocumentState = 'none' | 'saving' | 'unsaved' | 'saved';

const LABEL_KEYS: Record<Exclude<DocumentState, 'none'>, TranslationKey> = {
  saving: 'status.saving',
  unsaved: 'status.unsaved',
  saved: 'status.saved',
};

@Injectable({ providedIn: 'root' })
export class DocumentStatus {
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);
  private readonly savedRecently = signal(false);
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    let wasSaving = false;
    let previousRecordId = this.store.record()?.id ?? null;

    effect(() => {
      const recordId = this.store.record()?.id ?? null;
      const saving = this.store.saving();
      const dirty = this.store.dirty();

      if (recordId !== previousRecordId || dirty) this.hideSavedConfirmation();

      if (wasSaving && !saving && recordId !== null && !dirty) {
        this.savedRecently.set(true);
        this.savedTimer = setTimeout(() => this.savedRecently.set(false), 3_000);
      }

      wasSaving = saving;
      previousRecordId = recordId;
    });

    inject(DestroyRef).onDestroy(() => this.clearSavedTimer());
  }

  readonly state = computed<DocumentState>(() => {
    if (!this.store.record()) return 'none';
    if (this.store.saving()) return 'saving';
    if (this.store.dirty()) return 'unsaved';
    return this.savedRecently() ? 'saved' : 'none';
  });

  readonly label = computed(() => {
    const state = this.state();
    return state === 'none' ? '' : this.i18n.t(LABEL_KEYS[state]);
  });

  /** Compile *and* config errors — everything the editor would flag red. */
  readonly errorCount = computed(
    () => this.store.diagnostics().filter((diagnostic) => diagnostic.severity === 'error').length,
  );

  readonly canSave = computed(
    () => this.store.dirty() && !this.store.saving() && this.store.configValid(),
  );

  /** Why Save is disabled — or, when it is not, what it will do. */
  readonly saveHint = computed(() => {
    if (!this.store.record()) return this.i18n.t('status.openBeforeSave');
    if (this.store.saving()) return this.i18n.t('status.saving');
    if (!this.store.configValid()) return this.i18n.t('status.configErrors');
    if (!this.store.dirty()) return this.i18n.t('status.noChanges');
    return this.i18n.t('status.saveHint');
  });

  readonly errorHint = computed(() => {
    const count = this.errorCount();
    return count === 1
      ? this.i18n.t('status.errorOne')
      : this.i18n.t('status.errorMany', { count });
  });

  private hideSavedConfirmation(): void {
    this.clearSavedTimer();
    this.savedRecently.set(false);
  }

  private clearSavedTimer(): void {
    if (this.savedTimer !== null) clearTimeout(this.savedTimer);
    this.savedTimer = null;
  }
}
