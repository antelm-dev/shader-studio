import { isPlatformServer } from '@angular/common';
import {
  Injectable,
  PLATFORM_ID,
  TransferState,
  computed,
  effect,
  inject,
  makeStateKey,
  signal,
} from '@angular/core';

import {
  DEFAULT_CHANNELS,
  type ImportMode,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type ShaderRecord,
  type ShaderSummary,
  type ParamValue,
  type TextureChannels,
  type TextureChannelSettingsPatch,
} from '../../shared/model';
import {
  defaultParams,
  extFromMime,
  LIMITS,
  sanitizeParams,
  validateControls,
} from '../../shared/validate';
import type { CompileDiagnostic } from './diagnostic';
import { DraftRecovery, type RecoveredDraft } from './draft-recovery';
import { ApiError, ShaderApi } from './shader-api';
import { Preferences } from './preferences';
import { TextureAssets } from './texture-assets';

/**
 * The single source of truth for the workspace.
 *
 * Three layers of state, deliberately distinct:
 *
 *  - `record`  — the shader exactly as the server last gave it to us.
 *  - `draft`   — the editor buffers. Diverges from `record` while editing;
 *                `dirty` is the difference. Saving pushes it to the API.
 *  - `params`  — the live uniform values. These are *not* part of the draft:
 *                turning a knob is not an unsaved edit to the source, it is a
 *                value you can capture as a preset.
 *
 * Rendering, editing and persistence all read from here and none of them know
 * about each other.
 */

/** The editable buffers behind the source editor. */
export interface ShaderDraft {
  fragment: string;
  vertex: string;
  /** The control schema, as JSON text — this is what the config tab edits. */
  controlsText: string;
  render: RenderSettings;
}

function controlsToText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}

/**
 * What the server rendered, handed to the client inside the HTML.
 *
 * Without this the client's first render would start from an empty store while
 * the SSR markup already showed a shader, and hydration would throw the whole
 * subtree away. Reading it synchronously in the constructor means the first
 * client render is identical to the server's.
 */
interface StoreSnapshot {
  shaders: readonly ShaderSummary[];
  record: ShaderRecord | null;
}

const SNAPSHOT_KEY = makeStateKey<StoreSnapshot>('shader-studio.snapshot');

