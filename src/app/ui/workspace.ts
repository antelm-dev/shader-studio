import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import type { ImportMode } from '../../shared/model';
import { ShaderStore } from '../core/shader-store';
import { ConfirmDialog, type ConfirmDialogData } from './confirm-dialog';
import { PromptDialog, type PromptDialogData } from './prompt-dialog';

/**
 * The user-facing verbs of the app: the flows that need a dialog or a file
 * before they can call the store.
 *
 * Keeping them here means the toolbar, the browser list and the preset panel
 * can all trigger the same "delete this shader" flow — confirmation included —
 * without duplicating it or reaching into each other.
 */
@Injectable({ providedIn: 'root' })
export class Workspace {
  private readonly dialog = inject(MatDialog);
  private readonly store = inject(ShaderStore);

  private prompt(data: PromptDialogData): Promise<string | undefined> {
    return firstValueFrom(this.dialog.open(PromptDialog, { data }).afterClosed());
  }

  private confirm(data: ConfirmDialogData): Promise<boolean> {
    return firstValueFrom(this.dialog.open(ConfirmDialog, { data }).afterClosed()).then(
      (result) => result === true,
    );
  }

  // --- Shaders ------------------------------------------------------------

  async createShader(): Promise<void> {
    const name = await this.prompt({
      title: 'New shader',
      label: 'Name',
      confirmText: 'Create',
      hint: 'Starts from a small template you can edit straight away',
    });
    if (name) await this.store.create(name);
  }

  async renameShader(id: string, currentName: string): Promise<void> {
    const name = await this.prompt({
      title: 'Rename shader',
      label: 'Name',
      value: currentName,
      confirmText: 'Rename',
      hint: 'The name changes; links and files keep the same id',
    });
    if (name && name !== currentName) await this.store.rename(id, name);
  }

  async duplicateShader(id: string, currentName: string): Promise<void> {
    const name = await this.prompt({
      title: 'Duplicate shader',
      label: 'Name of the copy',
      value: `${currentName} copy`,
      confirmText: 'Duplicate',
    });
    if (name) await this.store.duplicate(id, name);
  }

  async deleteShader(id: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: 'Delete shader',
      message: `“${name}” and all of its presets will be permanently deleted.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) await this.store.remove(id);
  }

  // --- Presets ------------------------------------------------------------

  async savePreset(): Promise<void> {
    const name = await this.prompt({
      title: 'Save preset',
      label: 'Preset name',
      confirmText: 'Save',
      hint: 'Captures the current parameter values. Reusing a name overwrites it.',
    });
    if (name) await this.store.savePreset(name);
  }

  async deletePreset(presetId: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: 'Delete preset',
      message: `Delete the preset “${name}”?`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) await this.store.deletePreset(presetId);
  }

  // --- Import / export ----------------------------------------------------

  async exportShader(id: string, name: string): Promise<void> {
    try {
      const bundle = await this.store.exportShader(id);
      this.download(bundle, `${id}.shader.json`);
      this.store.notice.set({ text: `Exported “${name}”`, error: false });
    } catch (error) {
      this.store.notice.set({ text: `Export failed: ${String(error)}`, error: true });
    }
  }

  async exportAll(): Promise<void> {
    try {
      const bundle = await this.store.exportAll();
      this.download(bundle, 'shader-studio-collection.shader.json');
      this.store.notice.set({ text: 'Exported the whole collection', error: false });
    } catch (error) {
      this.store.notice.set({ text: `Export failed: ${String(error)}`, error: true });
    }
  }

  /**
   * Read a `.shader.json` the user picked and hand it to the API.
   *
   * The bundle is parsed here only to fail fast on something that is not even
   * JSON. The server validates it properly — the client is not the authority.
   */
  async importFile(file: File, mode: ImportMode): Promise<void> {
    let bundle: unknown;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      this.store.notice.set({
        text: `“${file.name}” is not a valid JSON file`,
        error: true,
      });
      return;
    }

    if (mode === 'overwrite') {
      const confirmed = await this.confirm({
        title: 'Import and replace',
        message:
          'Shaders in this bundle that share an id with an existing shader will replace it, ' +
          'including its presets. This cannot be undone.',
        confirmText: 'Replace',
        destructive: true,
      });
      if (!confirmed) return;
    }

    await this.store.importBundle(bundle, mode);
  }

  private download(bundle: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }
}
