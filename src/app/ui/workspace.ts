import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import type { ImportMode } from '../../shared/model';
import { DesktopPlatform } from '../core/desktop-platform';
import { ShaderStore } from '../core/shader-store';
import { buildFullGlsl } from '../rendering/glsl-export';
import { convertShadertoy } from '../rendering/shadertoy-import';
import { ConfirmDialog, type ConfirmDialogData } from './confirm-dialog';
import { DesktopVersionDialog } from './desktop-version-dialog';
import { EditorSettingsDialog } from './editor-settings-dialog';
import { NewShaderDialog, type NewShaderDialogResult } from './new-shader-dialog';
import { PromptDialog, type PromptDialogData, type PromptDialogResult } from './prompt-dialog';
import { RecoveryDialog } from './recovery-dialog';
import { ShadertoyImportDialog, type ShadertoyImportDialogResult } from './shadertoy-import-dialog';
import { UnsavedChangesDialog, type UnsavedChoice } from './unsaved-changes-dialog';

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
  private readonly desktop = inject(DesktopPlatform);
  private transitionInFlight: Promise<boolean> | null = null;

  guardedTransition(action: () => void | Promise<void>): Promise<boolean> {
    if (this.transitionInFlight) return this.transitionInFlight;
    this.transitionInFlight = this.runGuarded(action).finally(
      () => (this.transitionInFlight = null),
    );
    return this.transitionInFlight;
  }

  private async runGuarded(action: () => void | Promise<void>): Promise<boolean> {
    if (this.store.dirty()) {
      const choice = await firstValueFrom(
        this.dialog
          .open<UnsavedChangesDialog, never, UnsavedChoice>(UnsavedChangesDialog, {
            disableClose: true,
          })
          .afterClosed(),
      );
      if (choice === 'cancel' || !choice) return false;
      if (choice === 'save' && !(await this.store.save())) return false;
      if (choice === 'discard') this.store.discardCurrentDraft();
    }
    await action();
    return true;
  }

  async selectShader(id: string): Promise<boolean> {
    if (id === this.store.selectedId()) return true;
    return this.guardedTransition(() => this.store.select(id));
  }

  async resolveStaleRecovery(): Promise<void> {
    if (!this.store.staleRecovery()) return;
    const restore = await firstValueFrom(
      this.dialog
        .open<RecoveryDialog, never, boolean>(RecoveryDialog, { disableClose: true })
        .afterClosed(),
    );
    this.store.resolveRecovery(restore === true);
  }

  openEditorSettings(): void {
    this.dialog.open(EditorSettingsDialog, { width: '720px', maxWidth: '92vw' });
  }

  openDesktopVersion(): void {
    if (this.desktop.available) {
      this.dialog.open(DesktopVersionDialog, { width: '480px', maxWidth: '92vw' });
    }
  }

  private promptFor(data: PromptDialogData): Promise<PromptDialogResult | undefined> {
    return firstValueFrom(
      this.dialog
        .open<PromptDialog, PromptDialogData, PromptDialogResult>(PromptDialog, { data })
        .afterClosed(),
    );
  }

  /** The name only — for the prompts that carry no extra option. */
  private async prompt(data: PromptDialogData): Promise<string | undefined> {
    return (await this.promptFor(data))?.value;
  }

  private confirm(data: ConfirmDialogData): Promise<boolean> {
    return firstValueFrom(this.dialog.open(ConfirmDialog, { data }).afterClosed()).then(
      (result) => result === true,
    );
  }

  // --- Shaders ------------------------------------------------------------

  async createShader(): Promise<void> {
    const result = await firstValueFrom(
      this.dialog
        .open<NewShaderDialog, never, NewShaderDialogResult>(NewShaderDialog)
        .afterClosed(),
    );
    if (!result) return;
    if (result.action === 'shadertoy') {
      await this.importShadertoy();
      return;
    }
    await this.guardedTransition(() => this.store.create(result.name));
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
    if (name) await this.guardedTransition(() => this.store.duplicate(id, name));
  }

  async deleteShader(id: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: 'Delete shader',
      message: `“${name}” and all of its presets will be permanently deleted.`,
      confirmText: 'Delete',
      destructive: true,
    });
    if (confirmed) {
      if (id === this.store.selectedId()) await this.guardedTransition(() => this.store.remove(id));
      else await this.store.remove(id);
    }
  }

  // --- Source ---------------------------------------------------------------

  /**
   * Copy the fragment as a standalone file: the source plus the declarations
   * the engine would otherwise have supplied. What you paste into another
   * engine, or into a bug report, is then the shader as it actually compiles.
   */
  async copyFullGlsl(): Promise<void> {
    const draft = this.store.draft();
    if (!draft) return;

    const glsl = buildFullGlsl(draft.fragment, this.store.controls());

    try {
      await navigator.clipboard.writeText(glsl);
      this.store.notice.set({ text: 'Copied the full GLSL to the clipboard', error: false });
    } catch {
      // Denied permission, or an insecure context — neither is worth a console
      // trace, but the user is owed an explanation for the nothing that happened.
      this.store.notice.set({ text: 'The clipboard is not available here', error: true });
    }
  }

  // --- Presets ------------------------------------------------------------

  async savePreset(): Promise<void> {
    const result = await this.promptFor({
      title: 'Save preset',
      label: 'Preset name',
      confirmText: 'Save',
      hint: 'Captures the current parameter values. Reusing a name overwrites it.',
      option: {
        label: 'Also capture the render settings',
        hint: 'Applying the preset then restores bloom too, leaving the shader unsaved.',
      },
    });
    if (result) await this.store.savePreset(result.value, result.checked);
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

  async importShadertoy(): Promise<void> {
    const input = await firstValueFrom(
      this.dialog
        .open<ShadertoyImportDialog, never, ShadertoyImportDialogResult>(ShadertoyImportDialog, {
          width: '800px',
          maxWidth: '94vw',
        })
        .afterClosed(),
    );
    if (!input) return;

    let converted;
    try {
      converted = convertShadertoy(input.source);
    } catch (error) {
      this.store.notice.set({
        text: `Shadertoy import failed: ${(error as Error).message}`,
        error: true,
      });
      return;
    }

    await this.guardedTransition(async () => {
      const previousId = this.store.selectedId();
      await this.store.create(input.name);
      if (!this.store.selectedId() || this.store.selectedId() === previousId) return;
      this.store.setFragment(converted.fragment);
      if (!(await this.store.save())) return;
      const suffix = converted.warnings.length ? ` ${converted.warnings.join(' ')}` : '';
      this.store.notice.set({
        text: `Imported “${input.name}” from Shadertoy.${suffix}`,
        error: false,
      });
    });
  }

  async exportShader(id: string, name: string): Promise<void> {
    try {
      const bundle = await this.store.exportShader(id);
      if (this.desktop.available) {
        if (!(await this.desktop.saveBundle(`${id}.shader.json`, bundle as never))) return;
      } else {
        this.download(bundle, `${id}.shader.json`);
      }
      this.store.notice.set({ text: `Exported “${name}”`, error: false });
    } catch (error) {
      this.store.notice.set({ text: `Export failed: ${String(error)}`, error: true });
    }
  }

  async exportAll(): Promise<void> {
    try {
      const bundle = await this.store.exportAll();
      if (this.desktop.available) {
        if (
          !(await this.desktop.saveBundle('shader-studio-collection.shader.json', bundle as never))
        )
          return;
      } else {
        this.download(bundle, 'shader-studio-collection.shader.json');
      }
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

    await this.guardedTransition(() => this.store.importBundle(bundle, mode));
  }

  async importDesktop(mode: ImportMode): Promise<void> {
    try {
      const picked = await this.desktop.openBundle();
      if (!picked) return;
      if (mode === 'overwrite') {
        const confirmed = await this.confirm({
          title: 'Import and replace',
          message:
            'Shaders with matching ids will be replaced, including their presets. This cannot be undone.',
          confirmText: 'Replace',
          destructive: true,
        });
        if (!confirmed) return;
      }
      await this.guardedTransition(() => this.store.importBundle(picked.bundle, mode));
    } catch (error) {
      this.store.notice.set({ text: `Import failed: ${String(error)}`, error: true });
    }
  }

  async resolveFirstRunMigration(): Promise<void> {
    if (!this.desktop.available || !(await this.desktop.migrationPending())) return;
    const shouldImport = await this.confirm({
      title: 'Import an existing library?',
      message:
        'Choose an existing Shader Studio data folder, or continue with the example library.',
      confirmText: 'Choose folder',
    });
    if (!shouldImport) {
      await this.desktop.declineMigration();
      return;
    }
    try {
      const notice = await this.desktop.migrate();
      if (notice) {
        await this.store.refreshList();
        this.store.notice.set({ text: notice, error: false });
      }
    } catch (error) {
      this.store.notice.set({ text: `Import failed: ${String(error)}`, error: true });
    }
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
