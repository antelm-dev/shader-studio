import { Injectable, inject } from '@angular/core';

import type { ParamValue, RenderSettings } from '@shader-studio/shared/model';
import {
  addBuffer,
  addFile,
  bufferPasses,
  duplicateFile,
  duplicatePass,
  findFile,
  findPass,
  freeSlot,
  imagePass,
  moveFile,
  movePass,
  removeFile,
  removePass,
  renameFile,
  renamePass,
  setChannelBinding,
  setFileSource,
  setPassEnabled,
  setPassResolution,
  setPassSampling,
  setPassSource,
  setVertexSource,
  type ChannelBinding,
  type ChannelIndex,
  type PassResolution,
  type RenderPass,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { defaultParams, sanitizeParams } from '@shader-studio/shared/validate';
import { CONFIG_DOC, VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import { CompilationService } from '../compilation.service';
import { McpPatchService } from '../mcp-patch.service';
import { DocumentState } from './document-state';
import { configErrors, parseControls } from './controls-schema';

/** One replacement of `[start, end)` in a document's source with `text`. Offsets are 0-based character positions. */
export interface DraftTextEdit {
  documentId: string;
  start: number;
  end: number;
  text: string;
}

/** Why a batch of edits did not apply. Shared with `ShaderStore.applyPatch`'s result type. */
export interface PatchFailure {
  ok: false;
  code: 'STALE_REVISION' | 'VALIDATION_ERROR' | 'NOT_FOUND';
  message: string;
  currentRevision?: number;
}

/**
 * What a batch of edits did to the draft.
 *
 * `applied` and `noop` are deliberately distinct: a patch that changed nothing
 * did not bump the revision and so has nothing to wait for, and treating it as
 * an edit would leave `apply_shader_patch` blocked on a compile that is never
 * going to be triggered.
 */
export type PatchApplication =
  | { status: 'applied'; revision: number }
  | { status: 'noop'; revision: number }
  | { status: 'failed'; failure: PatchFailure };

export interface SetParamsOutcome {
  applied: string[];
  errors: Record<string, string>;
}

/**
 * Every edit a user or an agent can make to the open document.
 *
 * The split from `DocumentState` is between *what the document is* and *what
 * you can do to it*: this class holds no state of its own and reaches the four
 * layers only through `DocumentState`'s transitions, which is what keeps "one
 * logical mutation, one draft write, one revision bump" true for a rename, a
 * channel rewire and a twelve-edit MCP patch alike.
 *
 * Two things beyond the obvious live here because they are consequences of an
 * edit rather than separate actions:
 *
 *  - the open tab. Adding a buffer and then having to go and find it is not a
 *    workflow anybody wants, and deleting the tab you are looking at has to
 *    leave you looking at something.
 *  - the config schema. Writing the config text re-projects the live params
 *    onto the new schema and turns a refusal to parse into diagnostics, so that
 *    adding a control makes its knob appear without a save.
 */
@Injectable({ providedIn: 'root' })
export class ProjectMutations {
  private readonly state = inject(DocumentState);
  private readonly mcpPatch = inject(McpPatchService);

  /**
   * Read-only here. The revision is `CompilationService`'s, bumped through
   * `DocumentState.patchDraft`; this class only ever asks what it currently is,
   * to tell an agent its `baseRevision` has gone stale.
   */
  private readonly compilation = inject(CompilationService);

  // --- Sources ------------------------------------------------------------

  /** The Image pass's source — the shader's `fragment`, by any other name. */
  setFragment(fragment: string): void {
    const project = this.state.project();
    if (!project) return;
    this.patchProject(setPassSource(project, imagePass(project).id, fragment));
  }

  setVertex(vertex: string): void {
    const project = this.state.project();
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
    const project = this.state.project();
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

  // --- Passes -------------------------------------------------------------

  addBufferPass(): void {
    const project = this.state.project();
    if (!project) return;

    if (!freeSlot(project)) {
      this.state.notify('All four buffer slots are in use', true);
      return;
    }

    const next = addBuffer(project);
    this.patchProject(next);
    // Open what was just created: making a buffer and then having to go and find
    // it is not a workflow anybody wants.
    const created = bufferPasses(next).at(-1)?.id;
    if (created) this.state.selectDocument(created);
  }

  duplicateBufferPass(id: string): void {
    const project = this.state.project();
    if (!project) return;

    if (!freeSlot(project)) {
      this.state.notify('All four buffer slots are in use', true);
      return;
    }

    const next = duplicatePass(project, id);
    this.patchProject(next);

    const copy = bufferPasses(next).find(
      (pass) => !bufferPasses(project).some((old) => old.id === pass.id),
    );
    if (copy) this.state.selectDocument(copy.id);
  }

  removeBufferPass(id: string): void {
    const project = this.state.project();
    if (!project) return;

    this.patchProject(removePass(project, id));
    if (this.state.activeDocId() === id) this.state.selectDocument(imagePass(project).id);
  }

  renamePassById(id: string, name: string): void {
    const project = this.state.project();
    if (project) this.patchProject(renamePass(project, id, name));
  }

  setPassEnabledById(id: string, enabled: boolean): void {
    const project = this.state.project();
    if (project) this.patchProject(setPassEnabled(project, id, enabled));
  }

  movePassTo(id: string, toIndex: number): void {
    const project = this.state.project();
    if (project) this.patchProject(movePass(project, id, toIndex));
  }

  setPassResolutionById(id: string, patch: Partial<PassResolution>): void {
    const project = this.state.project();
    if (project) this.patchProject(setPassResolution(project, id, patch));
  }

  setPassSamplingById(
    id: string,
    patch: { filter?: RenderPass['filter']; wrap?: RenderPass['wrap'] },
  ): void {
    const project = this.state.project();
    if (project) this.patchProject(setPassSampling(project, id, patch));
  }

  setChannel(id: string, channel: ChannelIndex, binding: ChannelBinding): void {
    const project = this.state.project();
    if (project) this.patchProject(setChannelBinding(project, id, channel, binding));
  }

  // --- Files --------------------------------------------------------------

  addSourceFile(name?: string): void {
    const project = this.state.project();
    if (!project) return;

    const next = addFile(project, name);
    this.patchProject(next);
    const created = next.files.at(-1)?.id;
    if (created) this.state.selectDocument(created);
  }

  duplicateSourceFile(id: string): void {
    const project = this.state.project();
    if (!project) return;

    const next = duplicateFile(project, id);
    this.patchProject(next);

    const copy = next.files.find((file) => !project.files.some((old) => old.id === file.id));
    if (copy) this.state.selectDocument(copy.id);
  }

  removeSourceFile(id: string): void {
    const project = this.state.project();
    if (!project) return;

    this.patchProject(removeFile(project, id));
    if (this.state.activeDocId() === id) this.state.selectDocument(imagePass(project).id);
  }

  renameSourceFile(id: string, name: string): void {
    const project = this.state.project();
    if (project) this.patchProject(renameFile(project, id, name));
  }

  moveSourceFile(id: string, toIndex: number): void {
    const project = this.state.project();
    if (project) this.patchProject(moveFile(project, id, toIndex));
  }

  private patchProject(project: ShaderProject): void {
    this.state.patchDraft({ project });
  }

  // --- Config and render ---------------------------------------------------

  /**
   * Update the config buffer. When it parses, re-project the live params onto
   * the new schema straight away, so adding a control makes its knob appear
   * without a save and removing one drops its value.
   */
  setControlsText(controlsText: string): void {
    this.state.patchDraft({ controlsText });
    this.applyControlsSideEffects(controlsText);
  }

  setRender(render: RenderSettings): void {
    this.state.patchDraft({ render });
  }

  /**
   * The part of `setControlsText` that is not "write the text": re-project the
   * live params onto the new schema, and (in)validate it into the diagnostics.
   * Split out so `applyTextEdits` can run it once after its own single, combined
   * `patchDraft` call — folding it back in would mean a multi-document patch
   * that happens to touch `@config` bumps the revision twice for one edit.
   */
  private applyControlsSideEffects(controlsText: string): void {
    const parsed = parseControls(controlsText);

    if (parsed) {
      this.state.setConfigDiagnostics([]);
      this.state.setParams(sanitizeParams(parsed, this.state.params()));
      return;
    }

    this.state.setConfigDiagnostics(configErrors(controlsText));
  }

  // --- Params ---------------------------------------------------------------

  setParam(key: string, value: ParamValue): void {
    this.state.setParams({ ...this.state.params(), [key]: value });
    this.state.clearActivePreset();
  }

  resetParams(): void {
    this.state.setParams(defaultParams(this.state.controls()));
    this.state.clearActivePreset();
  }

  /**
   * Validate and apply a batch of live parameter values in one call. Each value
   * is checked against the control that owns it via the same `validateParamValue`
   * the config editor's presets use — an unknown key or a value of the wrong
   * type is reported per-key rather than failing the whole request.
   */
  setParamsValidated(values: Record<string, unknown>): SetParamsOutcome {
    const plan = this.mcpPatch.planParams(this.state.controls(), values);
    for (const { key, value } of plan.applied) this.setParam(key, value);
    return { applied: plan.applied.map((entry) => entry.key), errors: plan.errors };
  }

  // --- Patches (MCP) --------------------------------------------------------

  /**
   * Apply a batch of text edits to one or more documents atomically: either
   * every edit lands in a single draft mutation — one revision bump, one
   * compile — or none of them do. Used by `apply_shader_patch`; never by the UI,
   * which edits one document at a time through `setDocSource`.
   *
   * Rejects a stale `baseRevision` before touching any state, which is what
   * stops an agent from overwriting an edit — the user's or another agent's —
   * made after it last read the document. Never saves, and never compiles: the
   * caller owns waiting for the result, because whether a patch is worth
   * blocking on is not a question about the document.
   */
  applyTextEdits(baseRevision: number, edits: readonly DraftTextEdit[]): PatchApplication {
    const project = this.state.project();
    const draft = this.state.draft();
    if (!project || !draft) {
      return {
        status: 'failed',
        failure: { ok: false, code: 'NOT_FOUND', message: 'No shader is open.' },
      };
    }

    const currentRevision = this.compilation.draftRevision();
    if (baseRevision !== currentRevision) {
      return {
        status: 'failed',
        failure: {
          ok: false,
          code: 'STALE_REVISION',
          message: `baseRevision ${baseRevision} is stale; the draft is at revision ${currentRevision}.`,
          currentRevision,
        },
      };
    }

    if (edits.length === 0) return { status: 'noop', revision: currentRevision };

    const plan = this.mcpPatch.planPatch(
      { project, controlsText: draft.controlsText, documents: this.state.documents() },
      edits,
    );
    if (!plan.ok) return { status: 'failed', failure: plan };

    this.state.patchDraft({ project: plan.project, controlsText: plan.controlsText });
    if (plan.controlsText !== draft.controlsText) this.applyControlsSideEffects(plan.controlsText);

    return { status: 'applied', revision: this.compilation.draftRevision() };
  }
}
