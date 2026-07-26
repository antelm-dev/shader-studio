import { Injectable } from '@angular/core';

import type { ParamValue, ShaderControl } from '@shader-studio/shared/model';
import {
  findPass,
  setFileSource,
  setPassSource,
  setVertexSource,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { validateParamValue } from '@shader-studio/shared/validate';
import { CONFIG_DOC, VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import type { ApplyPatchResult, DraftTextEdit, EditorDocument } from './shader-store';

type PatchPlan =
  | { ok: true; project: ShaderProject; controlsText: string }
  | Extract<ApplyPatchResult, { ok: false }>;

export interface ParamsPlan {
  applied: { key: string; value: ParamValue }[];
  errors: Record<string, string>;
}

/**
 * The pure logic behind `apply_shader_patch` and `set_params`: never called
 * from the UI, which edits one document or one param at a time directly on
 * `ShaderStore`. Kept separate because it is the one part of the store an
 * MCP agent — not a person — drives, and because computing the result here
 * as data lets `ShaderStore` decide, in one place, how to turn it into a
 * draft mutation and a compile.
 */
@Injectable({ providedIn: 'root' })
export class McpPatchService {
  /**
   * Computes the project and config text a batch of edits would produce, or
   * the validation error that stops any of them from applying. Never mutates
   * anything — the caller applies the result in a single `patchDraft` call.
   */
  planPatch(
    current: { project: ShaderProject; controlsText: string; documents: readonly EditorDocument[] },
    edits: readonly DraftTextEdit[],
  ): PatchPlan {
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

    const sources = new Map(current.documents.map((doc) => [doc.id, doc.source]));

    let nextProject = current.project;
    let nextControlsText = current.controlsText;

    for (const [documentId, documentEdits] of byDocument) {
      const source = sources.get(documentId);
      if (source === undefined) {
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
      if (last.end > source.length) {
        return {
          ok: false,
          code: 'VALIDATION_ERROR',
          message: `Edit range [${last.start}, ${last.end}) is out of bounds for document "${documentId}" (length ${source.length}).`,
        };
      }

      let updated = source;
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

    return { ok: true, project: nextProject, controlsText: nextControlsText };
  }

  /**
   * Validates a batch of live parameter values against the current controls,
   * the same way the config editor's presets do. An unknown key or a value of
   * the wrong type is reported per-key rather than failing the whole batch.
   * The caller is responsible for actually writing `applied` back.
   */
  planParams(controls: readonly ShaderControl[], values: Record<string, unknown>): ParamsPlan {
    const applied: { key: string; value: ParamValue }[] = [];
    const errors: Record<string, string> = {};

    for (const [key, value] of Object.entries(values)) {
      const control = controls.find((entry) => entry.key === key);
      if (!control) {
        errors[key] = `Unknown control "${key}".`;
        continue;
      }

      const result = validateParamValue(control, value);
      if (!result.ok) {
        errors[key] = result.errors.join('; ');
        continue;
      }

      applied.push({ key, value: result.value });
    }

    return { applied, errors };
  }
}
