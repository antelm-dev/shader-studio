import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenu, MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { PreviewWindow } from '../../rendering/preview-window';
import { TranslatePipe } from '../../i18n/translate.pipe';

/**
 * The preview title bar's controls: the same buttons, the same metrics and the
 * same order as `EditorWindowControls`, minus the ones the preview has no
 * business having.
 *
 * There is no close button. Closing the preview would hide the only thing the
 * app is for, and leave nothing on screen to bring it back — "return to stage"
 * is what takes its place, and it is the one control here the editor has no
 * equivalent of.
 *
 * The menu is passed in rather than built here: it is the *same* menu the canvas
 * opens on right-click, defined once in `PreviewShell`, so the two can never
 * drift apart.
 */
@Component({
  selector: 'app-preview-window-controls',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'preview.windowMenu' | translate"
      [attr.aria-label]="'preview.windowMenuAria' | translate"
      [matMenuTriggerFor]="menu()"
    >
      <mat-icon>more_vert</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(preview.minimized() ? 'preview.expand' : 'preview.collapse') | translate"
      [attr.aria-label]="(preview.minimized() ? 'preview.expand' : 'preview.collapse') | translate"
      [attr.aria-expanded]="!preview.minimized()"
      (click)="preview.toggleMinimized()"
    >
      <mat-icon>{{ preview.minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(preview.maximized() ? 'preview.restore' : 'preview.maximize') | translate"
      [attr.aria-label]="(preview.maximized() ? 'preview.restore' : 'preview.maximize') | translate"
      [attr.aria-pressed]="preview.maximized()"
      (click)="preview.toggleMaximized()"
    >
      <mat-icon>{{ preview.maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'preview.returnToStage' | translate"
      [attr.aria-label]="'preview.returnToStage' | translate"
      (click)="preview.showOnStage()"
    >
      <mat-icon>wallpaper</mat-icon>
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
  `,
})
export class PreviewWindowControls {
  protected readonly preview = inject(PreviewWindow);

  /** The preview's command menu, owned by the shell and shared with the canvas. */
  readonly menu = input.required<MatMenu>();
}
