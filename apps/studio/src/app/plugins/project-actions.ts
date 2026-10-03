import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';

import { hasActivePostProcessing, type ShaderBundle } from '@shadergrove/shared/model';
import type {
  ProjectExportInput,
  ProjectExporterContribution,
  ProjectImportInput,
  ProjectImporterContribution,
} from '@shadergrove/shared/plugin';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { WorkspaceActions } from '../ui/workspace-actions';
import { ShaderStore } from '../workspace/shader-store';
import { HostAdapters, type RuntimeTexture } from './host-adapters';
import { PluginInstallations, type InstalledPlugin } from './plugin-installations';
import { DesktopFolderWriter, ZipDownloadWriter, type ProjectWriter } from './project-delivery';
import { resolveProjectCandidate } from './project-import';

export type ProjectImportRequest =
  | { mode: 'paste'; name: string; text: string }
  | { mode: 'provider'; values: Record<string, string> };

/** What the user is told while a call runs; i18n keys under `plugins.step.*`. */
export type ProjectStep = 'fetching' | 'converting' | 'textures' | 'importing' | 'writing';

export interface RunningProjectAction {
  pluginId: string;
  contributionId: string;
  step: ProjectStep;
}

export type ProjectActionOutcome =
  | { status: 'imported'; name: string; warnings: string[] }
  | { status: 'exported'; where: string; warnings: string[] }
  | { status: 'cancelled' }
  | { status: 'stale' }
  | { status: 'failed'; message: string };

export interface ProjectContributionRef<T> {
  installed: InstalledPlugin;
  contribution: T;
}

/** Why an operation stopped without a result, so the caller can say which. */
class StaleContext extends Error {}

/**
 * Runs the project importers and exporters of installed, switched-on plugins
 * — the only way the app imports from Shadertoy or exports a Wallpaper Engine
 * project. Contributions are dispatched by their validated metadata (kind,
 * provider, runtime) to the host adapters registered for them; nothing here
 * knows a package by name.
 *
 * Every operation captures the profile, the open shader and the package's
 * version and install time when it starts, and is refused before anything is
 * adopted or written if any of them changed. Switching the package off,
 * updating or removing it, signing in or out, or opening another shader aborts
 * it, delivery included. One runs at a time.
 */
@Injectable({ providedIn: 'root' })
export class ProjectPluginActions {
  private readonly installations = inject(PluginInstallations);
  private readonly adapters = inject(HostAdapters);
  private readonly store = inject(ShaderStore);
  private readonly desktop = inject(DesktopPlatform);
  private readonly i18n = inject(I18n);
  // Resolved on use: the workspace verbs reach back here for their plugin entry points.
  private readonly injector = inject(Injector);

  private readonly runningSignal = signal<RunningProjectAction | null>(null);
  readonly running = this.runningSignal.asReadonly();
  private cancelCurrent: AbortController | null = null;

  /** For tests: where exports go. Defaults to a folder on the desktop and a ZIP in the browser. */
  writer: () => ProjectWriter = () =>
    this.desktop.available ? new DesktopFolderWriter() : new ZipDownloadWriter();

  /** Active project importers whose provider (if they use one) this app has. */
  readonly importers = computed(() =>
    this.contributions<ProjectImporterContribution>('projectImporter').filter(
      ({ contribution }) =>
        !contribution.provider || this.adapters.provider(contribution.provider) !== null,
    ),
  );

  /** Active project exporters whose runtime this app has. */
  readonly exporters = computed(() =>
    this.contributions<ProjectExporterContribution>('projectExporter').filter(
      ({ contribution }) => this.adapters.runtime(contribution.runtime) !== null,
    ),
  );

  /** The first active importer using a provider, e.g. `shadertoy-api/v1`. */
  importerFor(provider: string): ProjectContributionRef<ProjectImporterContribution> | null {
    return this.importers().find(({ contribution }) => contribution.provider === provider) ?? null;
  }

  /** The first active exporter for a runtime, e.g. `wallpaper-web/v1`. */
  exporterFor(runtime: string): ProjectContributionRef<ProjectExporterContribution> | null {
    return this.exporters().find(({ contribution }) => contribution.runtime === runtime) ?? null;
  }

