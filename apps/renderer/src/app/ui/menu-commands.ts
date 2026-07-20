import { Injectable, inject } from '@angular/core';

import type { ImportMode } from '@shader-studio/shared/model';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { ShaderStore } from '../workspace/shader-store';
import { RendererHandle } from '../rendering/renderer-handle';
import { WorkspaceActions } from './workspace-actions';
import { I18n } from '../i18n/i18n';
import type { TranslationKey } from '../i18n/keys';

/**
 * One line of a menu: what it shows, whether it can be used, and what it does.
 *
 * The icon, the label and the disabled state are read back on every change
 * detection rather than captured when the command is built — a command may sit
 * in an array for the life of the app, and what it says has to keep following
 * the store and the preferences it is describing.
 */
export interface MenuCommand {
  readonly id: string;
  readonly icon: () => string;
  readonly label: () => string;
  readonly disabled?: () => boolean;
  readonly shortcut?: string;
  readonly action: () => void;
}

/** The panels a menu can show and hide. */
export type TogglablePanel = keyof Pick<
  WorkspacePreferences,
  'browserOpen' | 'editorOpen' | 'guiVisible' | 'bottomPanelOpen'
>;

/**
 * The commands the toolbar's "More actions" menu and the desktop title bar both
 * offer.
 *
 * They are the same commands — the same icon, the same rule for when they are
 * unavailable, the same work — so they are written once here and the two menus
 * merely arrange them. Items only one surface has (the output window, Quit, the
 * Theme submenu) stay in the template that owns them.
 */
@Injectable({ providedIn: 'root' })
export class MenuCommands {
  private readonly store = inject(ShaderStore);
  private readonly workspace = inject(WorkspaceActions);
  private readonly preferences = inject(Preferences);
  private readonly desktop = inject(DesktopPlatform);
  private readonly renderer = inject(RendererHandle);
  private readonly i18n = inject(I18n);

  private filePicker: ((mode: ImportMode) => void) | null = null;

  /**
   * In the browser an import starts at a hidden file input, which lives in the
   * one component that has a template for it. On the desktop the platform opens
   * its own dialog and nothing has to be registered.
   */
  useFilePicker(pick: (mode: ImportMode) => void): void {
    this.filePicker = pick;
  }

  // --- Actions ------------------------------------------------------------
  // Shared with the keyboard shortcuts and the rail, so they are methods rather
  // than something buried inside a command.

  private readonly noShader = (): boolean => !this.store.record();

  toggle(key: TogglablePanel): void {
    this.preferences.patch({ [key]: !this.preferences.value()[key] });
  }

  importShader(mode: ImportMode): void {
    if (this.desktop.available) void this.workspace.importDesktop(mode);
    else this.filePicker?.(mode);
  }

  exportCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.exportShader(record.id, record.name);
  }

  renameCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.renameShader(record.id, record.name);
  }

  duplicateCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.duplicateShader(record.id, record.name);
  }

  deleteCurrent(): void {
    const record = this.store.record();
    if (record) void this.workspace.deleteShader(record.id, record.name);
  }

  captureImage(): void {
    void this.renderer.screenshot(this.store.record()?.id ?? 'shader');
  }

  captureSequence(): void {
    this.workspace.openExport();
  }

  // --- Commands -----------------------------------------------------------

  readonly newShader: MenuCommand = {
    id: 'new-shader',
    icon: () => 'add',
    label: () => this.i18n.t('action.newShader'),
    action: () => void this.workspace.createShader(),
  };

  readonly renameShader: MenuCommand = {
    id: 'rename-shader',
    icon: () => 'edit',
    label: () => this.i18n.t('action.renameShader'),
    disabled: this.noShader,
    action: () => this.renameCurrent(),
  };

  readonly duplicateShader: MenuCommand = {
    id: 'duplicate-shader',
    icon: () => 'content_copy',
    label: () => this.i18n.t('action.duplicateShader'),
    disabled: this.noShader,
    action: () => this.duplicateCurrent(),
  };

  readonly exportShader: MenuCommand = {
    id: 'export-shader',
    icon: () => 'download',
    label: () => this.i18n.t('action.exportShader'),
    disabled: this.noShader,
    action: () => this.exportCurrent(),
  };

  readonly exportWallpaper: MenuCommand = {
    id: 'export-wallpaper',
    icon: () => 'wallpaper',
    label: () => this.i18n.t('action.exportWallpaper'),
    disabled: this.noShader,
    action: () => void this.workspace.exportWallpaper(),
  };

  readonly exportSequence: MenuCommand = {
    id: 'export-sequence',
    icon: () => 'movie',
    label: () => this.i18n.t('action.export'),
    disabled: () => !this.renderer.engine(),
    action: () => this.captureSequence(),
  };

  readonly exportAll: MenuCommand = {
    id: 'export-all',
    icon: () => 'library_books',
    label: () => this.i18n.t('action.exportAll'),
    action: () => void this.workspace.exportAll(),
  };

  readonly toggleEditor: MenuCommand = {
    id: 'toggle-editor',
    icon: () => 'code',
    label: () =>
      this.i18n.t(this.preferences.value().editorOpen ? 'action.hideEditor' : 'action.showEditor'),
    action: () => this.toggle('editorOpen'),
  };

  /** Problems and Output — the bottom panel, not the desktop's detached output window. */
  readonly togglePanel: MenuCommand = {
    id: 'toggle-panel',
    icon: () => 'terminal',
    label: () =>
      this.i18n.t(
        this.preferences.value().bottomPanelOpen ? 'action.hidePanel' : 'action.showPanel',
      ),
    shortcut: 'Ctrl+J',
    action: () => this.toggle('bottomPanelOpen'),
  };

  /** The label is the menu's own: "Import shader…" reads oddly under a File menu. */
  import(mode: ImportMode, label: TranslationKey): MenuCommand {
    return {
      id: mode === 'overwrite' ? 'import-replace' : 'import-shader',
      icon: () => (mode === 'overwrite' ? 'upload_file' : 'upload'),
      label: () => this.i18n.t(label),
      action: () => this.importShader(mode),
    };
  }
}
