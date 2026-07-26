import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';

import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import { FontLoader } from '../../editor/google-fonts';
import { Preferences } from '../../prefs/preferences';
import { FontPickerPanel } from './font-picker-panel';
import { ThemePanel } from './theme-panel';
import { TypeLayoutPanel } from './type-layout-panel';

/**
 * The editor's appearance, in a dialog.
 *
 * Everything in here writes to `EditorSettings.preview`, never to `Preferences`.
 * The consequence is worth being precise about: the editor *behind* this dialog
 * is already reading the draft, so every slider is a live preview of the real
 * thing, and the sample below is a preview of the preview. Apply promotes the
 * draft; Cancel — and the backdrop, and Escape — drops it, and there is nothing
 * to roll back because nothing was ever written.
 *
 * The three tabs — font, type & layout, colour scheme — are independent UI
 * behaviors split into their own components (`FontPickerPanel`,
 * `TypeLayoutPanel`, `ThemePanel`); this shell just owns the dialog lifecycle
 * and the live sample editor underneath them.
 */
const SAMPLE = `// Live preview — the editor behind this dialog is changing too.
precision highp float;

uniform float iTime;
uniform vec2  iResolution;

float sdCircle(vec2 p, float r) {
  return length(p) - r;   /* signed distance */
}

void main() {
  vec2 uv = (gl_FragCoord.xy * 2.0 - iResolution) / iResolution.y;
  float d = sdCircle(uv, 0.6 + 0.1 * sin(iTime));
  vec3  c = mix(vec3(0.1, 0.7, 0.9), vec3(0.9, 0.2, 0.5), smoothstep(0.0, 1.0, uv.y));
  gl_FragColor = vec4(c * (1.0 - step(0.0, d)), 1.0);
}
`;

@Component({
  selector: 'app-editor-settings-dialog',
  imports: [
    CodeEditor,
    FontPickerPanel,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatTabsModule,
    ThemePanel,
    TypeLayoutPanel,
  ],
  template: `
    <h2 mat-dialog-title>Editor appearance</h2>

    <mat-dialog-content class="content">
      <mat-tab-group class="tabs" mat-stretch-tabs="false" animationDuration="150ms">
        <mat-tab label="Font">
          <app-font-picker-panel />
        </mat-tab>
        <mat-tab label="Type & layout">
          <app-type-layout-panel />
        </mat-tab>
        <mat-tab label="Colour scheme">
          <app-theme-panel />
        </mat-tab>
      </mat-tab-group>

      <!-- Read-only, and pointedly so: this is a swatch, not a scratchpad. -->
      <app-code-editor
        class="sample"
        [doc]="sample"
        [readOnly]="true"
        [appearance]="appearance()"
        [colorScheme]="preferences.resolved()"
      />
    </mat-dialog-content>

    <mat-dialog-actions class="actions">
      <button matButton="outlined" type="button" (click)="restoreDefaults()">
        <mat-icon>restart_alt</mat-icon>
        Restore defaults
      </button>

      <span class="spacer"></span>

      <button matButton type="button" (click)="cancel()">Cancel</button>
      <button
        matButton="filled"
        cdkFocusInitial
        type="button"
        [disabled]="!settings.changed()"
        (click)="apply()"
      >
        Apply
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .content {
      width: min(680px, 92vw);
      max-height: 88dvh;
      overflow-x: hidden;
    }

    .tabs {
      /* Keep the tab bar pinned while the active pane scrolls beneath it. */
      display: block;
    }

    .sample {
      height: 200px;
      margin-top: 20px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small, 8px);
      overflow: hidden;
    }

    .actions {
      padding: 8px 24px 16px;
    }

    .spacer {
      flex: 1;
    }

    @media (max-width: 900px) {
      .sample {
        height: 140px;
      }
    }
  `,
})
export class EditorSettingsDialog {
  private readonly dialogRef = inject<MatDialogRef<EditorSettingsDialog>>(MatDialogRef);

  protected readonly settings = inject(EditorSettings);
  protected readonly fonts = inject(FontLoader);
  protected readonly preferences = inject(Preferences);

  /** A document of its own, so the preview's model never collides with a real file's. */
  protected readonly sample: EditorDoc = {
    id: '@appearance-sample',
    language: 'glsl',
    value: SAMPLE,
  };

  protected readonly appearance = this.settings.effective;

  constructor() {
    this.settings.beginPreview();

    // Escape and the backdrop close the dialog without going through `cancel`.
    // Dropping the draft here rather than in the button handler is what makes
    // *every* way out of this dialog leave no trace.
    this.dialogRef.afterClosed().subscribe(() => this.settings.cancelPreview());

    // The font in use when the dialog opens is the one thing that must preview
    // immediately; the rest are fetched as their rows scroll into view.
    void this.fonts.load(this.settings.committed().fontFamily);
  }

  /**
   * Defaults are previewed, not applied. Someone who clicks this to see what the
   * defaults look like and then cancels should end up exactly where they started.
   */
  protected restoreDefaults(): void {
    this.settings.previewDefaults();
  }

  protected apply(): void {
    this.settings.commit();
    this.dialogRef.close(true);
  }

  protected cancel(): void {
    this.dialogRef.close(false);
  }
}
