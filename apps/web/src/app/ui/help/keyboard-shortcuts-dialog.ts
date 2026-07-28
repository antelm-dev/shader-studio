import { Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

import { TranslatePipe } from '../../i18n/translate.pipe';
import { SHORTCUT_CATALOG } from './shortcut-catalog';

/**
 * Localized Keyboard Shortcuts dialog. Opened by Task 03 from the Help menu;
 * this component only presents the declarative catalog.
 */
@Component({
  selector: 'app-keyboard-shortcuts-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'help.shortcutsTitle' | translate }}</h2>
    <mat-dialog-content>
      <div class="sections">
        @for (section of catalog; track section.id) {
          <section class="section" [attr.aria-labelledby]="sectionHeadingId(section.id)">
            <h3 class="section-title" [id]="sectionHeadingId(section.id)">
              {{ section.titleKey | translate }}
            </h3>
            <ul class="entries">
              @for (entry of section.entries; track entry.id) {
                <li class="entry">
                  <span class="label">{{ entry.labelKey | translate }}</span>
                  <span class="chord" [attr.aria-label]="entry.chord.ariaLabel">
                    @for (key of entry.chord.keys; track $index; let last = $last) {
                      <kbd>{{ key }}</kbd>
                      @if (!last) {
                        <span class="chord-sep" aria-hidden="true">+</span>
                      }
                    }
                  </span>
                </li>
              }
            </ul>
          </section>
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" mat-dialog-close cdkFocusInitial>
        {{ 'action.close' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(480px, 86vw);
      max-height: min(70vh, 560px);
      padding-top: 4px;
    }

    .sections {
      display: grid;
      gap: 20px;
    }

    .section-title {
      margin: 0 0 8px;
      font: var(--mat-sys-title-small);
      color: var(--mat-sys-on-surface);
    }

    .entries {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 2px;
    }

    .entry {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 36px;
      padding: 4px 8px;
      border-radius: var(--mat-sys-corner-small);
    }

    .entry:nth-child(odd) {
      background: color-mix(in srgb, var(--mat-sys-surface-container) 70%, transparent);
    }

    .label {
      min-width: 0;
      font: var(--mat-sys-body-medium);
      color: var(--mat-sys-on-surface);
    }

    .chord {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      gap: 4px;
    }

    .chord-sep {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
    }

    kbd {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 1.6em;
      padding: 2px 7px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 4px;
      background: var(--mat-sys-surface-container-high);
      box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--mat-sys-outline) 35%, transparent);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-medium);
      font-family: ui-monospace, 'Cascadia Code', 'Segoe UI Mono', Consolas, monospace;
      line-height: 1.3;
      white-space: nowrap;
    }
  `,
})
export class KeyboardShortcutsDialog {
  protected readonly catalog = SHORTCUT_CATALOG;

  protected sectionHeadingId(sectionId: string): string {
    return `help-shortcuts-${sectionId}`;
  }
}
