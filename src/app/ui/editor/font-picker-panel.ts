import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';

import { fontFamilyStack } from '@shader-studio/shared/editor-prefs';
import { EditorSettings } from '../../editor/editor-settings';
import { FONT_CATALOGUE, FontLoader, SYSTEM_FONT } from '../../editor/google-fonts';
import { FontPreview } from './font-preview';

/**
 * The "Font" tab of the editor settings dialog: search, the font list, and
 * per-font load status. Split out because it is a self-contained UI behavior
 * (search + selection) that does not share state with type/layout or theme.
 */
@Component({
  selector: 'app-font-picker-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FontPreview,
    FormsModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  template: `
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

    .search {
      width: 100%;
    }

    .fonts {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 330px;
      overflow-y: auto;
      padding: 2px;
    }

    .font {
      display: flex;
      flex-direction: column;
      gap: 2px;
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

    .font:hover {
      background: var(--mat-sys-surface-container-high);
    }

    .font:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 1px;
    }

    .font.selected {
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

    .font-note {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .font.selected .font-note {
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

    .empty {
      margin: 8px 2px;
      color: var(--mat-sys-on-surface-variant);
    }

    @media (max-width: 900px) {
      .fonts {
        max-height: 240px;
      }
    }
  `,
})
export class FontPickerPanel {
  protected readonly settings = inject(EditorSettings);
  protected readonly fonts = inject(FontLoader);

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

  protected stackFor(family: string): string {
    return family === SYSTEM_FONT ? 'monospace' : fontFamilyStack(family);
  }
}
