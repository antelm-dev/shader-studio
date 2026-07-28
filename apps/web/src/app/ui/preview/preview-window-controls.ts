import { Component, computed, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenu, MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { isContainedPlacement } from '@shader-studio/shared/surfaces';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { TranslatePipe } from '../../i18n/translate.pipe';

@Component({
  selector: 'app-preview-window-controls',
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
      [matTooltip]="(minimized() ? 'preview.expand' : 'preview.collapse') | translate"
      [attr.aria-label]="(minimized() ? 'preview.expand' : 'preview.collapse') | translate"
      [attr.aria-expanded]="!minimized()"
      (click)="layout.toggleMinimized(previewId)"
    >
      <mat-icon>{{ minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="(maximized() ? 'preview.restore' : 'preview.maximize') | translate"
      [attr.aria-label]="(maximized() ? 'preview.restore' : 'preview.maximize') | translate"
      [attr.aria-pressed]="maximized()"
      (click)="layout.toggleMaximized(previewId)"
    >
      <mat-icon>{{ maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
    </button>

    <button
      matIconButton
      type="button"
      class="control"
      [matTooltip]="'preview.returnToStage' | translate"
      [attr.aria-label]="'preview.returnToStage' | translate"
      (click)="layout.showOnStage(previewId)"
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
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly previewId = this.layout.previewId;

  readonly menu = input.required<MatMenu>();

  private readonly surface = computed(() => this.layout.preview());

  protected readonly maximized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'maximized';
  });

  protected readonly minimized = computed(() => {
    const placement = this.surface().placement;
    return isContainedPlacement(placement) && placement.mode === 'minimized';
  });
}
