import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';

import type { CaptureSettings } from '@shader-studio/shared/model';
import { Preferences } from '../core/preferences';
import { ffmpegCommand, planCapture } from '../rendering/capture-plan';
import { ShaderCapture } from '../rendering/shader-capture';

/** The sizes anyone actually exports at. Anything else is typed in. */
const RESOLUTIONS = [
  { label: '1280 × 720', width: 1280, height: 720 },
  { label: '1920 × 1080', width: 1920, height: 1080 },
  { label: '2560 × 1440', width: 2560, height: 1440 },
  { label: '3840 × 2160', width: 3840, height: 2160 },
] as const;

const SUBFRAMES = [
  { label: 'Off', value: 1 },
  { label: '2 samples', value: 2 },
  { label: '4 samples', value: 4 },
  { label: '8 samples', value: 8 },
  { label: '16 samples', value: 16 },
] as const;

const SUPERSAMPLE = [
  { label: 'Off', value: 1 },
  { label: '1.5×', value: 1.5 },
  { label: '2×', value: 2 },
] as const;

const FORMATS = [
  { label: 'WebM video', value: 'webm' as const },
  { label: 'PNG sequence', value: 'png' as const },
] as const;

@Component({
  selector: 'app-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Export</h2>

    <mat-dialog-content>
      @if (capture.running()) {
        <!-- The form is gone rather than disabled: nothing on it can be changed
             now, and a greyed-out copy of it would only invite the attempt. -->
        <div class="running">
          <p class="status">{{ capture.progress()?.label }}</p>
          <mat-progress-bar mode="determinate" [value]="percent()" />
          <p class="hint">
            The preview is frozen while the shader is filmed — it is drawing the
            export, not the window.
          </p>
        </div>
      } @else {
        <div class="grid">
          <mat-form-field appearance="outline">
            <mat-label>Format</mat-label>
            <mat-select
              [ngModel]="settings().format"
              (ngModelChange)="patch({ format: $event })"
            >
              @for (option of formats; track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Resolution</mat-label>
            <mat-select [ngModel]="sizeKey()" (ngModelChange)="setSize($event)">
              @for (option of resolutions; track option.label) {
                <mat-option [value]="option.label">{{ option.label }}</mat-option>
              }
              <mat-option value="custom">Custom…</mat-option>
            </mat-select>
          </mat-form-field>

          @if (sizeKey() === 'custom') {
            <mat-form-field appearance="outline">
              <mat-label>Width</mat-label>
              <input
                matInput
                type="number"
                [ngModel]="settings().width"
                (ngModelChange)="patch({ width: +$event })"
              />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Height</mat-label>
              <input
                matInput
                type="number"
                [ngModel]="settings().height"
                (ngModelChange)="patch({ height: +$event })"
              />
            </mat-form-field>
          }

          <mat-form-field appearance="outline">
            <mat-label>Frames per second</mat-label>
            <input
              matInput
              type="number"
              [ngModel]="settings().fps"
              (ngModelChange)="patch({ fps: +$event })"
            />
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Duration</mat-label>
            <input
              matInput
              type="number"
              step="0.5"
              [ngModel]="settings().duration"
              (ngModelChange)="patch({ duration: +$event })"
            />
            <span matTextSuffix>s</span>
            <mat-hint>One pass of the loop</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Start at</mat-label>
            <input
              matInput
              type="number"
              step="0.5"
              [ngModel]="settings().startTime"
              (ngModelChange)="patch({ startTime: +$event })"
            />
            <span matTextSuffix>s</span>
            <mat-hint>Where the shader has settled</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Loops</mat-label>
            <input
              matInput
              type="number"
              [ngModel]="settings().loops"
              (ngModelChange)="patch({ loops: +$event })"
            />
            <mat-hint>Repeated, not re-rendered</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Motion blur</mat-label>
            <mat-select
              [ngModel]="settings().subframes"
              (ngModelChange)="patch({ subframes: +$event })"
            >
              @for (option of subframes; track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>Costs one draw per sample</mat-hint>
          </mat-form-field>

          <mat-form-field appearance="outline">
            <mat-label>Supersampling</mat-label>
            <mat-select
              [ngModel]="settings().supersample"
              (ngModelChange)="patch({ supersample: +$event })"
            >
              @for (option of supersample; track option.value) {
                <mat-option [value]="option.value">{{ option.label }}</mat-option>
              }
            </mat-select>
            <mat-hint>Renders larger, then downsamples</mat-hint>
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
        <button matButton type="button" (click)="capture.cancel()">Cancel</button>
      } @else {
        <button matButton mat-dialog-close type="button">Close</button>
        <button matButton="filled" type="button" (click)="start()">
          <mat-icon>{{ settings().format === 'webm' ? 'movie' : 'download' }}</mat-icon>
          Export
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
  protected readonly capture = inject(ShaderCapture);

  protected readonly resolutions = RESOLUTIONS;
  protected readonly subframes = SUBFRAMES;
  protected readonly supersample = SUPERSAMPLE;
  protected readonly formats = FORMATS;

  protected readonly settings = signal<CaptureSettings>(this.preferences.value().capture);

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
