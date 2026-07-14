import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

import type { ImportMode } from '@shader-studio/shared/model';
import { composePass } from '@shader-studio/shared/pass-source';
import { imagePass } from '@shader-studio/shared/project';
import { DesktopPlatform } from '../core/desktop-platform';
import { ShaderStore, type EditorDocument } from '../core/shader-store';
import { I18n } from '../i18n/i18n';
import { buildFullGlsl } from '@shader-studio/shared/glsl-export';
import { convertShadertoy } from '@shader-studio/shared/shadertoy-import';
import { ConfirmDialog, type ConfirmDialogData } from './confirm-dialog';
import { DesktopVersionDialog } from './desktop-version-dialog';
import { EditorSettingsDialog } from './editor-settings-dialog';
import { ExportDialog } from './export-dialog';
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
  private readonly i18n = inject(I18n);
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

  /** `disableClose`: a stray Escape mid-capture would leave the render running behind a closed dialog. */
  openExport(): void {
    this.dialog.open(ExportDialog, { maxWidth: '92vw', disableClose: true });
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
      title: this.i18n.t('dialog.renameShader'),
      label: this.i18n.t('dialog.name'),
      value: currentName,
      confirmText: this.i18n.t('dialog.renameConfirm'),
      hint: this.i18n.t('dialog.renameHint'),
    });
    if (name && name !== currentName) await this.store.rename(id, name);
  }

  async duplicateShader(id: string, currentName: string): Promise<void> {
    const suffix = this.i18n.locale() === 'fr' ? 'copie' : 'copy';
    const name = await this.prompt({
      title: this.i18n.t('dialog.duplicateShader'),
      label: this.i18n.t('dialog.duplicateName'),
      value: `${currentName} ${suffix}`,
      confirmText: this.i18n.t('dialog.duplicateConfirm'),
    });
    if (name) await this.guardedTransition(() => this.store.duplicate(id, name));
  }

  async deleteShader(id: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deleteShader'),
      message: this.i18n.t('dialog.deleteShaderMessage', { name }),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
    if (confirmed) {
      if (id === this.store.selectedId()) await this.guardedTransition(() => this.store.remove(id));
      else await this.store.remove(id);
    }
  }

  // --- Files and passes ---------------------------------------------------

  async createFile(): Promise<void> {
    if (!this.store.draft()) return;

    const name = await this.prompt({
      title: this.i18n.t('dialog.newFile'),
      label: this.i18n.t('dialog.fileName'),
      value: 'untitled.glsl',
      confirmText: this.i18n.t('action.create'),
      hint: this.i18n.t('dialog.newFileHint'),
    });
    if (name) this.store.addSourceFile(name);
  }

  async renameDocument(doc: EditorDocument): Promise<void> {
    const name = await this.prompt({
      title: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFile' : 'dialog.renamePass'),
      label: this.i18n.t('dialog.name'),
      value: doc.name,
      confirmText: this.i18n.t('dialog.renameConfirm'),
      hint: this.i18n.t(doc.kind === 'file' ? 'dialog.renameFileHint' : 'dialog.renamePassHint'),
    });
    if (!name || name === doc.name) return;

    if (doc.kind === 'file') this.store.renameSourceFile(doc.id, name);
    else this.store.renamePassById(doc.id, name);
  }

  /**
   * Deleting a buffer is not the same size of action as deleting a file, and the
   * confirmation says so: a file is text, but a buffer is something other passes
   * may be *sampling*, and removing it silently unbinds every channel that named
   * it. Naming those consumers is the difference between a confirmation and a
   * formality.
   */
  async deleteDocument(doc: EditorDocument): Promise<void> {
    const project = this.store.project();
    if (!project) return;

    if (doc.kind === 'file') {
      const confirmed = await this.confirm({
        title: this.i18n.t('dialog.deleteFile'),
        message: this.i18n.t('dialog.deleteFileMessage', { name: doc.name }),
        confirmText: this.i18n.t('action.delete'),
        destructive: true,
      });
      if (confirmed) this.store.removeSourceFile(doc.id);
      return;
    }

    const consumers = project.passes
      .filter(
        (pass) =>
          pass.id !== doc.id &&
          pass.channels.some((binding) => binding.kind === 'buffer' && binding.passId === doc.id),
      )
      .map((pass) => pass.name);

    const join = this.i18n.locale() === 'fr' ? ' et ' : ' and ';
    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deleteBuffer'),
      message:
        this.i18n.t('dialog.deleteBufferMessage', { name: doc.name }) +
        (consumers.length === 0
          ? ''
          : consumers.length === 1
            ? this.i18n.t('dialog.deleteBufferConsumersOne', { name: consumers[0] })
            : this.i18n.t('dialog.deleteBufferConsumersMany', {
                names: consumers.join(join),
              })),
      confirmText: this.i18n.t('action.delete'),
      destructive: true,
    });
    if (confirmed) this.store.removeBufferPass(doc.id);
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

    // The Image pass, composed: Common and any `#include`s folded in, so what
    // lands on the clipboard is what the driver actually saw — not a source with
    // half its declarations in another tab.
    const { source } = composePass(draft.project, imagePass(draft.project));
    const glsl = buildFullGlsl(source, this.store.controls());

    try {
      await navigator.clipboard.writeText(glsl);
      this.store.notice.set({ text: this.i18n.t('notice.copiedGlsl'), error: false });
    } catch {
      // Denied permission, or an insecure context — neither is worth a console
      // trace, but the user is owed an explanation for the nothing that happened.
      this.store.notice.set({ text: this.i18n.t('notice.clipboardUnavailable'), error: true });
    }
  }

  // --- Presets ------------------------------------------------------------

  async savePreset(): Promise<void> {
    const result = await this.promptFor({
      title: this.i18n.t('dialog.savePreset'),
      label: this.i18n.t('dialog.presetName'),
      confirmText: this.i18n.t('action.save'),
      hint: this.i18n.t('dialog.savePresetHint'),
      option: {
        label: this.i18n.t('dialog.presetCaptureRender'),
        hint: this.i18n.t('dialog.presetCaptureRenderHint'),
      },
    });
    if (result) await this.store.savePreset(result.value, result.checked);
  }

  async deletePreset(presetId: string, name: string): Promise<void> {
    const confirmed = await this.confirm({
      title: this.i18n.t('dialog.deletePreset'),
      message: this.i18n.t('dialog.deletePresetMessage', { name }),
      confirmText: this.i18n.t('action.delete'),
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
        text: this.i18n.t('notice.shadertoyFailed', { error: (error as Error).message }),
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
        text: this.i18n.t('notice.shadertoyImported', { name: input.name, suffix }),
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
      this.store.notice.set({ text: this.i18n.t('notice.exported', { name }), error: false });
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.exportFailed', { error: String(error) }),
        error: true,
      });
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
      this.store.notice.set({ text: this.i18n.t('notice.exportedAll'), error: false });
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.exportFailed', { error: String(error) }),
        error: true,
      });
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
        text: this.i18n.t('notice.invalidJson', { name: file.name }),
        error: true,
      });
      return;
    }

    if (mode === 'overwrite') {
      const confirmed = await this.confirm({
        title: this.i18n.t('dialog.importReplace'),
        message: this.i18n.t('dialog.importReplaceMessage'),
        confirmText: this.i18n.t('action.replace'),
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
          title: this.i18n.t('dialog.importReplace'),
          message: this.i18n.t('dialog.importReplaceDesktop'),
          confirmText: this.i18n.t('action.replace'),
          destructive: true,
        });
        if (!confirmed) return;
      }
      await this.guardedTransition(() => this.store.importBundle(picked.bundle, mode));
    } catch (error) {
      this.store.notice.set({
        text: this.i18n.t('notice.importFailed', { error: String(error) }),
        error: true,
      });
    }
  }

  async resolveFirstRunMigration(): Promise<void> {
    if (!this.desktop.available || !(await this.desktop.migrationPending())) return;
    const shouldImport = await this.confirm({
      title: this.i18n.t('dialog.migrateTitle'),
      message: this.i18n.t('dialog.migrateMessage'),
      confirmText: this.i18n.t('dialog.chooseFolder'),
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
      this.store.notice.set({
        text: this.i18n.t('notice.importFailed', { error: String(error) }),
        error: true,
      });
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
