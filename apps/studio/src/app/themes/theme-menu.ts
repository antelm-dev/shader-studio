import { Component, inject, viewChild } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenu, MatMenuModule } from '@angular/material/menu';

import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import { COLOR_SCHEME_OPTIONS, type ColorScheme } from '../prefs/preferences';
import { AppThemes } from './app-themes';

/**
 * The Theme submenu: the built-in theme in light, dark or system, then every
 * theme of the active plugins, each with a swatch of its own colours. One menu
 * for every place that offers it — the web's More menu, the desktop title bar
 * and the preview's — so the choice is the same everywhere.
 *
 * Opened from a parent menu's item with `[matMenuTriggerFor]="themes.menu()"`.
 * Its rows are `menuitemradio`s: arrow keys move between them and the checked
 * one is announced.
 */
@Component({
  selector: 'app-theme-menu',
  exportAs: 'appThemeMenu',
  imports: [MatDividerModule, MatIconModule, MatMenuModule, TranslatePipe],
  template: `
    <mat-menu #menu="matMenu">
      @for (option of builtinOptions; track option.value) {
        @let checked = themes.isBuiltinSelected(option.value);
        <button
          mat-menu-item
          type="button"
          role="menuitemradio"
          [attr.aria-checked]="checked"
          [attr.data-testid]="'theme-option-' + option.value"
          (click)="themes.selectBuiltin(option.value)"
        >
          <mat-icon>{{ option.icon }}</mat-icon>
          <span>{{ label(option.value) }}</span>
          @if (checked) {
            <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }

      @if (themes.entries().length > 0) {
        <mat-divider />
        <p class="section" aria-hidden="true">{{ 'theme.installed' | translate }}</p>
        @for (entry of themes.entries(); track entry.ref) {
          @let checked = themes.isPluginSelected(entry.ref);
          <button
            mat-menu-item
            type="button"
            role="menuitemradio"
            [attr.aria-checked]="checked"
            [attr.data-testid]="'theme-option-' + entry.ref"
            (click)="themes.selectPlugin(entry.ref)"
          >
            <span class="swatch" aria-hidden="true" [style.background]="entry.theme.ui.background">
              <i [style.background]="entry.theme.ui['surface-container-high']"></i>
              <i [style.background]="entry.theme.ui.primary"></i>
            </span>
            <span class="label">
              <span>{{ entry.theme.name }}</span>
              <span class="by">{{ entry.packageName }}</span>
            </span>
            @if (checked) {
              <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
            }
          </button>
        }
      }
    </mat-menu>
  `,
  styles: `
    /* The menu renders in an overlay; the host is only where it is declared. */
    :host {
      display: none;
    }

    .section {
      margin: 0;
      padding: 6px 16px 2px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    .swatch {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: flex-end;
      gap: 2px;
      width: 18px;
      height: 18px;
      margin-right: 12px;
      padding: 3px;
      box-sizing: border-box;
      vertical-align: middle;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 3px;
    }

    .swatch i {
      flex: 1;
      height: 60%;
      border-radius: 1px;
    }

    .label {
      display: inline-flex;
      flex-direction: column;
      vertical-align: middle;
      line-height: 1.2;
    }

    .by {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }
  `,
})
export class ThemeMenu {
  protected readonly themes = inject(AppThemes);
  private readonly i18n = inject(I18n);
  protected readonly builtinOptions = COLOR_SCHEME_OPTIONS;

  readonly menu = viewChild.required(MatMenu);

  protected label(scheme: ColorScheme): string {
    return this.i18n.t(`theme.${scheme}`);
  }
}
