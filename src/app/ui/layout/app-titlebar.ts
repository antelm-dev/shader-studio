import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import {
  COLOR_SCHEME_OPTIONS,
  Preferences,
  colorSchemeIcon,
  type ColorScheme,
} from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { DocumentStatus } from '../editor/document-status';
import { MenuCommands, type MenuCommand } from '../menu-commands';
import { WorkspaceActions } from '../workspace-actions';

@Component({
  selector: 'app-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDividerModule, MatIconModule, MatMenuModule, MatTooltipModule, TranslatePipe],
  template: `
    <header class="titlebar" (dblclick)="onTitlebarDblClick($event)">
      <div class="leading no-drag">
        <nav class="menus" [attr.aria-label]="'menu.application' | translate">
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="fileMenu">
            {{ 'menu.file' | translate }}
          </button>
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="viewMenu">
            {{ 'menu.view' | translate }}
          </button>
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="windowMenu">
            {{ 'menu.window' | translate }}
          </button>
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="helpMenu">
            {{ 'menu.help' | translate }}
          </button>
        </nav>
      </div>

      <div class="title" aria-hidden="true">
        @if (store.record(); as shader) {
          <span class="title-text">{{ shader.name }} — Shader Studio</span>
        } @else {
          <span class="title-text">Shader Studio</span>
        }
      </div>

      <div class="trailing no-drag">
        <button
          class="win-btn"
          type="button"
          [matTooltip]="'action.minimize' | translate"
          [attr.aria-label]="'action.minimize' | translate"
          (click)="desktop.minimize()"
        >
          <mat-icon>remove</mat-icon>
        </button>
        <button
          class="win-btn"
          type="button"
          [matTooltip]="(desktop.maximized() ? 'action.restore' : 'action.maximize') | translate"
          [attr.aria-label]="
            (desktop.maximized() ? 'action.restore' : 'action.maximize') | translate
          "
          (click)="desktop.toggleMaximize()"
        >
          <mat-icon>{{ desktop.maximized() ? 'filter_none' : 'crop_square' }}</mat-icon>
        </button>
        <button
          class="win-btn close"
          type="button"
          [matTooltip]="'action.close' | translate"
          [attr.aria-label]="'action.close' | translate"
          (click)="desktop.close()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
    </header>

    <mat-menu #fileMenu="matMenu">
      @for (item of newCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      @for (item of importExportCommands; track item.id) {
        <button
          mat-menu-item
          type="button"
          [disabled]="item.disabled?.() ?? false"
          (click)="item.action()"
        >
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      <!-- Save carries the tooltip that explains why it is dimmed, so it keeps
           its own markup — see the toolbar's save button. -->
      <button
        mat-menu-item
        type="button"
        [disabled]="!status.canSave()"
        [matTooltip]="status.saveHint()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        <span>{{ (store.saving() ? 'action.saving' : 'action.saveShader') | translate }}</span>
        <span class="menu-hint">Ctrl+S</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>logout</mat-icon>
        <span>{{ 'action.quit' | translate }}</span>
      </button>
    </mat-menu>

    <mat-menu #viewMenu="matMenu">
      @for (item of viewCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
          @if (item.shortcut) {
            <span class="menu-hint">{{ item.shortcut }}</span>
          }
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" [matMenuTriggerFor]="themeMenu">
        <mat-icon>{{ themeIcon() }}</mat-icon>
        <span>{{ 'menu.theme' | translate }}</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>settings</mat-icon>
        <span>{{ 'menu.editorAppearance' | translate }}</span>
      </button>
      <mat-divider />
      @for (item of captureCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
          @if (item.shortcut) {
            <span class="menu-hint">{{ item.shortcut }}</span>
          }
        </button>
      }
    </mat-menu>

    <mat-menu #themeMenu="matMenu">
      @for (option of colorSchemeOptions; track option.value) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="preferences.value().colorScheme === option.value"
          (click)="setColorScheme(option.value)"
        >
          <mat-icon>{{ option.icon }}</mat-icon>
          <span>{{ themeLabel(option.value) }}</span>
          @if (preferences.value().colorScheme === option.value) {
            <mat-icon class="theme-check" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>

    <mat-menu #windowMenu="matMenu">
      @for (item of windowCommands; track item.id) {
        <button mat-menu-item type="button" (click)="item.action()">
          <mat-icon>{{ item.icon() }}</mat-icon>
          <span>{{ item.label() }}</span>
        </button>
      }
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>close</mat-icon>
        <span>{{ 'action.close' | translate }}</span>
      </button>
    </mat-menu>

    <mat-menu #helpMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.openDesktopVersion()">
        <mat-icon>info</mat-icon>
        <span>{{ 'menu.desktopVersion' | translate }}</span>
      </button>
    </mat-menu>
  `,
  styles: `
    :host {
      display: block;
      flex: 0 0 auto;
      pointer-events: auto;
      z-index: 2;
    }

    .titlebar {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      height: 28px;
      padding-inline: 8px 0;
      background: color-mix(in srgb, var(--mat-sys-surface-container) 90%, transparent);
      backdrop-filter: blur(18px);
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      -webkit-app-region: drag;
      user-select: none;
    }

    .leading,
    .trailing {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .leading {
      gap: 2px;
      justify-self: start;
    }

    .trailing {
      justify-self: end;
      height: 100%;
    }

    .no-drag {
      -webkit-app-region: no-drag;
    }

    .menus {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: 8px;
    }

    .menu-trigger {
      margin: 0;
      padding: 2px 6px;
      border: 0;
      border-radius: 0;
      background: transparent;
      font: var(--mat-sys-label-small);
      font-weight: 400;
      letter-spacing: 0.01em;
      color: color-mix(in srgb, var(--mat-sys-on-surface-variant) 72%, transparent);
      cursor: pointer;
      transition: color 120ms ease;

      &:hover,
      &:focus-visible,
      &[aria-expanded='true'] {
        background: transparent;
        color: var(--mat-sys-on-surface);
        outline: none;
      }
    }

    .title {
      justify-self: center;
      max-width: 42vw;
      overflow: hidden;
      pointer-events: none;
    }

    .title-text {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      opacity: 0.85;
    }

    .win-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      cursor: default;

      mat-icon {
        font-size: 14px;
        width: 14px;
        height: 14px;
      }

      &:hover {
        background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
        color: var(--mat-sys-on-surface);
      }

      &.close:hover {
        background: #e81123;
        color: #fff;
      }
    }
  `,
})
export class AppTitlebar {
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);
  protected readonly preferences = inject(Preferences);
  protected readonly status = inject(DocumentStatus);
  protected readonly i18n = inject(I18n);
  private readonly commands = inject(MenuCommands);

  protected readonly colorSchemeOptions = COLOR_SCHEME_OPTIONS;
  protected readonly themeIcon = computed(() =>
    colorSchemeIcon(this.preferences.value().colorScheme),
  );

  // --- Menus --------------------------------------------------------------
  // One group of one menu each — the groups the dividers separate. Save, Quit,
  // Close and the Theme submenu are none of them plain rows, and stay written
  // out above.

  protected readonly newCommands: readonly MenuCommand[] = [this.commands.newShader];

  protected readonly importExportCommands: readonly MenuCommand[] = [
    this.commands.import('rename', 'action.import'),
    this.commands.import('overwrite', 'action.importReplace'),
    this.commands.exportShader,
    this.commands.exportAll,
  ];

  protected readonly viewCommands: readonly MenuCommand[] = [
    {
      id: 'toggle-browser',
      icon: () => 'view_sidebar',
      label: () =>
        this.i18n.t(
          this.preferences.value().browserOpen ? 'action.hideBrowser' : 'action.showBrowser',
        ),
      action: () => this.commands.toggle('browserOpen'),
    },
    {
      id: 'toggle-controls',
      icon: () => 'tune',
      label: () =>
        this.i18n.t(
          this.preferences.value().guiVisible ? 'action.hideControls' : 'action.showControls',
        ),
      shortcut: 'H',
      action: () => this.commands.toggle('guiVisible'),
    },
    this.commands.toggleEditor,
  ];

  protected readonly captureCommands: readonly MenuCommand[] = [
    {
      id: 'screenshot',
      icon: () => 'photo_camera',
      label: () => this.i18n.t('action.screenshot'),
      shortcut: 'S',
      action: () => this.commands.captureImage(),
    },
    this.commands.exportSequence,
    {
      id: 'toggle-fullscreen',
      icon: () => (this.desktop.fullscreen() ? 'fullscreen_exit' : 'fullscreen'),
      label: () =>
        this.i18n.t(this.desktop.fullscreen() ? 'action.exitFullscreen' : 'action.enterFullscreen'),
      shortcut: 'F11',
      action: () => this.desktop.toggleFullscreen(),
    },
  ];

  protected readonly windowCommands: readonly MenuCommand[] = [
    {
      id: 'minimize',
      icon: () => 'remove',
      label: () => this.i18n.t('action.minimize'),
      action: () => this.desktop.minimize(),
    },
    {
      id: 'maximize',
      icon: () => (this.desktop.maximized() ? 'filter_none' : 'crop_square'),
      label: () => this.i18n.t(this.desktop.maximized() ? 'action.restore' : 'action.maximize'),
      action: () => this.desktop.toggleMaximize(),
    },
  ];

  protected themeLabel(theme: ColorScheme): string {
    return this.i18n.t(`theme.${theme}`);
  }

  protected setColorScheme(colorScheme: ColorScheme): void {
    this.preferences.patch({ colorScheme });
  }

  protected onTitlebarDblClick(event: MouseEvent): void {
    if ((event.target as HTMLElement | null)?.closest('.no-drag')) return;
    this.desktop.toggleMaximize();
  }
}