@Injectable({ providedIn: 'root' })
export class ShaderStore {
  private readonly api = inject(ShaderApi);
  private readonly preferences = inject(Preferences);
  private readonly transferState = inject(TransferState);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));
  private readonly recovery = inject(DraftRecovery);
  private readonly textures = inject(TextureAssets);

  /** True once the client has taken over the server's snapshot. */
  private hydrated = false;

  constructor() {
    this.recovery.onWarning = () =>
      this.notice.set({
        text: 'Local draft recovery is unavailable in this browser session',
        error: true,
      });

    effect((onCleanup) => {
      const record = this.record();
      const draft = this.draft();
      const dirty = this.dirty();
      if (!record || !draft) return;
      const timer = setTimeout(() => {
        if (dirty) this.recovery.put(record.id, record.updatedAt, draft);
        else this.recovery.remove(record.id);
      }, 350);
      onCleanup(() => clearTimeout(timer));
    });

    if (this.isServer || !this.transferState.hasKey(SNAPSHOT_KEY)) return;

    const snapshot = this.transferState.get(SNAPSHOT_KEY, null);
    this.transferState.remove(SNAPSHOT_KEY);
    if (!snapshot) return;

    this.shaders.set(snapshot.shaders);
    if (snapshot.record) this.adopt(snapshot.record);
    this.hydrated = true;
  }

  // --- Raw state ----------------------------------------------------------

  readonly shaders = signal<readonly ShaderSummary[]>([]);
  readonly record = signal<ShaderRecord | null>(null);
  readonly draft = signal<ShaderDraft | null>(null);
  readonly params = signal<ShaderParams>({});

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly activePresetId = signal<string | null>(null);

  /** Compile + config diagnostics for the current draft. */
  readonly diagnostics = signal<readonly CompileDiagnostic[]>([]);

  /** Last message worth showing the user (error or confirmation). */
  readonly notice = signal<{ text: string; error: boolean } | null>(null);
  readonly staleRecovery = signal<RecoveredDraft | null>(null);

  // --- Derived ------------------------------------------------------------

  readonly selectedId = computed(() => this.record()?.id ?? null);

  readonly presets = computed<readonly Preset[]>(() => this.record()?.presets ?? []);

  /**
   * Not part of the draft: like presets, assigning a texture is an immediate,
   * persisted action rather than a discardable source edit, so it stays
   * outside the unsaved-changes/recovery machinery that covers `draft`.
   */
  readonly channels = computed<TextureChannels>(() => this.record()?.channels ?? DEFAULT_CHANNELS);

  /**
   * The schema the GUI and the uniforms are built from: the draft's, if it
   * parses, otherwise the last known-good one from the record. A half-typed
   * config must not tear down a working control panel.
   */
  readonly controls = computed<readonly ShaderControl[]>(() => {
    const draft = this.draft();
    if (!draft) return [];
    const parsed = this.parseControls(draft.controlsText);
    return parsed ?? this.record()?.controls ?? [];
  });

  readonly configValid = computed(() => {
    const draft = this.draft();
    return draft === null || this.parseControls(draft.controlsText) !== null;
  });

  readonly dirty = computed(() => {
    const record = this.record();
    const draft = this.draft();
    if (!record || !draft) return false;
    return (
      draft.fragment !== record.fragment ||
      draft.vertex !== record.vertex ||
      draft.controlsText !== controlsToText(record.controls) ||
      JSON.stringify(draft.render) !== JSON.stringify(record.render)
    );
  });

  readonly hasErrors = computed(() =>
    this.diagnostics().some((diagnostic) => diagnostic.severity === 'error'),
  );

  // --- Loading ------------------------------------------------------------

  /**
   * Load the collection and open the first shader, then publish the result for
   * the client to pick up. Runs during SSR, against the same Express process's
   * own `/api`.
   *
   * The server deliberately does *not* honour `lastShaderId`: it has no access
   * to the browser's storage, and rendering a different shader than the client
   * would then hydrate is exactly the mismatch this snapshot exists to avoid.
   * The client switches to the remembered shader once it takes over.
   */
  async initialize(routeShaderId?: string | null): Promise<void> {
    await this.refreshList();

    const shaders = this.shaders();
    const requested =
      routeShaderId && shaders.some((shader) => shader.id === routeShaderId)
        ? routeShaderId
        : shaders[0]?.id;
    if (requested) await this.select(requested);

    if (this.isServer) {
      this.transferState.set(SNAPSHOT_KEY, {
        shaders: this.shaders(),
        record: this.record(),
      });
    }
  }

  /**
   * Called once the browser has taken over. If the server already sent a
   * snapshot there is nothing to fetch — we only need to honour the shader the
   * user last had open.
   */
  async initializeClient(routeShaderId?: string | null): Promise<void> {
    // Read before `initialize`, not after: opening the first shader writes it
    // to `lastShaderId`, which would leave nothing left to honour.
    const preferred = routeShaderId ?? this.preferences.value().lastShaderId;

    if (!this.hydrated) {
      await this.initialize(routeShaderId);
    }

    if (preferred && preferred !== this.selectedId()) {
      if (this.shaders().some((shader) => shader.id === preferred)) {
        await this.select(preferred);
      }
    }
  }

  async refreshList(): Promise<void> {
    try {
      this.shaders.set(await this.api.list());
    } catch (error) {
      this.report(error);
    }
  }

  async select(id: string): Promise<void> {
    if (this.selectedId() === id && this.record() !== null) return;

    this.loading.set(true);
    try {
      this.adopt(await this.api.read(id));
      this.preferences.patch({ lastShaderId: id });
    } catch (error) {
      this.report(error);
    } finally {
      this.loading.set(false);
    }
  }

  /** Take a server record as the new truth and reset the draft and params onto it. */
  private adopt(record: ShaderRecord): void {
    this.record.set(record);
    this.draft.set({
      fragment: record.fragment,
      vertex: record.vertex,
      controlsText: controlsToText(record.controls),
      render: structuredClone(record.render),
    });
    this.params.set(defaultParams(record.controls));
    this.activePresetId.set(null);
    this.diagnostics.set([]);

    const recovered = this.isServer ? null : this.recovery.get(record.id);
    if (recovered?.baselineUpdatedAt === record.updatedAt) this.applyRecoveredDraft(recovered);
    else this.staleRecovery.set(recovered);
  }

  resolveRecovery(restore: boolean): void {
    const recovered = this.staleRecovery();
    if (!recovered) return;
    if (restore && recovered.shaderId === this.selectedId()) this.applyRecoveredDraft(recovered);
    else this.recovery.remove(recovered.shaderId);
    this.staleRecovery.set(null);
  }

  discardCurrentDraft(): void {
    const record = this.record();
    if (!record) return;
    this.recovery.remove(record.id);
    this.adopt(record);
  }

  flushRecovery(): void {
    const record = this.record();
    const draft = this.draft();
    if (record && draft && this.dirty()) this.recovery.put(record.id, record.updatedAt, draft);
  }

  private applyRecoveredDraft(recovered: RecoveredDraft): void {
    this.draft.set({
      fragment: recovered.fragment,
      vertex: recovered.vertex,
      controlsText: recovered.controlsText,
      render: structuredClone(recovered.render),
    });
    this.setControlsText(recovered.controlsText);
  }

  // --- Editing ------------------------------------------------------------

  setFragment(fragment: string): void {
    this.patchDraft({ fragment });
  }

  setVertex(vertex: string): void {
    this.patchDraft({ vertex });
  }

  /**
   * Update the config buffer. When it parses, re-project the live params onto
   * the new schema straight away, so adding a control makes its knob appear
   * without a save and removing one drops its value.
   */
  setControlsText(controlsText: string): void {
    this.patchDraft({ controlsText });

    const parsed = this.parseControls(controlsText);
    this.diagnostics.update((all) => all.filter((entry) => entry.source !== 'config'));

    if (parsed) {
      this.params.update((current) => sanitizeParams(parsed, current));
      return;
    }

    this.diagnostics.update((all) => [
      ...all,
      ...this.configErrors(controlsText).map(
        (message): CompileDiagnostic => ({
          severity: 'error',
          line: 0,
          message,
          source: 'config',
        }),
      ),
    ]);
  }

  setRender(render: RenderSettings): void {
    this.patchDraft({ render });
  }

  private patchDraft(patch: Partial<ShaderDraft>): void {
    this.draft.update((draft) => (draft ? { ...draft, ...patch } : draft));
  }

  /** Returns the parsed schema, or null if the text is not a valid schema. */
  private parseControls(text: string): ShaderControl[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    const result = validateControls(parsed);
    return result.ok ? result.value : null;
  }

  /** The reason `parseControls` said no, phrased for the diagnostics panel. */
  private configErrors(text: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return [`Config is not valid JSON: ${(error as Error).message}`];
    }
    const result = validateControls(parsed);
    return result.ok ? [] : result.errors;
  }

  // --- Params -------------------------------------------------------------

  setParam(key: string, value: ParamValue): void {
    this.params.update((params) => ({ ...params, [key]: value }));
    // The values no longer match the preset they came from.
    this.activePresetId.set(null);
  }

  resetParams(): void {
    this.params.set(defaultParams(this.controls()));
    this.activePresetId.set(null);
  }

  // --- Diagnostics --------------------------------------------------------

  /** Replace the compile diagnostics, leaving config diagnostics in place. */
  setCompileDiagnostics(diagnostics: readonly CompileDiagnostic[]): void {
    this.diagnostics.update((all) => [
      ...all.filter((entry) => entry.source === 'config'),
      ...diagnostics,
    ]);
  }

  // --- Persistence --------------------------------------------------------

  async save(): Promise<boolean> {
    const record = this.record();
    const draft = this.draft();
    if (!record || !draft || this.saving()) return false;

    const controls = this.parseControls(draft.controlsText);
    if (!controls) {
      this.notice.set({ text: 'Fix the configuration schema before saving', error: true });
      return false;
    }

    this.saving.set(true);
    try {
      const saved = await this.api.update(record.id, {
        fragment: draft.fragment,
        vertex: draft.vertex,
        controls,
        render: draft.render,
      });

      // Keep the live params and the open preset across a save: the user was
      // editing the source, not resetting the knobs.
      const params = this.params();
      const presetId = this.activePresetId();
      this.record.set(saved);
      this.draft.set({
        fragment: saved.fragment,
        vertex: saved.vertex,
        controlsText: controlsToText(saved.controls),
        render: structuredClone(saved.render),
      });
      this.params.set(sanitizeParams(saved.controls, params));
      this.activePresetId.set(presetId);

      await this.refreshList();
      this.notice.set({ text: `Saved “${saved.name}”`, error: false });
      this.recovery.remove(saved.id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  revert(): void {
    this.discardCurrentDraft();
  }

  // --- Collection actions -------------------------------------------------

  async create(name: string): Promise<void> {
    try {
      const created = await this.api.create(name);
      await this.refreshList();
      this.adopt(created);
      this.preferences.patch({ lastShaderId: created.id });
      this.notice.set({ text: `Created “${created.name}”`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  async duplicate(id: string, name?: string): Promise<void> {
    try {
      const copy = await this.api.duplicate(id, name);
      await this.refreshList();
      this.adopt(copy);
      this.preferences.patch({ lastShaderId: copy.id });
      this.notice.set({ text: `Duplicated as “${copy.name}”`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  async rename(id: string, name: string): Promise<void> {
    try {
      const updated = await this.api.update(id, { name });
      await this.refreshList();
      if (this.selectedId() === id) {
        this.record.update((record) => (record ? { ...record, name: updated.name } : record));
      }
      this.notice.set({ text: `Renamed to “${updated.name}”`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.api.remove(id);
      this.recovery.remove(id);
      this.textures.releaseShader(id);
      await this.refreshList();

      if (this.selectedId() === id) {
        this.record.set(null);
        this.draft.set(null);
        this.params.set({});
        this.preferences.patch({ lastShaderId: null });

        const next = this.shaders()[0];
        if (next) await this.select(next.id);
      }
      this.notice.set({ text: 'Shader deleted', error: false });
    } catch (error) {
      this.report(error);
    }
  }

  // --- Presets ------------------------------------------------------------

  /**
   * Capture the live params under a name. `withRender` also stores the render
   * settings currently in the draft, which is what makes a preset able to bring
   * its own bloom back with it.
   */
  async savePreset(name: string, withRender = false): Promise<void> {
    const record = this.record();
    const draft = this.draft();
    if (!record || !draft) return;

    try {
      const preset = await this.api.savePreset(
        record.id,
        name,
        this.params(),
        withRender ? draft.render : undefined,
      );
      const presets = record.presets.some((entry) => entry.id === preset.id)
        ? record.presets.map((entry) => (entry.id === preset.id ? preset : entry))
        : [...record.presets, preset];

      this.record.update((current) => (current ? { ...current, presets } : current));
      this.activePresetId.set(preset.id);
      await this.refreshList();
      this.notice.set({ text: `Saved preset “${preset.name}”`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Apply a preset to the live params. Values are projected onto the *current*
   * schema, so a preset stored against an older set of controls still applies
   * cleanly — anything it does not mention falls back to that control's default.
   *
   * A preset that captured render settings also writes them into the draft, and
   * so can leave the document dirty: bloom is part of the saved shader, not a
   * live knob, and pretending otherwise would lose the change on the next load.
   */
  applyPreset(presetId: string): void {
    const preset = this.presets().find((entry) => entry.id === presetId);
    if (!preset) return;

    this.params.set(sanitizeParams(this.controls(), preset.values));
    if (preset.render) this.setRender(structuredClone(preset.render));
    this.activePresetId.set(preset.id);
  }

  async deletePreset(presetId: string): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      await this.api.deletePreset(record.id, presetId);
      this.record.update((current) =>
        current
          ? { ...current, presets: current.presets.filter((preset) => preset.id !== presetId) }
          : current,
      );
      if (this.activePresetId() === presetId) this.activePresetId.set(null);
      await this.refreshList();
      this.notice.set({ text: 'Preset deleted', error: false });
    } catch (error) {
      this.report(error);
    }
  }

  // --- Textures -------------------------------------------------------------

  /**
   * Decodes the file locally first, both to reject anything that is not
   * actually an image before spending a round trip on it, and to get the
   * pixel dimensions the server wants alongside the bytes.
   */
  async setTextureImage(channel: 0 | 1 | 2 | 3, file: File): Promise<void> {
    const record = this.record();
    if (!record) return;

    const ext = extFromMime(file.type);
    if (!ext) {
      this.notice.set({ text: `“${file.name}” must be a PNG, JPEG or WebP image`, error: true });
      return;
    }
    if (file.size > LIMITS.textureBytes) {
      this.notice.set({
        text: `“${file.name}” is larger than ${Math.round(LIMITS.textureBytes / (1024 * 1024))} MB`,
        error: true,
      });
      return;
    }

    let width: number;
    let height: number;
    try {
      const bitmap = await createImageBitmap(file);
      width = bitmap.width;
      height = bitmap.height;
      bitmap.close();
    } catch {
      this.notice.set({ text: `“${file.name}” is not a readable image`, error: true });
      return;
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const updated = await this.api.setTexture(record.id, channel, { ext, bytes, width, height });
      this.textures.releaseShader(record.id);
      this.record.set(updated);
      await this.refreshList();
      this.notice.set({ text: `Assigned “${file.name}” to iChannel${channel}`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  async clearTextureImage(channel: 0 | 1 | 2 | 3): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      const updated = await this.api.clearTexture(record.id, channel);
      this.textures.releaseShader(record.id);
      this.record.set(updated);
      await this.refreshList();
      this.notice.set({ text: `Cleared iChannel${channel}`, error: false });
    } catch (error) {
      this.report(error);
    }
  }

  async setChannelSettings(
    channel: 0 | 1 | 2 | 3,
    patch: TextureChannelSettingsPatch,
  ): Promise<void> {
    const record = this.record();
    if (!record) return;

    const channels: TextureChannelSettingsPatch[] = [0, 1, 2, 3].map((index) =>
      index === channel ? patch : {},
    );

    try {
      const updated = await this.api.update(record.id, { channels });
      this.record.set(updated);
    } catch (error) {
      this.report(error);
    }
  }

  // --- Import / export ----------------------------------------------------

  async exportShader(id: string): Promise<unknown> {
    return this.api.exportShader(id);
  }

  async exportAll(): Promise<unknown> {
    return this.api.exportAll();
  }

  async importBundle(bundle: unknown, mode: ImportMode = 'rename'): Promise<void> {
    try {
      const result = await this.api.importBundle(bundle, mode);
      await this.refreshList();

      const first = result.imported[0];
      if (first) await this.forceSelect(first.id);

      const replaced = result.imported.filter((entry) => entry.replaced).length;
      this.notice.set({
        text:
          `Imported ${result.imported.length} shader${result.imported.length === 1 ? '' : 's'}` +
          (replaced ? ` (${replaced} replaced)` : ''),
        error: false,
      });
    } catch (error) {
      this.report(error);
    }
  }

  /** `select`, but reloads even if the id is already the open one. */
  private async forceSelect(id: string): Promise<void> {
    this.record.set(null);
    await this.select(id);
  }

  // --- Misc ---------------------------------------------------------------

  private report(error: unknown): void {
    const message = error instanceof ApiError ? error.summary : String(error);
    console.error('[shader-store]', error);
    this.notice.set({ text: message, error: true });
  }
}
