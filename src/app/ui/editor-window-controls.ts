import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EditorWindow } from '../editor/editor-window';
import { Workspace } from './workspace';

/**
 * The window buttons: settings, dock/detach, minimize, maximize, close.
 *
 * A component of its own so that the docked toolbar and the floating title bar
 * are not two hand-copied rows of buttons that drift apart — they are the same
 * row, rendered twice.
 *
 * Every button says what it does and what key does it too, because these are
 * icons and an icon is a rebus until you have learned it.
 */
@Component({
  selector: 'app-editor-window-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatTooltipModule],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      matTooltip="Editor appearance (Ctrl+,)"
      aria-label="Editor appearance"
      aria-haspopup="dialog"
      (click)="workspace.openEditorSettings()"
    >
      <mat-icon>tune</mat-icon>
    </button>

    <!-- Withdrawn rather than disabled on a narrow workspace: there is nowhere
         to drag a window to, and a dead button is just a question you cannot
         answer. -->
    @if (!editorWindow.compact()) {
      <button
        matIconButton
        type="button"
        class="control"
        [matTooltip]="detached() ? 'Dock to the bottom (Ctrl+Shift+D)' : 'Detach the editor (Ctrl+Shift+D)'"
        [attr.aria-label]="detached() ? 'Dock the editor to the bottom' : 'Detach the editor into a floating window'"
        [attr.aria-pressed]="detached()"
        (click)="detached() ? editorWindow.dock() : editorWindow.detach()"
      >
        <mat-icon>{{ detached() ? 'dock_to_bottom' : 'open_in_new' }}</mat-icon>
      </button>
    }

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="editorWindow.minimized() ? 'Expand the editor (Ctrl+Shift+E)' : 'Collapse the editor (Ctrl+Shift+E)'"
      [attr.aria-label]="editorWindow.minimized() ? 'Expand the editor' : 'Collapse the editor'"
      [attr.aria-expanded]="!editorWindow.minimized()"
      (click)="editorWindow.toggleMinimized()"
    >
      <mat-icon>{{ editorWindow.minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="editorWindow.maximized() ? 'Restore the editor (Ctrl+Shift+M)' : 'Maximize the editor (Ctrl+Shift+M)'"
      [attr.aria-label]="editorWindow.maximized() ? 'Restore the editor' : 'Maximize the editor'"
      [attr.aria-pressed]="editorWindow.maximized()"
      (click)="editorWindow.toggleMaximized()"
    >
      <mat-icon>{{ editorWindow.maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      matTooltip="Close the editor (Ctrl+&#96;)"
      aria-label="Close the editor"
      (click)="editorWindow.close()"
    >
      <mat-icon>close</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    /* Denser than a default icon button: this is chrome, not content, and five
       full-size buttons would crowd out the tabs on a narrow panel. */
    .control {
      --mat-icon-button-state-layer-size: 32px;
      --mat-icon-button-icon-size: 18px;
    }
  `,
})
export class EditorWindowControls {
  protected readonly editorWindow = inject(EditorWindow);
  protected readonly workspace = inject(Workspace);

  /**
   * Floating, or in a mode we would come back *to* floating from — so that the
   * dock button keeps saying "dock" while the editor is maximized, rather than
   * flipping to "detach" and lying about what it will do.
   */
  protected readonly detached = computed(
    () =>
      this.editorWindow.floating() ||
      ((this.editorWindow.maximized() || this.editorWindow.minimized()) &&
        this.editorWindow.restoreMode() === 'floating'),
  );
}
