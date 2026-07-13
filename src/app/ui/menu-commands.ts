import { Injectable, inject } from '@angular/core';

import type { ImportMode } from '../../shared/model';
import { DesktopPlatform } from '../core/desktop-platform';
import { Preferences, type WorkspacePreferences } from '../core/preferences';
import { ShaderStore } from '../core/shader-store';
import { RendererHandle } from '../rendering/renderer-handle';
import { Workspace } from './workspace';

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
  'browserOpen' | 'editorOpen' | 'guiVisible'
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
  private readonly workspace = inject(Workspace);
  private readonly preferences = inject(Preferences);
  private readonly desktop = inject(DesktopPlatform);
  private readonly renderer = inject(RendererHandle);

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

  // --- Commands -----------------------------------------------------------

  readonly newShader: MenuCommand = {
    id: 'new-shader',
    icon: () => 'add',
    label: () => 'New shader…',
    action: () => void this.workspace.createShader(),
  };

  readonly renameShader: MenuCommand = {
    id: 'rename-shader',
    icon: () => 'edit',
    label: () => 'Rename shader…',
    disabled: this.noShader,
    action: () => this.renameCurrent(),
  };

  readonly duplicateShader: MenuCommand = {
    id: 'duplicate-shader',
    icon: () => 'content_copy',
    label: () => 'Duplicate shader',
    disabled: this.noShader,
    action: () => this.duplicateCurrent(),
  };

  readonly exportShader: MenuCommand = {
    id: 'export-shader',
    icon: () => 'download',
    label: () => 'Export shader…',
    disabled: this.noShader,
    action: () => this.exportCurrent(),
  };

  readonly exportAll: MenuCommand = {
    id: 'export-all',
    icon: () => 'library_books',
    label: () => 'Export all shaders…',
    action: () => void this.workspace.exportAll(),
  };

  readonly toggleEditor: MenuCommand = {
    id: 'toggle-editor',
    icon: () => 'code',
    label: () => (this.preferences.value().editorOpen ? 'Hide editor' : 'Show editor'),
    action: () => this.toggle('editorOpen'),
  };

  /** The label is the menu's own: "Import shader…" reads oddly under a File menu. */
  import(mode: ImportMode, label: string): MenuCommand {
    return {
      id: mode === 'overwrite' ? 'import-replace' : 'import-shader',
      icon: () => (mode === 'overwrite' ? 'upload_file' : 'upload'),
      label: () => label,
      action: () => this.importShader(mode),
    };
  }
}
