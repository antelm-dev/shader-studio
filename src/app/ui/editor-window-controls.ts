import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EditorWindow } from '../editor/editor-window';
import { Workspace } from './workspace';

@Component({
  selector: 'app-editor-window-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      matTooltip="Editor window"
      aria-label="Editor window menu"
      [matMenuTriggerFor]="windowMenu"
    >
      <mat-icon>more_vert</mat-icon>
    </button>

    <mat-menu #windowMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>tune</mat-icon>
        <span>Appearance</span>
      </button>
      @if (!editorWindow.compact()) {
        <button
          mat-menu-item
          type="button"
          (click)="detached() ? editorWindow.dock() : editorWindow.detach()"
        >
          <mat-icon>{{ detached() ? 'dock_to_bottom' : 'open_in_new' }}</mat-icon>
          <span>{{ detached() ? 'Dock to bottom' : 'Detach' }}</span>
        </button>
      }
    </mat-menu>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="editorWindow.minimized() ? 'Expand the editor' : 'Collapse the editor'"
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
      [matTooltip]="editorWindow.maximized() ? 'Restore the editor' : 'Maximize the editor'"
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
      matTooltip="Close the editor"
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

    .control {
      --mat-icon-button-state-layer-size: 32px;
      --mat-icon-button-icon-size: 18px;
    }
  `,
})
export class EditorWindowControls {
  protected readonly editorWindow = inject(EditorWindow);
  protected readonly workspace = inject(Workspace);

  protected readonly detached = computed(
    () =>
      this.editorWindow.floating() ||
      ((this.editorWindow.maximized() || this.editorWindow.minimized()) &&
        this.editorWindow.restoreMode() === 'floating'),
  );
}
