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
} from '@shader-studio/shared/model';
import {
  addBuffer,
  addFile,
  bufferPasses,
  displayPasses,
  duplicateFile,
  duplicatePass,
  findFile,
  findPass,
  freeSlot,
  imagePass,
  migrateLegacyProject,
  moveFile,
  movePass,
  removeFile,
  removePass,
  renameFile,
  renamePass,
  resolvePassOrder,
  setChannelBinding,
  setFileSource,
  setPassEnabled,
  setPassResolution,
  setPassSampling,
  setPassSource,
  setVertexSource,
  type BufferSlot,
  type ChannelBinding,
  type ChannelIndex,
  type PassKind,
  type PassResolution,
  type ProjectError,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';
import {
  defaultParams,
  extFromMime,
  LIMITS,
  sanitizeParams,
  validateControls,
  validateParamValue,
} from '@shader-studio/shared/validate';
import { CONFIG_DOC, VERTEX_DOC, type CompileDiagnostic } from './diagnostic';
import { DraftRecovery, type RecoveredDraft } from './draft-recovery';
import { ProjectPersistence } from './project-persistence';
import { RendererHandle } from '../rendering/renderer-handle';
import { ApiError, ShaderApi } from './shader-api';
import { Preferences } from './preferences';
import { TextureAssets } from './texture-assets';
import { ThumbnailAssets } from './thumbnail-assets';

/**
 * The single source of truth for the workspace.
 *
 * Four layers of state, deliberately distinct:
 *
 *  - `record`  — the shader exactly as the server last gave it to us.
 *  - `saved`   — the project as last committed: the record's fragment and vertex,
 *                plus the passes and files that only exist locally. `dirty` is
 *                the difference between this and the draft.
 *  - `draft`   — the editor buffers: the whole project, the config text, and the
 *                render settings. Saving pushes it to the API and to storage.
 *  - `params`  — the live uniform values. These are *not* part of the draft:
 *                turning a knob is not an unsaved edit to the source, it is a
 *                value you can capture as a preset.
 *
 * Rendering, editing and persistence all read from here and none of them know
 * about each other. In particular, nothing outside this file knows that a
 * project is stored in two places — the store is what makes a record and its
 * passes look like one document.
 */

/** The editable buffers behind the source editor. */
export interface ShaderDraft {
  /**
   * Every source the user can edit: the Image pass, Common, the buffers, the
   * vertex shader and the plain files. The Image pass's source is what the
   * server knows as `fragment`, which is why `fragment` below is derived rather
   * than stored — two copies of the same string is one copy too many.
   */
  project: ShaderProject;
  /** The control schema, as JSON text — this is what the config tab edits. */
  controlsText: string;
  render: RenderSettings;
}

/**
 * Anything the editor can open a tab for.
 *
 * Passes and files are deliberately in one namespace with `@vertex` and
 * `@config`: a tab is a tab, a diagnostic points at one of these ids whatever
 * kind of thing it is, and the tab bar's only job is to *show* the difference
 * between a render pass and a plain file rather than to model it twice.
 */
export type DocumentKind = 'pass' | 'file' | 'vertex' | 'config';

export interface EditorDocument {
  id: string;
  kind: DocumentKind;
  name: string;
  language: 'glsl' | 'json';
  source: string;
  /** Passes only: which of Image / Common / Buffer this is. */
  passKind?: PassKind;
  slot?: BufferSlot | null;
  /** Passes only. A disabled buffer is still editable — it just does not render. */
  enabled?: boolean;
}

/** A finished compile, tied to the revision it was compiled from. */
export interface CompileOutcome {
  revision: number;
  diagnostics: readonly CompileDiagnostic[];
}

interface CompileWaiter {
  resolve: (outcome: CompileOutcome) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One replacement of `[start, end)` in a document's source with `text`. Offsets are 0-based character positions. */
export interface DraftTextEdit {
  documentId: string;
  start: number;
  end: number;
  text: string;
}

export type ApplyPatchResult =
  | { ok: true; revision: number; diagnostics: readonly CompileDiagnostic[] }
  | {
      ok: false;
      code: 'STALE_REVISION' | 'VALIDATION_ERROR' | 'NOT_FOUND';
      message: string;
      currentRevision?: number;
    };

export interface SetParamsOutcome {
  applied: string[];
  errors: Record<string, string>;
}

function controlsToText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}

/**
 * One error, once.
 *
 * The Common pass is compiled into every pass that uses it, so a typo in Common
 * comes back from the driver once per pass — three passes, three identical
 * complaints about the same line of the same file. The user made one mistake and
 * should be shown one error.
 */
function dedupe(diagnostics: readonly CompileDiagnostic[]): CompileDiagnostic[] {
  const seen = new Set<string>();
  const unique: CompileDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.docId ?? ''}|${diagnostic.line}|${diagnostic.severity}|${diagnostic.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
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
  private readonly projects = inject(ProjectPersistence);
  private readonly textures = inject(TextureAssets);
  private readonly thumbnails = inject(ThumbnailAssets);
  private readonly renderer = inject(RendererHandle);

  /** True once the client has taken over the server's snapshot. */
  private hydrated = false;

  constructor() {
    this.recovery.onWarning = () =>
      this.notice.set({
        text: 'Local draft recovery is unavailable in this browser session',
        error: true,
      });

    this.projects.onWarning = () =>
      this.notice.set({
        text: 'Local storage is full, so buffers and files may not survive a reload',
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

  /**
   * The project as last committed — what `dirty` is measured against.
   *
   * Kept apart from `record` because the record cannot express it: the server
   * only knows the Image pass and the vertex shader, so a change to Buffer B
   * would otherwise be invisible to the unsaved-changes machinery, and closing
   * the tab would take it with no warning at all.
   */
  private readonly savedProject = signal<ShaderProject | null>(null);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly activePresetId = signal<string | null>(null);

  /** The document the editor is showing. One of `documents()`. */
  readonly activeDocId = signal<string | null>(null);

  /** Compile + config diagnostics for the current draft. */
  readonly diagnostics = signal<readonly CompileDiagnostic[]>([]);

  /** Passes that are currently being recompiled, so their tabs can say so. */
  readonly compiling = signal<ReadonlySet<string>>(new Set());

  /** Last message worth showing the user (error or confirmation). */
  readonly notice = signal<{ text: string; error: boolean } | null>(null);
  readonly staleRecovery = signal<RecoveredDraft | null>(null);

  /**
   * Bumped once by every `patchDraft` call — the single choke point behind
   * every project/controls/render mutation. This is what `apply_shader_patch`
   * checks a `baseRevision` against, and what `waitForCompile` correlates a
   * finished compile back to a specific edit.
   */
  readonly draftRevision = signal(0);

  /** The revision `recordCompileResult` most recently landed. -1 until the first compile. */
  readonly compiledRevision = signal(-1);

  /** Bumped to ask `shader-canvas` to flush its debounce timer immediately instead of waiting ~400ms. */
  readonly immediateCompileRequest = signal(0);

  private lastCompileOutcome: CompileOutcome | null = null;
  private readonly compileWaiters = new Map<number, CompileWaiter[]>();

  // --- Derived ------------------------------------------------------------

  readonly selectedId = computed(() => this.record()?.id ?? null);

  readonly presets = computed<readonly Preset[]>(() => this.record()?.presets ?? []);

  /**
   * Not part of the draft: like presets, assigning a texture is an immediate,
   * persisted action rather than a discardable source edit, so it stays
   * outside the unsaved-changes/recovery machinery that covers `draft`.
   */
  readonly channels = computed<TextureChannels>(() => this.record()?.channels ?? DEFAULT_CHANNELS);

  // --- The project --------------------------------------------------------

  readonly project = computed<ShaderProject | null>(() => this.draft()?.project ?? null);

  /** The Image pass's source. What the server calls the shader's `fragment`. */
  readonly fragment = computed(() => {
    const project = this.project();
    return project ? imagePass(project).source : '';
  });

  readonly vertex = computed(() => this.project()?.vertex ?? '');

  readonly passes = computed<readonly RenderPass[]>(() => {
    const project = this.project();
    return project ? displayPasses(project) : [];
  });

  readonly buffers = computed<readonly RenderPass[]>(() => {
    const project = this.project();
    return project ? bufferPasses(project) : [];
  });

  readonly canAddBuffer = computed(() => {
    const project = this.project();
    return project !== null && freeSlot(project) !== null;
  });

  /**
   * The render order, and everything wrong with the wiring that produced it.
   *
   * Both come out of the same walk of the graph, because they are the same
   * question: a cycle *is* the reason an order could not be found. Splitting them
   * would mean walking twice and risking two different answers.
   */
  private readonly graph = computed(() => {
    const project = this.project();
    return project
      ? resolvePassOrder(project)
      : { order: [] as RenderPass[], errors: [] as ProjectError[] };
  });

  readonly renderOrder = computed<readonly RenderPass[]>(() => this.graph().order);
  readonly projectErrors = computed<readonly ProjectError[]>(() => this.graph().errors);

  /** Every tab the editor can show, in the order it shows them. */
  readonly documents = computed<readonly EditorDocument[]>(() => {
    const draft = this.draft();
    if (!draft) return [];

    const project = draft.project;

    return [
      ...displayPasses(project).map(
        (pass): EditorDocument => ({
          id: pass.id,
          kind: 'pass',
          name: pass.name,
          language: 'glsl',
          source: pass.source,
          passKind: pass.kind,
          slot: pass.slot,
          enabled: pass.enabled,
        }),
      ),
      ...project.files.map(
        (file): EditorDocument => ({
          id: file.id,
          kind: 'file',
          name: file.name,
          language: 'glsl',
          source: file.source,
        }),
      ),
      { id: VERTEX_DOC, kind: 'vertex', name: 'Vertex', language: 'glsl', source: project.vertex },
      {
        id: CONFIG_DOC,
        kind: 'config',
        name: 'Config',
        language: 'json',
        source: draft.controlsText,
      },
    ];
  });

  /**
   * The open document. Falls back to the Image pass rather than to nothing: a
   * tab can be deleted while it is open, and an editor showing nothing at all is
   * a worse answer than an editor showing the one document that always exists.
   */
  readonly activeDoc = computed<EditorDocument | null>(() => {
    const documents = this.documents();
    if (documents.length === 0) return null;

    const id = this.activeDocId();
    return documents.find((document) => document.id === id) ?? documents[0];
  });

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

  /**
   * The project is compared against `savedProject`, not against the record: the
   * record has no idea Buffer B exists, so measuring dirtiness against it would
   * silently discard every change to a buffer, a file or a channel binding — the
   * exact edits this whole feature is about.
   */
  readonly dirty = computed(() => {
    const record = this.record();
    const draft = this.draft();
    const saved = this.savedProject();
    if (!record || !draft) return false;

    return (
      JSON.stringify(draft.project) !== JSON.stringify(saved) ||
      draft.controlsText !== controlsToText(record.controls) ||
      JSON.stringify(draft.render) !== JSON.stringify(record.render)
    );
  });

  /**
   * A broken graph is an error like any other, and belongs in the same list: a
   * circular buffer dependency is exactly as much a reason the shader is not
   * doing what you asked as a missing semicolon, and hiding it somewhere else
   * would leave the editor showing no errors while the picture stayed frozen.
   */
  readonly allDiagnostics = computed<readonly CompileDiagnostic[]>(() => {
    const project = this.project();

    const graph = this.projectErrors().map((error): CompileDiagnostic => {
      const pass = error.passId && project ? findPass(project, error.passId) : null;
      return {
        severity: 'error',
        line: 0,
        message: error.message,
        source: 'fragment',
        ...(error.passId ? { docId: error.passId } : {}),
        ...(pass ? { docName: pass.name } : {}),
      };
    });

    return dedupe([...graph, ...this.diagnostics()]);
  });

  readonly hasErrors = computed(() =>
    this.allDiagnostics().some((diagnostic) => diagnostic.severity === 'error'),
  );

  /** Errors belonging to one document — what its tab shows a badge for. */
  diagnosticsFor(docId: string): CompileDiagnostic[] {
    return this.allDiagnostics().filter((diagnostic) => diagnostic.docId === docId);
  }

  errorCountFor(docId: string): number {
    return this.diagnosticsFor(docId).filter((diagnostic) => diagnostic.severity === 'error')
      .length;
  }

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
    const project = this.projectFor(record);

    this.record.set(record);
    this.savedProject.set(structuredClone(project));
    this.draft.set({
      project,
      controlsText: controlsToText(record.controls),
      render: structuredClone(record.render),
    });
    this.params.set(defaultParams(record.controls));
    this.activePresetId.set(null);
    this.diagnostics.set([]);
    this.activeDocId.set(imagePass(project).id);
    this.resetCompileState();

    const recovered = this.isServer ? null : this.recovery.get(record.id);
    if (recovered?.baselineUpdatedAt === record.updatedAt) this.applyRecoveredDraft(recovered);
    else this.staleRecovery.set(recovered);
  }

  /**
   * The project behind a record: the one in storage, or one built from the record.
   *
   * This is the whole of the legacy story, and the reason there is no migration
   * step to run and nothing to go wrong on first load. A shader with nothing in
   * storage is not out of date — it is a project with one pass, and
   * `migrateLegacyProject` says so in one line, binding the four texture slots
   * exactly as the old single-pass engine did.
   *
   * When storage *does* have something but the record has moved on underneath it
   * — an import, an edit in another tab, a desktop sync — the record wins for the
   * two things the record actually owns (the Image source and the vertex shader)
   * and the passes and files are kept. The alternative, throwing the buffers away
   * because the fragment changed, would lose far more than it protects.
   */
  private projectFor(record: ShaderRecord): ShaderProject {
    if (this.isServer) return migrateLegacyProject(record.fragment, record.vertex);

    const stored = this.projects.load(record.id, record.fragment, record.vertex);
    if (!stored) return migrateLegacyProject(record.fragment, record.vertex);

    if (stored.baselineUpdatedAt === record.updatedAt) return stored.project;

    const image = imagePass(stored.project);
    return setVertexSource(setPassSource(stored.project, image.id, record.fragment), record.vertex);
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

  /**
   * A reload is not always something the user chose, so the draft — the *whole*
   * project, buffers and files and wiring included — is mirrored to storage
   * while it is dirty, and `adopt` puts it straight back.
   *
   * This is why nothing else needs to write the project to storage as it is
   * edited. `ProjectPersistence` holds what was *saved*, so that `dirty` has
   * something to measure against; `DraftRecovery` holds what was not. Blurring
   * the two — persisting the live project as though it were saved — would make
   * every unsaved edit look saved the moment the page was reloaded.
   */
  flushRecovery(): void {
    const record = this.record();
    const draft = this.draft();
    if (record && draft && this.dirty()) this.recovery.put(record.id, record.updatedAt, draft);
  }

  private applyRecoveredDraft(recovered: RecoveredDraft): void {
    this.draft.set({
      project: structuredClone(recovered.project),
      controlsText: recovered.controlsText,
      render: structuredClone(recovered.render),
    });
    this.setControlsText(recovered.controlsText);
  }

  // --- Editing ------------------------------------------------------------

  /** The Image pass's source — the shader's `fragment`, by any other name. */
  setFragment(fragment: string): void {
    const project = this.project();
    if (!project) return;
    this.patchProject(setPassSource(project, imagePass(project).id, fragment));
  }

  setVertex(vertex: string): void {
    const project = this.project();
    if (!project) return;
    this.patchProject(setVertexSource(project, vertex));
  }

  /**
   * Write to whichever document the editor is showing.
   *
   * The tab bar does not need to know that a pass, a file, the vertex shader and
   * the config schema are stored in four different places — it has an id and a
   * string, and this is where the id decides what that means.
   */
  setDocSource(id: string, source: string): void {
    const project = this.project();
    if (!project) return;

    if (id === CONFIG_DOC) {
      this.setControlsText(source);
      return;
    }
    if (id === VERTEX_DOC) {
      this.patchProject(setVertexSource(project, source));
      return;
    }
    if (findPass(project, id)) {
      this.patchProject(setPassSource(project, id, source));
      return;
    }
    if (findFile(project, id)) {
      this.patchProject(setFileSource(project, id, source));
    }
  }

  selectDoc(id: string): void {
    this.activeDocId.set(id);
  }

  /** Next or previous tab, wrapping. What Ctrl+PageDown does everywhere else. */
  cycleDoc(step: 1 | -1): void {
    const documents = this.documents();
    if (documents.length === 0) return;

    const current = documents.findIndex((doc) => doc.id === this.activeDoc()?.id);
    const next = (current + step + documents.length) % documents.length;
    this.activeDocId.set(documents[next].id);
  }

  /**
   * Force a recompile now, rather than when the debounce elapses.
   *
   * The renderer recompiles a pass whose *composed source* changed, which means
   * asking for a recompile of a source nobody touched would be a no-op. So the
   * request is a signal the canvas watches, not a source edit: it says "compile,
   * even though nothing changed", which is what the user means by Ctrl+Enter
   * after the driver has been sulking or a texture has finished loading.
   */
  readonly recompileRequest = signal(0);

  recompile(): void {
    this.recompileRequest.update((n) => n + 1);
  }

  // --- Passes -------------------------------------------------------------

  addBufferPass(): void {
    const project = this.project();
    if (!project) return;

    if (!freeSlot(project)) {
      this.notice.set({ text: 'All four buffer slots are in use', error: true });
      return;
    }

    const next = addBuffer(project);
    this.patchProject(next);
    // Open what was just created: making a buffer and then having to go and find
    // it is not a workflow anybody wants.
    this.activeDocId.set(bufferPasses(next).at(-1)?.id ?? this.activeDocId());
  }

  duplicateBufferPass(id: string): void {
    const project = this.project();
    if (!project) return;

    if (!freeSlot(project)) {
      this.notice.set({ text: 'All four buffer slots are in use', error: true });
      return;
    }

    const next = duplicatePass(project, id);
    this.patchProject(next);

    const copy = bufferPasses(next).find(
      (pass) => !bufferPasses(project).some((old) => old.id === pass.id),
    );
    if (copy) this.activeDocId.set(copy.id);
  }

  removeBufferPass(id: string): void {
    const project = this.project();
    if (!project) return;

    this.patchProject(removePass(project, id));
    if (this.activeDocId() === id) this.activeDocId.set(imagePass(project).id);
  }

  renamePassById(id: string, name: string): void {
    const project = this.project();
    if (project) this.patchProject(renamePass(project, id, name));
  }

  setPassEnabledById(id: string, enabled: boolean): void {
    const project = this.project();
    if (project) this.patchProject(setPassEnabled(project, id, enabled));
  }

  movePassTo(id: string, toIndex: number): void {
    const project = this.project();
    if (project) this.patchProject(movePass(project, id, toIndex));
  }

  setPassResolutionById(id: string, patch: Partial<PassResolution>): void {
    const project = this.project();
    if (project) this.patchProject(setPassResolution(project, id, patch));
  }

  setPassSamplingById(
    id: string,
    patch: { filter?: RenderPass['filter']; wrap?: RenderPass['wrap'] },
  ): void {
    const project = this.project();
    if (project) this.patchProject(setPassSampling(project, id, patch));
  }

  setChannel(id: string, channel: ChannelIndex, binding: ChannelBinding): void {
    const project = this.project();
    if (project) this.patchProject(setChannelBinding(project, id, channel, binding));
  }

  // --- Files --------------------------------------------------------------

  addSourceFile(name?: string): void {
    const project = this.project();
    if (!project) return;

    const next = addFile(project, name);
    this.patchProject(next);
    this.activeDocId.set(next.files.at(-1)?.id ?? this.activeDocId());
  }

  duplicateSourceFile(id: string): void {
    const project = this.project();
    if (!project) return;

    const next = duplicateFile(project, id);
    this.patchProject(next);

    const copy = next.files.find((file) => !project.files.some((old) => old.id === file.id));
    if (copy) this.activeDocId.set(copy.id);
  }

  removeSourceFile(id: string): void {
    const project = this.project();
    if (!project) return;

    this.patchProject(removeFile(project, id));
    if (this.activeDocId() === id) this.activeDocId.set(imagePass(project).id);
  }

  renameSourceFile(id: string, name: string): void {
    const project = this.project();
    if (project) this.patchProject(renameFile(project, id, name));
  }

  moveSourceFile(id: string, toIndex: number): void {
    const project = this.project();
    if (project) this.patchProject(moveFile(project, id, toIndex));
  }

  private patchProject(project: ShaderProject): void {
    this.patchDraft({ project });
  }

  /**
   * Update the config buffer. When it parses, re-project the live params onto
   * the new schema straight away, so adding a control makes its knob appear
   * without a save and removing one drops its value.
   */
  setControlsText(controlsText: string): void {
    this.patchDraft({ controlsText });
    this.applyControlsSideEffects(controlsText);
  }

  /**
   * The part of `setControlsText` that is not "write the text": re-project the
   * live params onto the new schema, and (in)validate it into `diagnostics`.
   * Split out so `applyPatch` can run it once after its own single, combined
   * `patchDraft` call — folding it back into `setControlsText` would mean a
   * multi-document patch that happens to touch `@config` bumps the revision
   * twice for one edit.
   */
  private applyControlsSideEffects(controlsText: string): void {
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
    const current = this.draft();
    if (!current) return;
    this.draft.set({ ...current, ...patch });
    this.draftRevision.update((n) => n + 1);
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

  // --- Compile completion & revisions --------------------------------------

  /**
   * Called by `shader-canvas` once a compile for `revision` has actually
   * landed on the GPU — real completion, not a fixed wait. Resolves every
   * `waitForCompile` call whose revision is now satisfied: a waiter for an
   * older revision is satisfied by a newer compile too, since revisions are
   * cumulative and a later one already reflects everything an earlier one
   * would have.
   */
  recordCompileResult(revision: number, diagnostics: readonly CompileDiagnostic[]): void {
    this.setCompileDiagnostics(diagnostics);

    const outcome: CompileOutcome = { revision, diagnostics: this.allDiagnostics() };
    this.lastCompileOutcome = outcome;
    this.compiledRevision.set(revision);

    for (const [waitingRevision, waiters] of [...this.compileWaiters]) {
      if (waitingRevision > revision) continue;
      this.compileWaiters.delete(waitingRevision);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(outcome);
      }
    }
  }

  /** Resolves once a compile at or after `revision` has landed, or rejects after `timeoutMs`. */
  waitForCompile(revision: number, timeoutMs = 10_000): Promise<CompileOutcome> {
    if (this.compiledRevision() >= revision && this.lastCompileOutcome) {
      return Promise.resolve(this.lastCompileOutcome);
    }

    return new Promise<CompileOutcome>((resolve, reject) => {
      const waiters = this.compileWaiters.get(revision) ?? [];
      const waiter: CompileWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const list = this.compileWaiters.get(revision);
          if (list) {
            const index = list.indexOf(waiter);
            if (index >= 0) list.splice(index, 1);
            if (list.length === 0) this.compileWaiters.delete(revision);
          }
          reject(new Error(`Timed out waiting for a compile of revision ${revision}`));
        }, timeoutMs),
      };
      waiters.push(waiter);
      this.compileWaiters.set(revision, waiters);
    });
  }

  /**
   * Forces a compile now instead of waiting for the ~400ms debounce, and
   * resolves once it has actually happened. `force` recompiles every pass even
   * if its composed source is unchanged — Ctrl+Enter's contract; a plain edit
   * does not need it, since the engine's own diffing already detects the
   * change and recompiles exactly the affected passes.
   */
  async compileNow(force = false): Promise<CompileOutcome> {
    if (!this.project()) throw new Error('No shader is open.');

    const revision = this.draftRevision();
    if (force) this.recompile();
    this.immediateCompileRequest.update((n) => n + 1);
    return this.waitForCompile(revision);
  }

  private resetCompileState(): void {
    this.draftRevision.set(0);
    this.compiledRevision.set(-1);
    this.lastCompileOutcome = null;

    for (const waiters of this.compileWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('The shader changed before this compile finished.'));
      }
    }
    this.compileWaiters.clear();
  }

  // --- Patches (MCP) --------------------------------------------------------

  /**
   * Apply a batch of text edits to one or more documents atomically: either
   * every edit lands in a single draft mutation (one revision bump, one
   * compile), or none of them do. Used by `apply_shader_patch` — never called
   * from the UI, which edits one document at a time through `setDocSource`.
   *
   * Rejects a stale `baseRevision` before touching any state, which is what
   * stops an agent from overwriting an edit — the user's or another agent's —
   * made after it last read the document. Never saves.
   */
  async applyPatch(
    baseRevision: number,
    edits: readonly DraftTextEdit[],
  ): Promise<ApplyPatchResult> {
    const project = this.project();
    const draft = this.draft();
    if (!project || !draft) {
      return { ok: false, code: 'NOT_FOUND', message: 'No shader is open.' };
    }

    const currentRevision = this.draftRevision();
    if (baseRevision !== currentRevision) {
      return {
        ok: false,
        code: 'STALE_REVISION',
        message: `baseRevision ${baseRevision} is stale; the draft is at revision ${currentRevision}.`,
        currentRevision,
      };
    }

    if (edits.length === 0) {
      return { ok: true, revision: currentRevision, diagnostics: this.allDiagnostics() };
    }

    const byDocument = new Map<string, DraftTextEdit[]>();
    for (const edit of edits) {
      if (edit.start < 0 || edit.end < edit.start) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Invalid range [${edit.start}, ${edit.end}) for document "${edit.documentId}".`,
        };
      }
      const list = byDocument.get(edit.documentId) ?? [];
      list.push(edit);
      byDocument.set(edit.documentId, list);
    }

    const sources = new Map(this.documents().map((doc) => [doc.id, doc.source]));

    let nextProject = project;
    let nextControlsText = draft.controlsText;

    for (const [documentId, documentEdits] of byDocument) {
      const current = sources.get(documentId);
      if (current === undefined) {
        return { ok: false, code: 'NOT_FOUND', message: `Unknown document "${documentId}".` };
      }

      const sorted = [...documentEdits].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end) {
          return {
            ok: false,
            code: 'VALIDATION_ERROR',
            message: `Overlapping edits in document "${documentId}".`,
          };
        }
      }
      const last = sorted[sorted.length - 1];
      if (last.end > current.length) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Edit range [${last.start}, ${last.end}) is out of bounds for document "${documentId}" (length ${current.length}).`,
        };
      }

      let updated = current;
      for (const edit of [...sorted].reverse()) {
        updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
      }

      if (documentId === CONFIG_DOC) {
        nextControlsText = updated;
      } else if (documentId === VERTEX_DOC) {
        nextProject = setVertexSource(nextProject, updated);
      } else if (findPass(nextProject, documentId)) {
        nextProject = setPassSource(nextProject, documentId, updated);
      } else {
        // `sources` above already proved this id resolves to a real document;
        // pass, vertex and config are handled above, so only a file remains.
        nextProject = setFileSource(nextProject, documentId, updated);
      }
    }

    this.patchDraft({ project: nextProject, controlsText: nextControlsText });
    if (nextControlsText !== draft.controlsText) this.applyControlsSideEffects(nextControlsText);

    const outcome = await this.compileNow();
    return { ok: true, revision: outcome.revision, diagnostics: outcome.diagnostics };
  }

  /**
   * Validate and apply a batch of live parameter values in one call. Each
   * value is checked against the control that owns it via the same
   * `validateParamValue` the config editor's presets use — an unknown key or a
   * value of the wrong type is reported per-key rather than failing the whole
   * request.
   */
  setParamsValidated(values: Record<string, unknown>): SetParamsOutcome {
    const applied: string[] = [];
    const errors: Record<string, string> = {};

    for (const [key, value] of Object.entries(values)) {
      const control = this.controls().find((entry) => entry.key === key);
      if (!control) {
        errors[key] = `Unknown control "${key}".`;
        continue;
      }

      const result = validateParamValue(control, value);
      if (!result.ok) {
        errors[key] = result.errors.join('; ');
        continue;
      }

      this.setParam(key, result.value);
      applied.push(key);
    }

    return { applied, errors };
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
      // The record gets the two things it can hold: the Image pass's source and
      // the vertex shader. Everything else about the project — the buffers, the
      // Common pass, the files, the wiring — goes to local storage, because the
      // record has nowhere to put it and inventing somewhere would break every
      // existing shader, export and desktop install at once.
      const saved = await this.api.update(record.id, {
        fragment: imagePass(draft.project).source,
        vertex: draft.project.vertex,
        controls,
        render: draft.render,
      });

      const project = structuredClone(draft.project);
      this.projects.save(saved.id, saved.updatedAt, project);

      // Keep the live params and the open preset across a save: the user was
      // editing the source, not resetting the knobs.
      const params = this.params();
      const presetId = this.activePresetId();

      this.record.set(saved);
      this.savedProject.set(structuredClone(project));
      this.draft.set({
        project,
        controlsText: controlsToText(saved.controls),
        render: structuredClone(saved.render),
      });
      this.params.set(sanitizeParams(saved.controls, params));
      this.activePresetId.set(presetId);

      await this.refreshList();
      this.notice.set({ text: `Saved “${saved.name}”`, error: false });
      this.recovery.remove(saved.id);
      void this.capturePreview(saved.id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Photographs the shader that was just saved, so the library can show it
   * without opening it.
   *
   * Deliberately *not* awaited by `save`. The document is safely on disk the
   * moment the API answers, and reading a frame back off the GPU and encoding
   * it takes long enough (much longer on a software renderer) that waiting on
   * it would keep `saving` true — swallowing the next Ctrl+S, which the guard
   * at the top of `save` drops while one is in flight.
   *
   * Best-effort for the same reason: a preview is a convenience, and failing to
   * take one must never turn a successful save into a failed one. On any
   * problem the shader keeps whatever preview it had, and the next save tries
   * again. With no renderer — SSR, a test — there is simply nothing to capture.
   */
  private async capturePreview(id: string): Promise<void> {
    try {
      const upload = await this.renderer.captureThumbnail();
      if (!upload) return;

      const { thumbnail } = await this.api.setThumbnail(id, upload);
      this.thumbnails.releaseShader(id);

      // Patch the capture into what is already on screen rather than adopting
      // the server's whole record: a newer save may have landed in the
      // meantime, and its source is the one the user is looking at.
      this.record.update((current) => (current?.id === id ? { ...current, thumbnail } : current));
      this.shaders.update((shaders) =>
        shaders.map((shader) => (shader.id === id ? { ...shader, thumbnail } : shader)),
      );
    } catch (error) {
      console.warn(`[store] could not capture a preview of "${id}"`, error);
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
      this.projects.remove(id);
      this.textures.releaseShader(id);
      this.thumbnails.releaseShader(id);
      await this.refreshList();

      if (this.selectedId() === id) {
        this.record.set(null);
        this.draft.set(null);
        this.savedProject.set(null);
        this.params.set({});
        this.preferences.patch({ lastShaderId: null });
        this.resetCompileState();

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
