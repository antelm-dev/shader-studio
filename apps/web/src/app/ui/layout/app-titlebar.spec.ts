import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatMenuModule } from '@angular/material/menu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPTURE } from '@shader-studio/shared/model';
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_WINDOW,
} from '@shader-studio/shared/editor-prefs';
import {
  DEFAULT_FILE_EXPLORER_OPEN,
  DEFAULT_FILE_EXPLORER_VIEW,
  DEFAULT_FILE_EXPLORER_WIDTH,
  DEFAULT_PANEL_WIDTHS,
} from '@shader-studio/shared/panel-prefs';
import { DEFAULT_PREVIEW_WINDOW } from '@shader-studio/shared/preview-prefs';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18nCatalog, type I18nCatalogMap } from '../../i18n/catalog';
import { I18n } from '../../i18n/i18n';
import { Preferences, type WorkspacePreferences } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { DocumentStatus } from '../editor/document-status';
import { MenuCommands, type MenuCommand } from '../menu-commands';
import { WorkspaceActions } from '../workspace-actions';
import { AppTitlebar } from './app-titlebar';

class FileCatalog extends I18nCatalog {
  override load(locale: 'en' | 'fr'): Promise<I18nCatalogMap> {
    const raw = readFileSync(
      resolve(import.meta.dirname, `../../../../../../i18n/${locale}.json`),
      'utf8',
    );
    return Promise.resolve(JSON.parse(raw) as I18nCatalogMap);
  }
}

function stubCommand(id: string): MenuCommand {
  return {
    id,
    icon: () => 'circle',
    label: () => id,
    action: () => undefined,
  };
}

