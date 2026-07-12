import { Injectable, computed, inject, signal } from '@angular/core';

import { Preferences } from '../core/preferences';
import {
  DEFAULT_EDITOR_APPEARANCE,
  sanitizeAppearance,
  type EditorAppearance,
} from '../core/editor-prefs';

/**
 * How the editor is dressed, in two layers.
 *
 *  - `committed` is what is persisted, and what the editor wears normally.
 *  - `draft` is what the settings dialog is currently playing with. It exists
 *    only while that dialog is open.
 *
 * `effective` is the draft if there is one and the committed value otherwise,
 * and *everything* — the three tabs, the dialog's own preview — renders from it.
 * That is the whole trick behind the live preview: dragging the font-size slider
 * changes the real editor behind the dialog, because there is only one editor and
 * it is already reading the draft.
 *
 * It is also the whole trick behind cancelling. Nothing is written to
 * `Preferences` until `commit`, so discarding a draft is a single `set(null)` —
 * there is no undo to get wrong, and a cancelled dialog cannot leave a trace in
 * storage because nothing ever put one there.
 */
@Injectable({ providedIn: 'root' })
export class EditorSettings {
  private readonly preferences = inject(Preferences);

  private readonly draft = signal<EditorAppearance | null>(null);

  readonly committed = computed<EditorAppearance>(() => this.preferences.value().editorAppearance);

  readonly effective = computed<EditorAppearance>(() => this.draft() ?? this.committed());

  /** True while a dialog is holding an uncommitted draft. */
  readonly previewing = computed(() => this.draft() !== null);

  /** Whether the draft differs from what is saved — i.e. Apply would do something. */
  readonly changed = computed(() => {
    const draft = this.draft();
    return draft !== null && JSON.stringify(draft) !== JSON.stringify(this.committed());
  });

  /** Start previewing from what is currently saved. */
  beginPreview(): void {
    this.draft.set(this.committed());
  }

  /**
   * Sanitizing on every keystroke rather than only on commit is deliberate: the
   * preview *is* the editor, so an unclamped value would reach Monaco the moment
   * it was typed, not when it was confirmed.
   */
  preview(patch: Partial<EditorAppearance>): void {
    this.draft.set(sanitizeAppearance({ ...this.effective(), ...patch }));
  }

  previewDefaults(): void {
    this.draft.set(DEFAULT_EDITOR_APPEARANCE);
  }

  /** Throw the draft away. The editor snaps back to `committed` on the next tick. */
  cancelPreview(): void {
    this.draft.set(null);
  }

  commit(): void {
    const draft = this.draft();
    if (draft) this.preferences.patch({ editorAppearance: sanitizeAppearance(draft) });
    this.draft.set(null);
  }
}
