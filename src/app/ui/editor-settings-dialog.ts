import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';

import { CodeEditor } from '../editor/code-editor';
import { EditorSettings } from '../editor/editor-settings';
import { EDITOR_THEMES } from '../editor/editor-themes';
import { FONT_CATALOGUE, FontLoader, SYSTEM_FONT, findFont } from '../editor/google-fonts';
import { EDITOR_LIMITS, fontFamilyStack, type WordWrapMode } from '../core/editor-prefs';
import { Preferences } from '../core/preferences';
import { FontPreview } from './font-preview';

/**
 * The editor's appearance, in a dialog.
 *
 * Everything in here writes to `EditorSettings.preview`, never to `Preferences`.
 * The consequence is worth being precise about: the editor *behind* this dialog
 * is already reading the draft, so every slider is a live preview of the real
 * thing, and the sample below is a preview of the preview. Apply promotes the
 * draft; Cancel — and the backdrop, and Escape — drops it, and there is nothing
 * to roll back because nothing was ever written.
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CodeEditor,
    FontPreview,
    FormsModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatDividerModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatSliderModule,
    MatTabsModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>Editor appearance</h2>

    <mat-dialog-content class="content">
      <mat-tab-group class="tabs" mat-stretch-tabs="false" animationDuration="150ms">
        <!-- --- Font ------------------------------------------------------ -->
        <mat-tab label="Font">
          <section class="pane" aria-label="Font">
            <mat-form-field appearance="outline" class="search" subscriptSizing="dynamic">
              <mat-label>Search fonts</mat-label>
              <mat-icon matPrefix>search</mat-icon>
              <input
                matInput
                type="search"
                autocomplete="off"
                [ngModel]="query()"
                (ngModelChange)="query.set($event)"
              />
            </mat-form-field>

            <!-- A radiogroup, not a listbox: one of these is chosen, and the arrow
                 keys should move between them the way radio buttons do. -->
            <div class="fonts" role="radiogroup" aria-label="Font family">
              @for (font of matches(); track font.family) {
              <button
                type="button"
                class="font"
                role="radio"
                [appFontPreview]="font.family"
                [class.selected]="appearance().fontFamily === font.family"
                [attr.aria-checked]="appearance().fontFamily === font.family"
                (click)="settings.preview({ fontFamily: font.family })"
              >
                <span class="font-head">
                  <span class="font-name" [style.font-family]="stackFor(font.family)">
                    {{ font.family }}
                  </span>

                  @switch (fonts.statusOf(font.family)) {
                    @case ('loading') {
                      <mat-spinner diameter="14" aria-label="Loading the font" />
                    }
                    @case ('error') {
                      <mat-icon
                        class="font-error"
                        matTooltip="This font could not be fetched. The fallback is being used."
                        >cloud_off</mat-icon
                      >
                    }
                  }

                  @if (font.ligatures) {
                    <span class="badge" matTooltip="Has programming ligatures">fi</span>
                  }
                </span>

                <span class="font-note">{{ font.note }}</span>

                <!-- Only meaningful once the face is actually here; until then it
                     would be the fallback pretending to be the font. -->
                @if (fonts.statusOf(font.family) === 'loaded') {
                  <span class="font-sample" [style.font-family]="stackFor(font.family)">
                    vec3 c = mix(a, b, 0.5); // =&gt; !== 0x1F
                  </span>
                }
              </button>
              } @empty {
                <p class="empty">No font matches “{{ query() }}”.</p>
              }
            </div>
          </section>
        </mat-tab>

        <!-- --- Type & layout --------------------------------------------- -->
        <mat-tab label="Type & layout">
          <section class="pane" aria-label="Type and layout">
            <h3 class="heading">Type</h3>

            <div class="sliders">
              <label class="field">
                <span class="field-label">
                  Size <span class="value">{{ appearance().fontSize }}px</span>
                </span>
                <mat-slider
                  [min]="limits.fontSize.min"
                  [max]="limits.fontSize.max"
                  step="1"
                  discrete
                >
                  <input
                    matSliderThumb
                    aria-label="Font size in pixels"
                    [ngModel]="appearance().fontSize"
                    (ngModelChange)="settings.preview({ fontSize: $event })"
                  />
                </mat-slider>
              </label>

              <label class="field">
                <span class="field-label">
                  Line height <span class="value">{{ appearance().lineHeight.toFixed(2) }}×</span>
                </span>
                <mat-slider
                  [min]="limits.lineHeight.min"
                  [max]="limits.lineHeight.max"
                  step="0.05"
                  discrete
                >
                  <input
                    matSliderThumb
                    aria-label="Line height, as a multiple of the font size"
                    [ngModel]="appearance().lineHeight"
                    (ngModelChange)="settings.preview({ lineHeight: $event })"
                  />
                </mat-slider>
              </label>
            </div>

            <div class="row">
              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Weight</mat-label>
                <mat-select
                  [ngModel]="appearance().fontWeight"
                  (ngModelChange)="settings.preview({ fontWeight: $event })"
                >
                  @for (weight of weights(); track weight) {
                    <mat-option [value]="weight">{{ weightLabel(weight) }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>

              <mat-slide-toggle
                class="row-toggle"
                [disabled]="!supportsLigatures()"
                [matTooltip]="
                  supportsLigatures()
                    ? 'Render =&gt;, !== and -&gt; as single glyphs'
                    : appearance().fontFamily + ' has no ligatures to turn on'
                "
                [ngModel]="appearance().ligatures && supportsLigatures()"
                (ngModelChange)="settings.preview({ ligatures: $event })"
              >
                Ligatures
              </mat-slide-toggle>
            </div>

            <mat-divider />

            <h3 class="heading">Layout</h3>

            <div class="row">
              <div class="field">
                <span class="field-label" id="tab-label">Tab size</span>
                <mat-button-toggle-group
                  aria-labelledby="tab-label"
                  [hideSingleSelectionIndicator]="true"
                  [ngModel]="appearance().tabSize"
                  (ngModelChange)="settings.preview({ tabSize: $event })"
                >
                  @for (size of tabSizes; track size) {
                    <mat-button-toggle [value]="size">{{ size }}</mat-button-toggle>
                  }
                </mat-button-toggle-group>
              </div>

              <mat-form-field appearance="outline" subscriptSizing="dynamic">
                <mat-label>Word wrap</mat-label>
                <mat-select
                  [ngModel]="appearance().wordWrap"
                  (ngModelChange)="settings.preview({ wordWrap: $event })"
                >
                  @for (option of wrapModes; track option.value) {
                    <mat-option [value]="option.value">{{ option.label }}</mat-option>
                  }
                </mat-select>
              </mat-form-field>
            </div>

            <mat-form-field appearance="outline" subscriptSizing="dynamic">
              <mat-label>Cursor</mat-label>
              <mat-select
                [ngModel]="appearance().cursorBlinking"
                (ngModelChange)="settings.preview({ cursorBlinking: $event })"
              >
                <mat-option value="blink">Blink</mat-option>
                <mat-option value="smooth">Smooth</mat-option>
                <mat-option value="solid">Solid</mat-option>
              </mat-select>
              <mat-hint>Held solid while your system asks for reduced motion</mat-hint>
            </mat-form-field>

            <div class="toggles">
              <mat-slide-toggle
                [ngModel]="appearance().minimap"
                (ngModelChange)="settings.preview({ minimap: $event })"
              >
                Minimap
              </mat-slide-toggle>
              <mat-slide-toggle
                [ngModel]="appearance().lineNumbers"
                (ngModelChange)="settings.preview({ lineNumbers: $event })"
              >
                Line numbers
              </mat-slide-toggle>
              <mat-slide-toggle
                [ngModel]="appearance().bracketPairs"
                (ngModelChange)="settings.preview({ bracketPairs: $event })"
              >
                Bracket pair colours
              </mat-slide-toggle>
              <mat-slide-toggle
                [ngModel]="appearance().renderWhitespace"
                (ngModelChange)="settings.preview({ renderWhitespace: $event })"
              >
                Show whitespace
              </mat-slide-toggle>
              <mat-slide-toggle
                [ngModel]="appearance().stickyScroll"
                (ngModelChange)="settings.preview({ stickyScroll: $event })"
              >
                Sticky scroll
              </mat-slide-toggle>
            </div>
          </section>
        </mat-tab>

        <!-- --- Theme ------------------------------------------------------ -->
        <mat-tab label="Colour scheme">
          <section class="pane" aria-label="Colour scheme">
          <div class="themes" role="radiogroup" aria-label="Colour scheme">
            <button
              type="button"
              class="theme"
              role="radio"
              [class.selected]="appearance().theme === 'auto'"
              [attr.aria-checked]="appearance().theme === 'auto'"
              (click)="settings.preview({ theme: 'auto' })"
            >
              <span class="swatch swatch-auto" aria-hidden="true">
                <mat-icon>contrast</mat-icon>
              </span>
              <span class="theme-text">
                <span class="theme-name">Match the app</span>
                <span class="theme-note">
                  Follows the studio's {{ preferences.value().colorScheme }} theme
                </span>
              </span>
            </button>

            @for (theme of themes; track theme.id) {
              <button
                type="button"
                class="theme"
                role="radio"
                [class.selected]="appearance().theme === theme.id"
                [attr.aria-checked]="appearance().theme === theme.id"
                (click)="settings.preview({ theme: theme.id })"
              >
                <span
                  class="swatch"
                  aria-hidden="true"
                  [style.background]="theme.palette.background"
                >
                  <i [style.background]="theme.palette.tokens.keyword"></i>
                  <i [style.background]="theme.palette.tokens.type"></i>
                  <i [style.background]="theme.palette.tokens.string"></i>
                </span>
                <span class="theme-text">
                  <span class="theme-name">
                    {{ theme.label }}
                    @if (theme.highContrast) {
                      <span class="badge" matTooltip="Meets WCAG AAA contrast">AAA</span>
                    }
                  </span>
                  <span class="theme-note">{{ theme.description }}</span>
                </span>
              </button>
            }
          </div>
          </section>
        </mat-tab>
      </mat-tab-group>

      <!-- Read-only, and pointedly so: this is a swatch, not a scratchpad. -->
      <app-code-editor
        class="sample"
        language="glsl"
        [readOnly]="true"
        [value]="sample"
        [appearance]="appearance()"
        [colorScheme]="preferences.value().colorScheme"
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

    mat-form-field {
      width: 100%;
    }

    .tabs {
      /* Keep the tab bar pinned while the active pane scrolls beneath it. */
      display: block;
    }

    .pane {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      padding: 16px;
      overflow: hidden;
    }

    .sliders,
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px 20px;
      align-items: end;
    }

    .row-toggle {
      margin-bottom: 8px;
    }

    .heading {
      margin: 0;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface-variant);
    }

    .search {
      width: 100%;
    }

    .fonts,
    .themes {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 330px;
      overflow-y: auto;
      padding: 2px;
    }

    .font,
    .theme {
      display: flex;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      text-align: left;
      cursor: pointer;
      border: 1px solid transparent;
      border-radius: var(--mat-sys-corner-small, 8px);
      background: var(--mat-sys-surface-container-low);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-body-medium);
    }

    .font {
      flex-direction: column;
      gap: 2px;
    }

    .font:hover,
    .theme:hover {
      background: var(--mat-sys-surface-container-high);
    }

    .font:focus-visible,
    .theme:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 1px;
    }

    .font.selected,
    .theme.selected {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .font-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .font-name {
      font-size: 15px;
    }

    .font-note,
    .theme-note {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .font.selected .font-note,
    .theme.selected .theme-note {
      color: inherit;
      opacity: 0.85;
    }

    .font-sample {
      margin-top: 4px;
      font-size: 12px;
      opacity: 0.9;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .font-error {
      font-size: 16px;
      width: 16px;
      height: 16px;
      color: var(--mat-sys-error);
    }

    .badge {
      padding: 0 5px;
      border-radius: 999px;
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
      font: var(--mat-sys-label-small);
    }

    .theme-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .theme-name {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .swatch {
      display: flex;
      flex: 0 0 auto;
      align-items: flex-end;
      gap: 3px;
      width: 40px;
      height: 40px;
      padding: 6px;
      border-radius: var(--mat-sys-corner-extra-small, 4px);
      border: 1px solid var(--mat-sys-outline-variant);
    }

    .swatch i {
      display: block;
      flex: 1;
      height: 60%;
      border-radius: 1px;
    }

    .swatch-auto {
      display: grid;
      place-items: center;
      background: var(--mat-sys-surface-container-highest);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .field-label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
    }

    .value {
      font-variant-numeric: tabular-nums;
      color: var(--mat-sys-primary);
    }

    mat-slider {
      width: 100%;
    }

    .toggles {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 20px;
    }

    .empty {
      margin: 8px 2px;
      color: var(--mat-sys-on-surface-variant);
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
      .fonts,
      .themes {
        max-height: 240px;
      }

      .sliders,
      .row,
      .toggles {
        grid-template-columns: 1fr;
      }

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

  protected readonly limits = EDITOR_LIMITS;
  protected readonly themes = EDITOR_THEMES;
  protected readonly tabSizes = [2, 4, 8];
  protected readonly sample = SAMPLE;

  protected readonly wrapModes: readonly { value: WordWrapMode; label: string }[] = [
    { value: 'off', label: 'Off — scroll horizontally' },
    { value: 'on', label: 'On — wrap at the viewport' },
    { value: 'bounded', label: 'Bounded — wrap at the ruler' },
  ];

  protected readonly appearance = this.settings.effective;

  protected readonly query = signal('');

  protected readonly matches = computed(() => {
    const query = this.query().trim().toLowerCase();
    if (!query) return FONT_CATALOGUE;

    return FONT_CATALOGUE.filter(
      (font) =>
        font.family.toLowerCase().includes(query) || font.note.toLowerCase().includes(query),
    );
  });

  protected readonly weights = computed(
    () => findFont(this.appearance().fontFamily)?.weights ?? [400],
  );

  protected readonly supportsLigatures = computed(
    () => findFont(this.appearance().fontFamily)?.ligatures ?? false,
  );

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

  protected stackFor(family: string): string {
    return family === SYSTEM_FONT ? 'monospace' : fontFamilyStack(family);
  }

  protected weightLabel(weight: number): string {
    const names: Record<number, string> = {
      300: 'Light',
      400: 'Regular',
      500: 'Medium',
      600: 'Semibold',
      700: 'Bold',
    };
    return `${names[weight] ?? weight} (${weight})`;
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
