import { Component, computed, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { Preferences } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';

/** The scales worth a click. Anything in between is the System folder's slider. */
const SCALES = [0.5, 0.75, 1, 1.5, 2] as const;

/**
 * What the preview is doing, where you can always see it: running or paused,
 * how fast, and at what size. These were three rows at the bottom of a closed
 * folder in the inspector; a shader that is dropping frames is something you
 * want to notice without going looking.
 *
 * The resolution is the drawing buffer's — the scaled size the shader actually
 * renders at — and clicking it sets the scale, which is the one lever that
 * changes the other two numbers.
 */
@Component({
  selector: 'app-transport-bar',
  imports: [MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <button
      type="button"
      class="cell play"
      [class.paused]="paused()"
      [matTooltip]="(paused() ? 'transport.resume' : 'transport.pause') | translate"
      [attr.aria-label]="(paused() ? 'action.resume' : 'action.pause') | translate"
      (click)="togglePause()"
    >
      <mat-icon aria-hidden="true">{{ paused() ? 'play_arrow' : 'pause' }}</mat-icon>
    </button>

    <span class="cell fps" [matTooltip]="'transport.fps' | translate">
      <span class="value">{{ renderer.fps() }}</span>
      <span class="unit">fps</span>
    </span>

    @if (renderer.resolution(); as size) {
      <button
        type="button"
        class="cell resolution"
        [matTooltip]="'transport.resolution' | translate"
        [attr.aria-label]="
          'transport.resolutionAria'
            | translate: { width: size.width, height: size.height, scale: scale() }
        "
        [matMenuTriggerFor]="scaleMenu"
      >
        <span class="value">{{ size.width }}×{{ size.height }}</span>
        @if (scale() !== 1) {
          <span class="unit">{{ scale() }}×</span>
        }
      </button>
    }

    <mat-menu #scaleMenu="matMenu">
      <div class="menu-section">{{ 'transport.scale' | translate }}</div>
      @for (option of scales; track option) {
        <button
          mat-menu-item
          type="button"
          role="menuitemradio"
          [attr.aria-checked]="option === scale()"
          (click)="setScale(option)"
        >
          <span>{{ option }}×</span>
          @if (option === scale()) {
            <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 1px;
      padding: 2px;
      border-radius: calc(var(--mat-sys-corner-small) + 2px);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 6%, transparent);
    }

    .cell {
      display: inline-flex;
      align-items: baseline;
      justify-content: center;
      gap: 3px;
      height: 24px;
      margin: 0;
      padding: 0 8px;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: transparent;
      color: var(--mat-sys-on-surface);
      font: 11.5px / 24px var(--studio-font-mono);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    button.cell {
      cursor: pointer;
      transition: background-color 140ms ease;
    }

    button.cell:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 9%, transparent);
    }

    button.cell:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .play {
      align-items: center;
      width: 28px;
      padding: 0;
      color: var(--mat-sys-on-surface-variant);
    }

    /* Paused is the state worth noticing: the frame on screen is not moving. */
    .play.paused {
      color: var(--mat-sys-primary);
    }

    .play mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    /* The toolbar decides which readouts fit — see its container queries. */
    .fps {
      display: var(--transport-fps-display, inline-flex);
    }

    .resolution {
      display: var(--transport-resolution-display, inline-flex);
    }

    /* Two digits wide, so 9 and 60 do not shift everything after them. */
    .fps .value {
      min-width: 2ch;
      text-align: right;
    }

    .unit {
      color: var(--mat-sys-on-surface-variant);
      font-size: 10.5px;
    }

    @media (pointer: coarse) {
      .cell {
        height: 28px;
      }

      .play {
        width: 36px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      button.cell {
        transition: none;
      }
    }
  `,
  host: {
    role: 'group',
    '[attr.aria-label]': 'label()',
  },
})
export class TransportBar {
  protected readonly renderer = inject(RendererHandle);
  private readonly preferences = inject(Preferences);
  private readonly i18n = inject(I18n);

  protected readonly label = computed(() => this.i18n.t('transport.label'));
  protected readonly scales = SCALES;
  protected readonly paused = computed(() => this.preferences.value().paused);
  protected readonly scale = computed(() => this.preferences.value().resolutionScale);

  protected togglePause(): void {
    this.preferences.patch({ paused: !this.paused() });
  }

  protected setScale(resolutionScale: number): void {
    this.preferences.patch({ resolutionScale });
  }
}
