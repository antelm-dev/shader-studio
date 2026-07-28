import { Injectable, computed, inject, signal } from '@angular/core';

import {
  DEFAULT_CHANNELS,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type ShaderRecord,
  type ShaderSummary,
  type TextureChannels,
} from '@shader-studio/shared/model';
import {
  bufferPasses,
  displayPasses,
  findPass,
  freeSlot,
  imagePass,
  resolvePassOrder,
  type BufferSlot,
  type PassKind,
  type ProjectError,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { defaultParams } from '@shader-studio/shared/validate';
import { CONFIG_DOC, VERTEX_DOC, type CompileDiagnostic } from '@shader-studio/shared/diagnostic';
import { CompilationService } from '../compilation.service';
import { controlsToText } from '../controls-text';
import type { RecoveredDraft } from '../draft-recovery';
import { parseControls } from './controls-schema';

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
 * The single owner of the workspace's document data.
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
 * project is stored in two places — this is what makes a record and its passes
 * look like one document.
 *
 * Collaborators — `ProjectMutations`, and the lifecycle and persistence
 * workflows still on `ShaderStore` — change it through the transitions at the
 * bottom rather than by writing the signals one at a time. `adopt`,
 * `patchDraft`, `commitSaved`, `commitMigratedProject` and `clearWorkspace` each
 * describe one thing that happened, and each leaves the four layers consistent
 * with each other; writing them individually is how two of them drift apart.
 *
 * Several of the raw signals below are writable rather than readonly. That is a
 * compatibility contract, not an invitation: `ShaderStore` aliases these exact
 * instances, and consumers older than this class — `OutputSync` mirroring a
 * snapshot into a second window, `shader-canvas` reporting which passes are
 * compiling, the many commands that post a notice — already write them through
 * the facade. Aliasing rather than copying is the point: there is still exactly
 * one instance of each.
 */
@Injectable({ providedIn: 'root' })
export class DocumentState {
  /**
   * Not an owner of anything here — the one dependency is `patchDraft`, which
   * bumps the revision `CompilationService` owns. Every project, controls and
   * render mutation funnels through that one call, which is what makes "one
   * logical mutation, one revision" true by construction rather than by every
   * caller remembering to do it.
   */
  private readonly compilation = inject(CompilationService);

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
   *
   * Readonly to everyone else: it moves only when a document is adopted, saved,
   * migrated or closed, and every one of those is a transition below.
   */
  private readonly saved = signal<ShaderProject | null>(null);
  readonly savedProject = this.saved.asReadonly();

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
    const parsed = parseControls(draft.controlsText);
    return parsed ?? this.record()?.controls ?? [];
  });

  readonly configValid = computed(() => {
    const draft = this.draft();
    return draft === null || parseControls(draft.controlsText) !== null;
  });

  /**
   * The project is compared against `saved`, not against the record: the record
   * has no idea Buffer B exists, so measuring dirtiness against it would
   * silently discard every change to a buffer, a file or a channel binding — the
   * exact edits this whole feature is about.
   */
  readonly dirty = computed(() => {
    const record = this.record();
    const draft = this.draft();
    const saved = this.saved();
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

  // --- Transitions --------------------------------------------------------

  /**
   * Take a server record, and the project behind it, as the new truth: the
   * draft, the saved baseline, the params and the open tab all reset onto it.
   *
   * The project is passed in rather than read off the record because deciding
   * *which* project a record has — the server's, or a pre-upgrade local one
   * reconciled onto it — is a lifecycle question, and answering it here would
   * make this class know about browser storage.
   *
   * Deliberately does not touch the compile revision: that belongs to
   * `CompilationService`, and the caller that decided to adopt is the one that
   * knows whether the waiters queued against the old document should be failed.
   */
  adopt(record: ShaderRecord, project: ShaderProject): void {
    this.record.set(record);
    this.saved.set(structuredClone(project));
    this.draft.set({
      project,
      controlsText: controlsToText(record.controls),
      render: structuredClone(record.render),
    });
    this.params.set(defaultParams(record.controls));
    this.activePresetId.set(null);
    this.diagnostics.set([]);
    this.activeDocId.set(imagePass(project).id);
  }

  /**
   * Put a recovered draft back over the one `adopt` just built, cloning it so
   * the copy in storage is not the copy being edited.
   *
   * No revision bump: the caller follows this with the config write that owns
   * the bump, and two bumps for one restore would make an agent's `baseRevision`
   * go stale for a change it never saw.
   */
  restoreDraft(draft: ShaderDraft): void {
    this.draft.set({
      project: structuredClone(draft.project),
      controlsText: draft.controlsText,
      render: structuredClone(draft.render),
    });
  }

  /**
   * The one choke point behind every project, controls and render mutation, and
   * the one place the draft revision moves — one logical edit, one bump, which
   * is what `apply_shader_patch` checks a `baseRevision` against and what
   * `waitForCompile` correlates a finished compile back to.
   *
   * Returns false when no document is open, so callers do not have to ask twice.
   */
  patchDraft(patch: Partial<ShaderDraft>): boolean {
    const current = this.draft();
    if (!current) return false;
    this.draft.set({ ...current, ...patch });
    this.compilation.draftRevision.update((n) => n + 1);
    return true;
  }

  /**
   * A successful save: the record, the new baseline the draft is measured
   * against, the reprojected params and the preset that survived it, together.
   */
  commitSaved(
    record: ShaderRecord,
    draft: ShaderDraft,
    params: ShaderParams,
    activePresetId: string | null,
  ): void {
    this.record.set(record);
    this.saved.set(structuredClone(draft.project));
    this.draft.set(draft);
    this.params.set(params);
    this.activePresetId.set(activePresetId);
  }

  /**
   * A pre-upgrade local project has reached the server. The draft is left
   * exactly as it is — the user may have been typing throughout — and only the
   * record and the baseline it is measured against move.
   */
  commitMigratedProject(record: ShaderRecord, project: ShaderProject): void {
    this.record.set(record);
    this.saved.set(structuredClone(project));
  }

  /** No document open at all: what deleting the last shader leaves behind. */
  clearWorkspace(): void {
    this.record.set(null);
    this.draft.set(null);
    this.saved.set(null);
    this.params.set({});
  }

  /** The live uniform values, wholesale. Not a draft edit, so no revision bump. */
  setParams(params: ShaderParams): void {
    this.params.set(params);
  }

  /** Said after any edit to the params: they no longer match the preset they came from. */
  clearActivePreset(): void {
    this.activePresetId.set(null);
  }

  selectDocument(id: string): void {
    this.activeDocId.set(id);
  }

  /** Next or previous tab, wrapping. What Ctrl+PageDown does everywhere else. */
  cycleDocument(step: 1 | -1): void {
    const documents = this.documents();
    if (documents.length === 0) return;

    const current = documents.findIndex((doc) => doc.id === this.activeDoc()?.id);
    const next = (current + step + documents.length) % documents.length;
    this.activeDocId.set(documents[next].id);
  }

  notify(text: string, error: boolean): void {
    this.notice.set({ text, error });
  }

  /** Replace the compile diagnostics, leaving config diagnostics in place. */
  setCompileDiagnostics(diagnostics: readonly CompileDiagnostic[]): void {
    this.diagnostics.update((all) => [
      ...all.filter((entry) => entry.source === 'config'),
      ...diagnostics,
    ]);
  }

  /**
   * Replace the config diagnostics, leaving the compile ones in place. An empty
   * list is how a config that parses again clears the complaints about the one
   * that did not.
   */
  setConfigDiagnostics(messages: readonly string[]): void {
    this.diagnostics.update((all) => [
      ...all.filter((entry) => entry.source !== 'config'),
      ...messages.map(
        (message): CompileDiagnostic => ({
          severity: 'error',
          line: 0,
          message,
          source: 'config',
        }),
      ),
    ]);
  }
}
