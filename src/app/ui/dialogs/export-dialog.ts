import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';

import type { CaptureSettings } from '@shader-studio/shared/model';
import { Preferences } from '../../prefs/preferences';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ffmpegCommand, planCapture } from '@shader-studio/shared/capture-plan';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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
        <div class="grid">
          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.format' | translate }}</mat-label>
            <mat-select [formField]="form.format">
              @for (option of formats(); track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.resolution' | translate }}</mat-label>
            <mat-select [value]="sizeKey()" (selectionChange)="setSize($event.value)">
              @for (option of resolutions; track option.label) {
                <mat-option [value]="option.label">{{ option.label }}</mat-option>
              }
              <mat-option value="custom">{{ 'export.custom' | translate }}</mat-option>
            </mat-select>
          </mat-form-field>

          @if (sizeKey() === 'custom') {
            <mat-form-field appearance="outline">
              <mat-label>{{ 'export.width' | translate }}</mat-label>
              <input matInput type="number" [formField]="form.width" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>{{ 'export.height' | translate }}</mat-label>
              <input matInput type="number" [formField]="form.height" />
            </mat-form-field>
          }

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.fps' | translate }}</mat-label>
            <input matInput type="number" [formField]="form.fps" />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.duration' | translate }}</mat-label>
            <input matInput type="number" step="0.5" [formField]="form.duration" />
            <span matTextSuffix>s</span>
            <mat-hint>{{ 'export.durationHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.startAt' | translate }}</mat-label>
            <input matInput type="number" step="0.5" [formField]="form.startTime" />
            <span matTextSuffix>s</span>
            <mat-hint>{{ 'export.startAtHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.loops' | translate }}</mat-label>
            <input matInput type="number" [formField]="form.loops" />
            <mat-hint>{{ 'export.loopsHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.motionBlur' | translate }}</mat-label>
            <mat-select [formField]="form.subframes">
              @for (option of subframes(); track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'export.motionBlurHint' | translate }}</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>{{ 'export.supersampling' | translate }}</mat-label>
            <mat-select [formField]="form.supersample">
              @for (option of supersample(); track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>{{ 'export.supersamplingHint' | translate }}</mat-hint>
          </mat-form-field>
        </div>

        <!-- What was actually asked for, after the numbers were clamped and the
             frame count rounded. The one thing worth reading before committing
             to several minutes of rendering. -->
        <p class="summary">
          <mat-icon aria-hidden="true">{{ settings().format === 'webm' ? 'movie' : 'photo_library' }}</mat-icon>
          <span>{{ summary() }}</span>
        </p>
        @if (settings().format === 'png') {
          <code class="ffmpeg">{{ ffmpeg() }}</code>
        }
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      @if (capture.running()) {
        <button matButton type="button" (click)="capture.cancel()">{{ 'action.cancel' | translate }}</button>
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
      width: min(560px, 80vw);
    }

    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px 12px;
    }

    .summary {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 4px 0 12px;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }

    .summary mat-icon {
      color: var(--mat-sys-primary);
    }

    .ffmpeg {
      display: block;
      overflow-x: auto;
      padding: 10px 12px;
      border-radius: var(--mat-sys-corner-small, 4px);
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface-variant);
      font-family: ui-monospace, monospace;
      font-size: 12px;
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