  cancel(): void {
    this.cancelCurrent?.abort(new Error('Cancelled'));
  }

  async runImport(
    pluginId: string,
    contributionId: string,
    request: ProjectImportRequest,
  ): Promise<ProjectActionOutcome> {
    const found = this.find<ProjectImporterContribution>(
      pluginId,
      contributionId,
      'projectImporter',
    );
    if (!found) return { status: 'failed', message: 'This importer is not available.' };
    const { contribution } = found;
    const provider = contribution.provider ? this.adapters.provider(contribution.provider) : null;
    if (contribution.provider && !provider) {
      return { status: 'failed', message: 'This app cannot run that importer.' };
    }

    return this.operate(pluginId, contributionId, async (signal, step, check) => {
      const host = this.installations.host(pluginId);
      if (!host) throw new StaleContext();
      let input: ProjectImportInput;
      let idSuffix: string | undefined;
      if (request.mode === 'provider') {
        if (!provider || !contribution.provider) throw new Error('No provider');
        step('fetching');
        const source = await provider.fetchSource(request.values, signal);
        idSuffix = source.sourceId;
        input = { mode: 'provider', provider: contribution.provider, ...source };
      } else {
        input = { mode: 'paste', name: request.name, text: request.text };
      }
      check();
      step('converting');
      const candidate = await host.importProject(contributionId, input, { signal });
      check();
      step('textures');
      const resolved = await resolveProjectCandidate(candidate, provider, {
        signal,
        ...(idSuffix ? { idSuffix } : {}),
      });
      check();
      step('importing');
      const imported = await this.adopt(resolved.bundle, resolved.name, check);
      if (imported === 'declined') return { status: 'cancelled' };
      if (imported === 'failed')
        return { status: 'failed', message: 'The shader could not be imported.' };
      return { status: 'imported', name: resolved.name, warnings: resolved.warnings };
    });
  }

  async runExport(pluginId: string, contributionId: string): Promise<ProjectActionOutcome> {
    const found = this.find<ProjectExporterContribution>(
      pluginId,
      contributionId,
      'projectExporter',
    );
    if (!found) return { status: 'failed', message: 'This exporter is not available.' };
    const runtime = this.adapters.runtime(found.contribution.runtime);
    if (!runtime) return { status: 'failed', message: 'This app cannot run that exporter.' };
    const record = this.store.record();
    const draft = this.store.draft();
    if (!record || !draft) return { status: 'failed', message: 'Open a shader first.' };

    return this.operate(pluginId, contributionId, async (signal, step, check) => {
      const host = this.installations.host(pluginId);
      if (!host) throw new StaleContext();
      // The snapshot is the draft as it is now — unsaved edits included, nothing saved.
      // Texture bytes come from the library and stay here; the plugin sees their metadata.
      const snapshot = {
        name: record.name,
        author: record.author,
        project: structuredClone(draft.project),
        controls: structuredClone([...this.store.controls()]),
        params: structuredClone(this.store.params()),
        postProcessingActive: hasActivePostProcessing(draft.render),
      };
      step('converting');
      const bundle = (await this.store.exportShader(record.id)) as ShaderBundle;
      check();
      const channels = bundle.shader.channels;
      const input: ProjectExportInput = {
        name: snapshot.name,
        ...(snapshot.author ? { author: snapshot.author } : {}),
        project: snapshot.project,
        controls: snapshot.controls,
        params: snapshot.params,
        channels: channels.map(({ data, ...meta }) => ({
          ...meta,
          present: !!data && !!meta.ext,
        })),
        postProcessingActive: snapshot.postProcessingActive,
      };
      const textures: RuntimeTexture[] = channels.flatMap((channel, slot) =>
        channel.data && channel.ext
          ? [{ slot, ext: channel.ext, bytes: fromBase64(channel.data) }]
          : [],
      );
      const result = await host.exportProject(contributionId, input, { signal });
      check();
      const output = runtime.assemble(result.data, textures);
      if (!output.ok) throw new Error(output.errors[0] ?? 'The exported project is not valid');
      step('writing');
      check();
      // The context is checked again once a destination is chosen, and the write is
      // cancelled with the signal — on the desktop, in the main process too.
      const delivered = await this.writer().write(output.value, signal, check);
      if (delivered.status === 'cancelled') {
        check(); // a delivery stopped because the context changed is reported as such
        return { status: 'cancelled' };
      }
      return { status: 'exported', where: delivered.where, warnings: result.warnings };
    });
  }