describe('AppTitlebar Help and View menus', () => {
  const language = signal({ language: 'en' as 'en' | 'fr' });
  const openKeyboardShortcuts = vi.fn();
  const checkForUpdates = vi.fn();
  const openAboutShaderStudio = vi.fn();
  const toggleDevTools = vi.fn();
  const openSupportLink = vi.fn();

  beforeEach(async () => {
    language.set({ language: 'en' });
    openKeyboardShortcuts.mockReset();
    checkForUpdates.mockReset();
    openAboutShaderStudio.mockReset();
    toggleDevTools.mockReset();
    openSupportLink.mockReset();

    const prefs: WorkspacePreferences = {
      language: 'en',
      lastShaderId: null,
      shadertoyApiKey: null,
      browserOpen: true,
      editorOpen: false,
      guiVisible: true,
      browserWidth: DEFAULT_PANEL_WIDTHS.browser,
      inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
      inspectorTab: 'controls',
      bottomPanelOpen: false,
      bottomPanelHeight: 220,
      bottomPanelTab: 'problems',
      fileExplorerOpen: DEFAULT_FILE_EXPLORER_OPEN,
      fileExplorerView: DEFAULT_FILE_EXPLORER_VIEW,
      fileExplorerWidth: DEFAULT_FILE_EXPLORER_WIDTH,
      resolutionScale: 1,
      paused: false,
      autoRipples: false,
      colorScheme: 'dark',
      editorAppearance: DEFAULT_EDITOR_APPEARANCE,
      editorWindow: DEFAULT_EDITOR_WINDOW,
      previewWindow: DEFAULT_PREVIEW_WINDOW,
      capture: DEFAULT_CAPTURE,
    };

    TestBed.configureTestingModule({
      imports: [AppTitlebar, MatMenuModule],
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        { provide: I18nCatalog, useClass: FileCatalog },
        {
          provide: Preferences,
          useValue: {
            value: signal(prefs).asReadonly(),
            patch: (patch: Partial<WorkspacePreferences>) => {
              if (patch.language) language.set({ language: patch.language });
            },
          },
        },
        {
          provide: DesktopPlatform,
          useValue: {
            available: true,
            maximized: signal(false).asReadonly(),
            fullscreen: signal(false).asReadonly(),
            minimize: () => undefined,
            toggleMaximize: () => undefined,
            close: () => undefined,
            toggleFullscreen: () => undefined,
            toggleDevTools,
            openSupportLink,
          },
        },
        {
          provide: ShaderStore,
          useValue: {
            record: signal(null).asReadonly(),
            saving: signal(false).asReadonly(),
            save: () => undefined,
          },
        },
        {
          provide: DocumentStatus,
          useValue: {
            canSave: () => false,
            saveHint: () => '',
          },
        },
        {
          provide: WorkspaceActions,
          useValue: {
            openKeyboardShortcuts,
            checkForUpdates,
            openAboutShaderStudio,
            openEditorSettings: () => undefined,
          },
        },
        {
          provide: MenuCommands,
          useValue: {
            newShader: stubCommand('new'),
            import: (_mode: unknown, _key: string) => stubCommand(`import-${_key}`),
            exportShader: stubCommand('export'),
            exportWallpaper: stubCommand('wallpaper'),
            exportAll: stubCommand('export-all'),
            toggleEditor: stubCommand('toggle-editor'),
            exportSequence: stubCommand('sequence'),
            toggle: () => undefined,
            captureImage: () => undefined,
          },
        },
      ],
    });

    await TestBed.inject(I18n).ensureLoaded('en');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  const mount = () => {
    const fixture = TestBed.createComponent(AppTitlebar);
    fixture.detectChanges();
    return fixture;
  };

  const openMenu = (fixture: ReturnType<typeof mount>, label: string): HTMLElement[] => {
    const triggers = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.menu-trigger'),
    ) as HTMLButtonElement[];
    const trigger = triggers.find((button) => button.textContent?.trim() === label);
    expect(trigger).toBeTruthy();
    trigger!.click();
    fixture.detectChanges();
    return Array.from(document.querySelectorAll('.cdk-overlay-container button[mat-menu-item]'));
  };

  const labelsOf = (items: HTMLElement[]): string[] =>
    items.map((item) => {
      const clone = item.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('mat-icon, .menu-hint').forEach((node) => node.remove());
      return clone.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    });

  it('places Toggle Developer Tools at the bottom of View with Ctrl+Shift+I', () => {
    const fixture = mount();
    const items = openMenu(fixture, 'View');
    const labels = labelsOf(items);

    expect(labels.at(-1)).toBe('Toggle Developer Tools');
    const hint = items.at(-1)?.querySelector('.menu-hint')?.textContent?.trim();
    expect(hint).toBe('Ctrl+Shift+I');

    items.at(-1)!.click();
    expect(toggleDevTools).toHaveBeenCalledOnce();
  });

  it('orders Help menu with a divider before update/About actions', () => {
    const fixture = mount();
    const items = openMenu(fixture, 'Help');
    expect(labelsOf(items)).toEqual([
      'Keyboard Shortcuts…',
      'Documentation',
      'Report an Issue…',
      'Check for Updates…',
      'About Shader Studio…',
    ]);

    const panels = Array.from(
      document.querySelectorAll('.cdk-overlay-container .mat-mdc-menu-panel'),
    );
    const helpPanel = panels.at(-1);
    expect(helpPanel?.querySelector('mat-divider, .mat-divider')).toBeTruthy();
  });

  it('dispatches Help actions through workspace and support-link APIs', () => {
    const fixture = mount();
    const items = openMenu(fixture, 'Help');

    items[0]!.click();
    expect(openKeyboardShortcuts).toHaveBeenCalledOnce();

    items[1]!.click();
    expect(openSupportLink).toHaveBeenCalledWith('documentation');

    items[2]!.click();
    expect(openSupportLink).toHaveBeenCalledWith('issues');

    items[3]!.click();
    expect(checkForUpdates).toHaveBeenCalledOnce();

    items[4]!.click();
    expect(openAboutShaderStudio).toHaveBeenCalledOnce();
  });

  it('keeps titlebar drag region and marks menus as no-drag', () => {
    const fixture = mount();
    const root = fixture.nativeElement as HTMLElement;
    const titlebar = root.querySelector('.titlebar') as HTMLElement;
    const leading = root.querySelector('.leading') as HTMLElement;
    const trailing = root.querySelector('.trailing') as HTMLElement;
    expect(titlebar.classList.contains('titlebar')).toBe(true);
    expect(leading.classList.contains('no-drag')).toBe(true);
    expect(trailing.classList.contains('no-drag')).toBe(true);
  });
});
