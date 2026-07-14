import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDividerModule } from '@angular/material/divider';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EDITOR_LIMITS, type WordWrapMode } from '@shader-studio/shared/editor-prefs';
import { EditorSettings } from '../../editor/editor-settings';
import { findFont } from '../../editor/google-fonts';

/**
 * The "Type & layout" tab of the editor settings dialog: font size/weight/
 * ligatures and the Monaco layout toggles. Kept on `EditorSettings.preview()`
 * rather than Signal Forms — `effective` is a sanitize-on-write computed, not
 * a plain writable signal, so there is no model to hand a form; wrapping it
 * in one would mean either reworking `EditorSettings` or shadowing its state,
 * neither of which belongs in a split-by-behavior pass.
 */
@Component({
  selector: 'app-type-layout-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonToggleModule,
    MatDividerModule,
    MatFormFieldModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatSliderModule,
    MatTooltipModule,
  ],
  template: `
    <section class="pane" aria-label="Type and layout">
      <h3 class="heading">Type</h3>

      <div class="sliders">
        <label class="field">
          <span class="field-label">
            Size <span class="value">{{ appearance().fontSize }}px</span>
          </span>
          <mat-slider [min]="limits.fontSize.min" [max]="limits.fontSize.max" step="1" discrete>
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
  `,
  styles: `
    mat-form-field {
      width: 100%;
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

    @media (max-width: 900px) {
      .sliders,
      .row,
      .toggles {
        grid-template-columns: 1fr;
      }
    }
  `,
})
export class TypeLayoutPanel {
  protected readonly settings = inject(EditorSettings);

  protected readonly limits = EDITOR_LIMITS;
  protected readonly tabSizes = [2, 4, 8];

  protected readonly wrapModes: readonly { value: WordWrapMode; label: string }[] = [
    { value: 'off', label: 'Off — scroll horizontally' },
    { value: 'on', label: 'On — wrap at the viewport' },
    { value: 'bounded', label: 'Bounded — wrap at the ruler' },
  ];

  protected readonly appearance = this.settings.effective;

  protected readonly weights = computed(
    () => findFont(this.appearance().fontFamily)?.weights ?? [400],
  );

  protected readonly supportsLigatures = computed(
    () => findFont(this.appearance().fontFamily)?.ligatures ?? false,
  );

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
}