  private async adopt(
    bundle: ShaderBundle,
    name: string,
    check: () => void,
  ): Promise<'imported' | 'declined' | 'failed'> {
    let outcome: 'imported' | 'failed' = 'failed';
    // The usual unsaved-changes guard; the context is checked again once it is answered.
    const went = await this.injector.get(WorkspaceActions).guardedTransition(async () => {
      check();
      const notice = this.i18n.t('plugins.importedShader', { name });
      outcome = (await this.store.importProjectBundle(bundle, notice)) ? 'imported' : 'failed';
    });
    return went ? outcome : 'declined';
  }

  private async operate(
    pluginId: string,
    contributionId: string,
    work: (
      signal: AbortSignal,
      step: (step: ProjectStep) => void,
      check: () => void,
    ) => Promise<ProjectActionOutcome>,
  ): Promise<ProjectActionOutcome> {
    if (this.runningSignal())
      return { status: 'failed', message: 'Another plugin action is running.' };
    const context = this.installations.context(pluginId);
    if (!context) return { status: 'failed', message: 'Switch the plugin on to use it.' };
    // Imports and exports alike finish only against the shader that was open (or not) at the start.
    const shaderId = this.store.selectedId();
    const pending = this.installations.begin(pluginId);
    const cancel = new AbortController();
    this.cancelCurrent = cancel;
    // Opening another shader at any point aborts the operation's signal — not only at the
    // next check — so a delivery already under way (a desktop folder write in the main
    // process) is cancelled before it commits.
    const invalidated = new AbortController();
    const watch = effect(
      () => {
        if (this.store.selectedId() !== shaderId) {
          untracked(() => invalidated.abort(new StaleContext()));
        }
      },
      { injector: this.injector, manualCleanup: true },
    );
    const signal = AbortSignal.any([pending.signal, cancel.signal, invalidated.signal]);
    const check = () => {
      if (cancel.signal.aborted) throw cancel.signal.reason;
      if (
        pending.signal.aborted ||
        invalidated.signal.aborted ||
        !this.installations.isCurrent(context) ||
        this.store.selectedId() !== shaderId
      ) {
        throw new StaleContext();
      }
    };
    this.runningSignal.set({ pluginId, contributionId, step: 'converting' });
    try {
      return await work(
        signal,
        (step) => this.runningSignal.set({ pluginId, contributionId, step }),
        check,
      );
    } catch (error) {
      if (cancel.signal.aborted) return { status: 'cancelled' };
      if (
        error instanceof StaleContext ||
        invalidated.signal.aborted ||
        pending.signal.aborted ||
        !this.installations.isCurrent(context)
      ) {
        return { status: 'stale' };
      }
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    } finally {
      watch.destroy();
      pending.done();
      this.cancelCurrent = null;
      this.runningSignal.set(null);
    }
  }

  private find<T>(
    pluginId: string,
    contributionId: string,
    kind: string,
  ): ProjectContributionRef<T> | null {
    const installed = this.installations.find(pluginId);
    const contribution = installed?.plugin?.manifest.contributions.find(
      (entry) => entry.id === contributionId && entry.kind === kind,
    );
    return installed?.active && contribution
      ? { installed, contribution: contribution as T }
      : null;
  }

  private contributions<T>(kind: string): ProjectContributionRef<T>[] {
    return this.installations
      .plugins()
      .filter((installed) => installed.active && installed.plugin)
      .flatMap((installed) =>
        installed
          .plugin!.manifest.contributions.filter((contribution) => contribution.kind === kind)
          .map((contribution) => ({ installed, contribution: contribution as T })),
      );
  }
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
