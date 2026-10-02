import { Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';

import type { CaptureSettings } from '@shadergrove/shared/model';
import { Preferences } from '../../prefs/preferences';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ffmpegCommand, planCapture } from '@shadergrove/shared/capture-plan';
import { ShaderCapture } from '../../rendering/shader-capture';

/** The sizes anyone actually exports at. Anything else is typed in. */
const RESOLUTIONS = [
  { label: '1280 × 720', width: 1280, height: 720 },
  { label: '1920 × 1080', width: 1920, height: 1080 },
  { label: '2560 × 1440', width: 2560, height: 1440 },
  { label: '3840 × 2160', width: 3840, height: 2160 },
] as const;

const SUBFRAME_VALUES = [1, 2, 4, 8, 16] as const;
const SUPERSAMPLE_VALUES = [1, 1.5, 2] as const;
const FORMAT_VALUES = ['webm', 'png'] as const;

@Component({
  selector: 'app-export-dialog',
  imports: [
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'export.title' | translate }}</h2>

    <mat-dialog-content>
      @if (capture.running()) {
        <!-- The form is gone rather than disabled: nothing on it can be changed
             now, and a greyed-out copy of it would only invite the attempt. -->
        <div class="running">
          <p class="status">{{ capture.progress()?.label }}</p>
          <mat-progress-bar mode="determinate" [value]="percent()" />
          <p class="hint">{{ 'export.runningHint' | translate }}</p>
        </div>
      } @else {
        <!-- A settings sheet, laid out like the inspector: a name on the left, its
             control on the right, in three short sections. A wrapping label
             names a text field; a select is not labelable, so it points at its
             name instead. -->
        <div class="sheet">
          <h3 class="section">{{ 'export.sectionOutput' | translate }}</h3>

          <div class="row">
            <span class="name" id="export-format">{{ 'export.format' | translate }}</span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-select [formField]="form.format" aria-labelledby="export-format">
                @for (option of formats(); track option.value) {
                  <mat-option [value]="option.value">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>

          <div class="row">
            <span class="name" id="export-resolution">{{ 'export.resolution' | translate }}</span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-select
                aria-labelledby="export-resolution"
                [value]="sizeKey()"
                (selectionChange)="setSize($event.value)"
              >
                @for (option of resolutions; track option.label) {
                  <mat-option [value]="option.label">{{ option.label }}</mat-option>
                }
                <mat-option value="custom">{{ 'export.custom' | translate }}</mat-option>
              </mat-select>
            </mat-form-field>
          </div>

          @if (sizeKey() === 'custom') {
            <label class="row">
              <span class="name">{{ 'export.width' | translate }}</span>
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <input matInput type="number" [formField]="form.width" />
                <span matTextSuffix>px</span>
              </mat-form-field>
            </label>
            <label class="row">
              <span class="name">{{ 'export.height' | translate }}</span>
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <input matInput type="number" [formField]="form.height" />
                <span matTextSuffix>px</span>
              </mat-form-field>
            </label>
          }

          <label class="row">
            <span class="name">{{ 'export.fps' | translate }}</span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <input matInput type="number" [formField]="form.fps" />
            </mat-form-field>
          </label>

          <h3 class="section">{{ 'export.sectionTime' | translate }}</h3>

          <label class="row">
            <span class="name">
              {{ 'export.duration' | translate }}
              <small>{{ 'export.durationHint' | translate }}</small>
            </span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <input matInput type="number" step="0.5" [formField]="form.duration" />
              <span matTextSuffix>s</span>
            </mat-form-field>
          </label>

          <label class="row">
            <span class="name">
              {{ 'export.startAt' | translate }}
              <small>{{ 'export.startAtHint' | translate }}</small>
            </span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <input matInput type="number" step="0.5" [formField]="form.startTime" />
              <span matTextSuffix>s</span>
            </mat-form-field>
          </label>

          <label class="row">
            <span class="name">
              {{ 'export.loops' | translate }}
              <small>{{ 'export.loopsHint' | translate }}</small>
            </span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <input matInput type="number" [formField]="form.loops" />
            </mat-form-field>
          </label>

          <h3 class="section">{{ 'export.sectionQuality' | translate }}</h3>

          <div class="row">
            <span class="name" id="export-motion-blur">
              {{ 'export.motionBlur' | translate }}
              <small>{{ 'export.motionBlurHint' | translate }}</small>
            </span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-select [formField]="form.subframes" aria-labelledby="export-motion-blur">
                @for (option of subframes(); track option.value) {
                  <mat-option [value]="option.value">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>

          <div class="row">
            <span class="name" id="export-supersampling">
              {{ 'export.supersampling' | translate }}
              <small>{{ 'export.supersamplingHint' | translate }}</small>
            </span>
            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-select [formField]="form.supersample" aria-labelledby="export-supersampling">
                @for (option of supersample(); track option.value) {
                  <mat-option [value]="option.value">{{ option.label }}</mat-option>
                }
              </mat-select>
            </mat-form-field>
          </div>
        </div>

        <!-- What was actually asked for, after the numbers were clamped and the
             frame count rounded. The one thing worth reading before committing
             to several minutes of rendering. -->
        <p class="summary">
          <mat-icon aria-hidden="true">{{
            settings().format === 'webm' ? 'movie' : 'photo_library'
          }}</mat-icon>
          <span>{{ summary() }}</span>
        </p>
        @if (settings().format === 'png') {
          <code class="ffmpeg">{{ ffmpeg() }}</code>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      @if (capture.running()) {
        <button matButton type="button" (click)="capture.cancel()">
          {{ 'action.cancel' | translate }}
        </button>
      } @else {
        <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
        <button matButton="filled" type="button" (click)="start()">
          <mat-icon>{{ settings().format === 'webm' ? 'movie' : 'download' }}</mat-icon>
          {{ 'export.title' | translate }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(420px, 80vw);
    }

    /* The fields inside the sheet are the height of a row and carry no label of
       their own, so they take their sizes from the public form-field tokens
       rather than from the global density. */
    .sheet {
      --mat-form-field-container-height: 32px;
      --mat-form-field-container-vertical-padding: 4px;
      --mat-form-field-container-text-size: 13px;
      --mat-form-field-container-text-line-height: 24px;
      --mat-select-trigger-text-size: 13px;
      --mat-select-trigger-text-line-height: 24px;

      display: grid;
      row-gap: 4px;
    }

    .section {
      margin: 10px 0 2px;
      padding-top: 10px;
      border-top: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .section:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }

    .row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 176px;
      align-items: center;
      column-gap: 12px;
      min-height: 36px;
    }

    .name {
      display: flex;
      flex-direction: column;
      gap: 1px;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }

    .name small {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    /* Numbers are values: the mono face, aligned on the right like the inspector's. */
    .row input {
      font-family: var(--studio-font-mono);
      font-variant-numeric: tabular-nums;
      text-align: right;
    }

    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 14px 0 12px;
      padding-top: 12px;
      border-top: 1px solid var(--mat-sys-outline-variant);
      color: var(--mat-sys-on-surface);
      font: 12px / 1.5 var(--studio-font-mono);
    }

    .summary mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      color: var(--mat-sys-primary);
      font-size: 18px;
    }

    .ffmpeg {
      display: block;
      overflow-x: auto;
      padding: 10px 12px;
      border-radius: var(--mat-sys-corner-small, 4px);
      background: var(--mat-sys-surface-container-highest);
      color: var(--mat-sys-on-surface-variant);
      font: 11.5px / 1.5 var(--studio-font-mono);
      white-space: pre;
    }

    .running {
      display: grid;
      gap: 12px;
      padding: 16px 0 8px;
    }

    .status {
      margin: 0;
      font: var(--mat-sys-body-large);
    }

    .hint {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class ExportDialog {
  private readonly dialogRef = inject<MatDialogRef<ExportDialog>>(MatDialogRef);
  private readonly preferences = inject(Preferences);
  private readonly i18n = inject(I18n);
  protected readonly capture = inject(ShaderCapture);

  protected readonly resolutions = RESOLUTIONS;

  protected readonly formats = computed(() =>
    FORMAT_VALUES.map((value) => ({
      value,
      label: this.i18n.t(value === 'webm' ? 'export.formatWebm' : 'export.formatPng'),
    })),
  );

  protected readonly subframes = computed(() =>
    SUBFRAME_VALUES.map((value) => ({
      value,
      label:
        value === 1
          ? this.i18n.t('export.subframesOff')
          : this.i18n.t('export.subframesN', { count: value }),
    })),
  );

  protected readonly supersample = computed(() =>
    SUPERSAMPLE_VALUES.map((value) => ({
      value,
      label: value === 1 ? this.i18n.t('export.supersampleOff') : `${value}×`,
    })),
  );

  protected readonly settings = signal<CaptureSettings>(this.preferences.value().capture);
  protected readonly form = form(this.settings);

  /** The plan the current settings would actually run as — clamped, rounded, made even. */
  private readonly plan = computed(() => planCapture(this.settings()));

  protected readonly sizeKey = computed(() => {
    const { width, height } = this.settings();
    return (
      RESOLUTIONS.find((option) => option.width === width && option.height === height)?.label ??
      'custom'
    );
  });

  protected readonly percent = computed(() => {
    const status = this.capture.progress();
    return status && status.total > 0 ? (status.rendered / status.total) * 100 : 0;
  });

  protected readonly summary = computed(() => {
    const plan = this.plan();
    const size = `${plan.width}×${plan.height}`;
    const rendered =
      plan.renderWidth === plan.width
        ? size
        : `${size} (drawn at ${plan.renderWidth}×${plan.renderHeight})`;
    const draws = plan.draws === plan.loopFrames ? '' : ` · ${plan.draws.toLocaleString()} draws`;
    const kind = plan.settings.format === 'webm' ? 'WebM' : 'PNG';

    return `${kind} · ${plan.outputFrames.toLocaleString()} frames · ${plan.outputDuration.toFixed(1)}s · ${rendered}${draws}`;
  });

  protected readonly ffmpeg = computed(() => ffmpegCommand('shader', this.plan()));

  protected patch(patch: Partial<CaptureSettings>): void {
    this.settings.update((current) => ({ ...current, ...patch }));
  }

  protected setSize(key: string): void {
    const option = RESOLUTIONS.find((entry) => entry.label === key);
    if (option) this.patch({ width: option.width, height: option.height });
  }

  protected async start(): Promise<void> {
    // The plan's settings, not the form's: what is exported is what was shown in
    // the summary, down to the even width the user did not type.
    const settings = this.plan().settings;
    this.preferences.patch({ capture: settings });

    const exported = await this.capture.exportSequence(settings);
    if (exported) this.dialogRef.close();
  }
}
