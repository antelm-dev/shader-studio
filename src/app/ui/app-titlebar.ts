import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';

import { DesktopPlatform } from '../core/desktop-platform';
import { Preferences, type WorkspacePreferences } from '../core/preferences';
import { ShaderStore } from '../core/shader-store';
import { RendererHandle } from '../rendering/renderer-handle';
import { Workspace } from './workspace';

@Component({
  selector: 'app-titlebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatDividerModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <header class="titlebar" (dblclick)="onTitlebarDblClick($event)">
      <div class="leading no-drag">
        <img class="logo" src="shader-studio-logo.png" alt="" width="18" height="18" />

        <nav class="menus" aria-label="Application menu">
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="fileMenu">File</button>
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="viewMenu">View</button>
          <button type="button" class="menu-trigger" [matMenuTriggerFor]="windowMenu">Window</button>
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
          matTooltip="Minimize"
          aria-label="Minimize"
          (click)="desktop.minimize()"
        >
          <mat-icon>remove</mat-icon>
        </button>
        <button
          class="win-btn"
          type="button"
          [matTooltip]="maximized() ? 'Restore' : 'Maximize'"
          [attr.aria-label]="maximized() ? 'Restore' : 'Maximize'"
          (click)="desktop.toggleMaximize()"
        >
          <mat-icon>{{ maximized() ? 'filter_none' : 'crop_square' }}</mat-icon>
        </button>
        <button
          class="win-btn close"
          type="button"
          matTooltip="Close"
          aria-label="Close"
          (click)="desktop.close()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </div>
    </header>

    <mat-menu #fileMenu="matMenu">
      <button mat-menu-item type="button" (click)="workspace.createShader()">
        <mat-icon>add</mat-icon>
        <span>New shader…</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="workspace.importDesktop('rename')">
        <mat-icon>upload</mat-icon>
        <span>Import…</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.importDesktop('overwrite')">
        <mat-icon>upload_file</mat-icon>
        <span>Import and replace…</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.record()"
        (click)="exportCurrent()"
      >
        <mat-icon>download</mat-icon>
        <span>Export this shader</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.exportAll()">
        <mat-icon>library_books</mat-icon>
        <span>Export all shaders</span>
      </button>
      <mat-divider />
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.dirty() || store.saving() || !store.configValid()"
        (click)="store.save()"
      >
        <mat-icon>save</mat-icon>
        <span>Save</span>
        <span class="menu-hint">Ctrl+S</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>logout</mat-icon>
        <span>Quit</span>
      </button>
    </mat-menu>

    <mat-menu #viewMenu="matMenu">
      <button mat-menu-item type="button" (click)="toggle('browserOpen')">
        <mat-icon>view_sidebar</mat-icon>
        <span>{{ preferences.value().browserOpen ? 'Hide browser' : 'Show browser' }}</span>
      </button>
      <button mat-menu-item type="button" (click)="toggle('guiVisible')">
        <mat-icon>tune</mat-icon>
        <span>{{ preferences.value().guiVisible ? 'Hide controls' : 'Show controls' }}</span>
        <span class="menu-hint">H</span>
      </button>
      <button mat-menu-item type="button" (click)="toggle('editorOpen')">
        <mat-icon>code</mat-icon>
        <span>{{ preferences.value().editorOpen ? 'Hide editor' : 'Show editor' }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="toggleColorScheme()">
        <mat-icon>{{ darkMode() ? 'light_mode' : 'dark_mode' }}</mat-icon>
        <span>{{ darkMode() ? 'Light theme' : 'Dark theme' }}</span>
      </button>
      <button mat-menu-item type="button" (click)="workspace.openEditorSettings()">
        <mat-icon>settings</mat-icon>
        <span>Editor appearance…</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="takeScreenshot()">
        <mat-icon>photo_camera</mat-icon>
        <span>Screenshot</span>
        <span class="menu-hint">S</span>
      </button>
      <button mat-menu-item type="button" (click)="desktop.toggleFullscreen()">
        <mat-icon>{{ fullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
        <span>{{ fullscreen() ? 'Exit fullscreen' : 'Enter fullscreen' }}</span>
      </button>
    </mat-menu>

    <mat-menu #windowMenu="matMenu">
      <button mat-menu-item type="button" (click)="desktop.minimize()">
        <mat-icon>remove</mat-icon>
        <span>Minimize</span>
      </button>
      <button mat-menu-item type="button" (click)="desktop.toggleMaximize()">
        <mat-icon>{{ maximized() ? 'filter_none' : 'crop_square' }}</mat-icon>
        <span>{{ maximized() ? 'Restore' : 'Maximize' }}</span>
      </button>
      <mat-divider />
      <button mat-menu-item type="button" (click)="desktop.close()">
        <mat-icon>close</mat-icon>
        <span>Close</span>
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
      height: 36px;
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

    .logo {
      width: 18px;
      height: 18px;
      margin-inline: 6px 4px;
      border-radius: 4px;
      display: block;
      flex: 0 0 auto;
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
      width: 46px;
      height: 100%;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      cursor: default;

      mat-icon {
        font-size: 16px;
        width: 16px;
        height: 16px;
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
  protected readonly workspace = inject(Workspace);
  protected readonly preferences = inject(Preferences);
  private readonly renderer = inject(RendererHandle);
  private readonly destroyRef = inject(DestroyRef);

  private readonly windowState = signal({ maximized: false, fullscreen: false });

  protected readonly maximized = computed(() => this.windowState().maximized);
  protected readonly fullscreen = computed(() => this.windowState().fullscreen);
  protected readonly darkMode = computed(() => this.preferences.value().colorScheme === 'dark');

  constructor() {
    afterNextRender(() => {
      void this.desktop.windowState().then((state) => this.windowState.set(state));
      const stop = this.desktop.onWindowStateChanged((state) => this.windowState.set(state));
      this.destroyRef.onDestroy(stop);
    });
  }

  protected toggle(key: keyof Pick<WorkspacePreferences, 'browserOpen' | 'guiVisible' | 'editorOpen'>): void {
    this.preferences.patch({ [key]: !this.preferences.value()[key] });
  }

  protected toggleColorScheme(): void {
    this.preferences.patch({ colorScheme: this.darkMode() ? 'light' : 'dark' });
  }

  protected exportCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.exportShader(record.id, record.name);
  }

  protected takeScreenshot(): void {
    void this.renderer.screenshot(this.store.record()?.id ?? 'shader');
  }

  protected onTitlebarDblClick(event: MouseEvent): void {
    if ((event.target as HTMLElement | null)?.closest('.no-drag')) return;
    this.desktop.toggleMaximize();
  }
}
