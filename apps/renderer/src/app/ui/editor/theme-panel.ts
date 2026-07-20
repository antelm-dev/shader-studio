import { Component, inject } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { EditorSettings } from '../../editor/editor-settings';
import { EDITOR_THEMES } from '../../editor/editor-themes';
import { Preferences } from '../../prefs/preferences';

/**
 * The "Colour scheme" tab of the editor settings dialog: the theme swatch
 * grid, including the "match the app" option. Split out because picking a
 * theme shares nothing with the font search or the type/layout form beyond
 * `EditorSettings.preview()`.
 */
@Component({
  selector: 'app-theme-panel',
  imports: [MatIconModule, MatTooltipModule],
  template: `
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
            <span class="theme-note"> Follows the studio's {{ preferences.resolved() }} theme </span>
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
            <span class="swatch" aria-hidden="true" [style.background]="theme.palette.background">
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
  `,
  styles: `
    .pane {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      padding: 16px;
      overflow: hidden;
    }

    .themes {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 330px;
      overflow-y: auto;
      padding: 2px;
    }

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

    .theme:hover {
      background: var(--mat-sys-surface-container-high);
    }

    .theme:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: 1px;
    }

    .theme.selected {
      border-color: var(--mat-sys-primary);
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .theme-note {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .theme.selected .theme-note {
      color: inherit;
      opacity: 0.85;
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

    @media (max-width: 900px) {
      .themes {
        max-height: 240px;
      }
    }
  `,
})
export class ThemePanel {
  protected readonly settings = inject(EditorSettings);
  protected readonly preferences = inject(Preferences);

  protected readonly themes = EDITOR_THEMES;
  protected readonly appearance = this.settings.effective;
}
