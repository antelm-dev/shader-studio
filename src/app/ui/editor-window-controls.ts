import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EDITOR_DOCK_SIDES, type EditorDockSide } from '@shader-studio/shared/editor-prefs';
import { EditorWindow } from '../editor/editor-window';
import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import type { TranslationKey } from '../i18n/keys';
import { Workspace } from './workspace';

const DOCK_LABELS: Record<EditorDockSide, TranslationKey> = {
  bottom: 'editor.dockBottom',
  left: 'editor.dockLeft',
  right: 'editor.dockRight',
};

const DOCK_ICONS: Record<EditorDockSide, string> = {
  bottom: 'dock_to_bottom',
  left: 'dock_to_left',
  right: 'dock_to_right',
};

@Component({
  selector: 'app-editor-window-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'editor.windowMenu' | translate"
      [attr.aria-label]="'editor.windowMenuAria' | translate"
      [matMenuTriggerFor]="windowMenu"
    >
      <mat-icon>more_vert</mat-icon>
    </button>

    <mat-menu #windowMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>tune</mat-icon>
        <span>{{ 'action.appearance' | translate }}</span>
      </button>
      @if (!editorWindow.compact()) {
        <button mat-menu-item type="button" (click)="editorWindow.detach()">
          <mat-icon>open_in_new</mat-icon>
          <span>{{ 'action.detach' | translate }}</span>
        </button>
      }
      @for (side of dockSides; track side) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="dockedOn(side)"
          (click)="editorWindow.dock(side)"
        >
          <mat-icon>{{ dockIcon(side) }}</mat-icon>
          <span>{{ dockLabel(side) }}</span>
          @if (dockedOn(side)) {
            <mat-icon class="check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(editorWindow.minimized() ? 'editor.expand' : 'editor.collapse') | translate"
      [attr.aria-label]="
        (editorWindow.minimized() ? 'editor.expand' : 'editor.collapse') | translate
      "
      [attr.aria-expanded]="!editorWindow.minimized()"
      (click)="editorWindow.toggleMinimized()"
    >
      <mat-icon>{{ editorWindow.minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(editorWindow.maximized() ? 'editor.restore' : 'editor.maximize') | translate"
      [attr.aria-label]="
        (editorWindow.maximized() ? 'editor.restore' : 'editor.maximize') | translate
      "
      [attr.aria-pressed]="editorWindow.maximized()"
      (click)="editorWindow.toggleMaximized()"
    >
      <mat-icon>{{ editorWindow.maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'editor.close' | translate"
      [attr.aria-label]="'editor.close' | translate"
      (click)="editorWindow.close()"
    >
      <mat-icon>close</mat-icon>
    </button>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 0;
    }

    .control {
      width: 28px;
      height: 28px;
      padding: 5px;
      --mat-icon-button-state-layer-size: 28px;
      --mat-icon-button-icon-size: 16px;
    }

    .check {
      margin-left: auto;
    }
  `,
})
export class EditorWindowControls {
  protected readonly editorWindow = inject(EditorWindow);
  protected readonly workspace = inject(Workspace);
  private readonly i18n = inject(I18n);
  protected readonly dockSides = EDITOR_DOCK_SIDES;

  private readonly activeDockSide = computed(() => {
    if (this.editorWindow.docked()) return this.editorWindow.dockSide();
    if (
      (this.editorWindow.maximized() || this.editorWindow.minimized()) &&
      this.editorWindow.restoreMode() === 'docked'
    ) {
      return this.editorWindow.dockSide();
    }
    return null;
  });

  protected dockedOn(side: EditorDockSide): boolean {
    return this.activeDockSide() === side;
  }

  protected dockLabel(side: EditorDockSide): string {
    return this.i18n.t(DOCK_LABELS[side]);
  }

  protected dockIcon(side: EditorDockSide): string {
    return DOCK_ICONS[side];
  }
}
