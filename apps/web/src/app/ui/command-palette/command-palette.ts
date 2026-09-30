import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';

import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { ShaderStore } from '../../workspace/shader-store';
import type { MenuCommand } from '../menu-commands';
import { WorkspaceActions } from '../workspace-actions';
import { searchPalette, type PaletteItem } from './palette-search';

/** The commands to offer, under the headings the menus already use. */
export interface CommandPaletteData {
  readonly groups: readonly { readonly label: string; readonly commands: readonly MenuCommand[] }[];
}

/**
 * Every command, and every shader, one search away.
 *
 * The menus stay as they are — this is the same `MenuCommand`s under the same
 * headings — but a menu makes you remember where a command lives, and this
 * only asks what it is called. Shaders are listed after the commands, so the
 * palette doubles as "go to shader".
 *
 * It is the combobox-with-listbox pattern: focus never leaves the field, the
 * arrow keys move `aria-activedescendant` through the options, Enter runs the
 * active one and Escape closes (the dialog's own).
 */
@Component({
  selector: 'app-command-palette',
  imports: [MatIconModule, TranslatePipe],
  template: `
    <div class="field">
      <mat-icon aria-hidden="true">search</mat-icon>
      <input
        #input
        type="text"
        class="input"
        role="combobox"
        autocomplete="off"
        spellcheck="false"
        aria-expanded="true"
        aria-autocomplete="list"
        aria-controls="command-palette-list"
        [attr.aria-activedescendant]="activeId()"
        [attr.aria-label]="'palette.title' | translate"
        [placeholder]="'palette.placeholder' | translate"
        [value]="query()"
        (input)="setQuery(input.value)"
        (keydown)="onKeydown($event)"
      />
      <kbd aria-hidden="true">Esc</kbd>
    </div>

    <div
      #list
      class="list"
      id="command-palette-list"
      role="listbox"
      [attr.aria-label]="'palette.title' | translate"
    >
      @for (item of results(); track item.id; let index = $index) {
        @if (heading(index); as title) {
          <div class="heading" role="presentation">{{ title }}</div>
        }
        <div
          class="option"
          role="option"
          [id]="'command-palette-option-' + index"
          [class.active]="index === active()"
          [attr.aria-selected]="index === active()"
          [attr.aria-disabled]="item.disabled ? 'true' : null"
          (pointermove)="active.set(index)"
          (click)="run(item)"
        >
          <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
          <span class="label">{{ item.label }}</span>
          @if (item.shortcut) {
            <kbd>{{ item.shortcut }}</kbd>
          }
        </div>
      } @empty {
        <p class="empty">{{ 'palette.empty' | translate }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      max-height: min(440px, 70vh);
      color: var(--mat-sys-on-surface);
    }

    .field {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 10px;
      padding: 0 14px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
    }

    .field mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      color: var(--mat-sys-on-surface-variant);
      font-size: 18px;
    }

    .input {
      flex: 1;
      min-width: 0;
      height: 44px;
      padding: 0;
      border: 0;
      outline: none;
      background: transparent;
      color: inherit;
      font: var(--mat-sys-body-large);
    }

    .input::placeholder {
      color: var(--mat-sys-on-surface-variant);
    }

    kbd {
      flex: 0 0 auto;
      padding: 1px 5px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 3px;
      color: var(--mat-sys-on-surface-variant);
      font: 10.5px / 1.4 var(--studio-font-mono);
    }

    .list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 4px 6px 6px;
    }

    .heading {
      padding: 8px 8px 3px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-small);
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .option {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 32px;
      padding: 0 8px;
      border-radius: var(--mat-sys-corner-small);
      font: var(--mat-sys-body-medium);
      cursor: pointer;
    }

    .option mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      color: var(--mat-sys-on-surface-variant);
      font-size: 18px;
    }

    .option.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .option[aria-disabled='true'] {
      opacity: 0.45;
      cursor: default;
    }

    .label {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty {
      margin: 0;
      padding: 16px 8px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    @media (pointer: coarse) {
      .option {
        min-height: 44px;
      }
    }
  `,
})
export class CommandPalette {
  private readonly dialogRef = inject(MatDialogRef<CommandPalette>);
  private readonly data = inject<CommandPaletteData>(MAT_DIALOG_DATA);
  private readonly store = inject(ShaderStore);
  private readonly workspace = inject(WorkspaceActions);
  private readonly i18n = inject(I18n);

  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  /**
   * Read once, when the palette opens: a label such as "Hide inspector" names
   * the state at that moment, and the palette is gone as soon as one is run.
   */
  private readonly items: readonly PaletteItem[] = [
    ...this.data.groups.flatMap(({ label, commands }) =>
      commands.map(
        (command): PaletteItem => ({
          id: `command:${label}:${command.id}`,
          icon: command.icon(),
          label: command.label(),
          group: label,
          shortcut: command.shortcut,
          disabled: command.disabled?.() ?? false,
          run: command.action,
        }),
      ),
    ),
    ...this.store.shaders().map(
      (shader): PaletteItem => ({
        id: `shader:${shader.id}`,
        icon: shader.id === this.store.selectedId() ? 'radio_button_checked' : 'blur_on',
        label: shader.name,
        group: this.i18n.t('browser.title'),
        run: () => void this.workspace.selectShader(shader.id),
      }),
    ),
  ];

  protected readonly query = signal('');
  protected readonly results = computed(() => searchPalette(this.items, this.query()));
  protected readonly active = signal(0);
  protected readonly activeId = computed(() =>
    this.results().length ? `command-palette-option-${this.active()}` : null,
  );

  /** A heading goes above the first row of each group — only while browsing, not searching. */
  protected heading(index: number): string | null {
    if (this.query().trim()) return null;
    const results = this.results();
    return index === 0 || results[index - 1].group !== results[index].group
      ? results[index].group
      : null;
  }

  protected setQuery(query: string): void {
    this.query.set(query);
    this.active.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const count = this.results().length;
    switch (event.key) {
      case 'ArrowDown':
        this.move((this.active() + 1) % Math.max(count, 1));
        break;
      case 'ArrowUp':
        this.move((this.active() - 1 + count) % Math.max(count, 1));
        break;
      case 'Home':
        this.move(0);
        break;
      case 'End':
        this.move(Math.max(count - 1, 0));
        break;
      case 'Enter': {
        const item = this.results()[this.active()];
        if (item) this.run(item);
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  protected run(item: PaletteItem): void {
    if (item.disabled) return;
    // Closed first: a command that opens a dialog of its own should find the
    // palette already out of the way, and take the focus it gives back.
    this.dialogRef.close();
    item.run();
  }

  private move(index: number): void {
    this.active.set(index);
    // The rows are not focusable — focus stays in the field — so the list has
    // to be scrolled by hand to keep the active one in view.
    this.list()
      .nativeElement.querySelector(`#command-palette-option-${index}`)
      ?.scrollIntoView({ block: 'nearest' });
  }
}
