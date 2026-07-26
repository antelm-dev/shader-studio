/**
 * Composing a pass into the single GLSL string the driver actually compiles,
 * and being able to say afterwards which file each line of it came from.
 *
 * A pass is never compiled as written. What the driver sees is the Common
 * pass's source, then whatever the pass `#include`d, then the pass itself — so
 * a driver that complains about "line 84" is talking about a line number that
 * exists in none of the files the user has open. Mapping it back is not a nicety:
 * without it, every error in a multi-pass project points at the wrong place.
 *
 * So composition emits a *map* alongside the source: an ordered list of spans
 * saying "lines 12–40 of the composed source are lines 1–29 of file X". Turning
 * a driver's line number into a file and a line is then a lookup, and it stays
 * correct no matter how the composition changes.
 *
 * Pure string handling, deliberately: the renderer composes, the editor maps,
 * and the tests do both without a GPU.
 */

import { commonPass, findFile } from './queries';
import type { RenderPass, ShaderProject } from './types';
/** One contiguous run of composed lines that all came from the same file. */
export interface SourceSpan {
  /** The pass or file the lines belong to — the id the editor opens a tab for. */
  docId: string;
  /** Human name, for a diagnostic that has to be readable on its own. */
  docName: string;
  /** 1-based, into the composed source. */
  start: number;
  /** Number of lines in the span. */
  count: number;
  /** 1-based line in the original file that `start` corresponds to. */
  originLine: number;
}

export interface ComposedPass {
  source: string;
  spans: SourceSpan[];
}

export interface SourceLocation {
  docId: string;
  docName: string;
  /** 1-based, in the original file. */
  line: number;
}

const INCLUDE = /^\s*#include\s+["<]([^">]+)[">]\s*$/;

/** How deep `#include` may nest before we call it a loop. */
const MAX_INCLUDE_DEPTH = 16;

export interface CompositionError {
  message: string;
  /** The file the offending `#include` is written in. */
  docId: string;
  /** 1-based line of the `#include`, in that file. */
  line: number;
}

interface Emitter {
  lines: string[];
  spans: SourceSpan[];
  errors: CompositionError[];
}

/**
 * Emit a file's lines, expanding any `#include` it contains.
 *
 * The `#include` line itself is replaced by the included file's lines rather
 * than kept — GLSL has no preprocessor directive by that name, so leaving it in
 * would be a compile error in its own right. It is replaced by a blank line
 * only when the include fails, so that the line numbering of everything after
 * it does not shift and cascade into a second, spurious set of errors.
 */
function emit(
  project: ShaderProject,
  docId: string,
  docName: string,
  source: string,
  out: Emitter,
  stack: readonly string[],
): void {
  const lines = source.split('\n');

  let spanStart = out.lines.length + 1;
  let spanOrigin = 1;
  let spanCount = 0;

  const flush = (): void => {
    if (spanCount === 0) return;
    out.spans.push({
      docId,
      docName,
      start: spanStart,
      count: spanCount,
      originLine: spanOrigin,
    });
    spanCount = 0;
  };

  lines.forEach((line, index) => {
    const match = INCLUDE.exec(line);
    if (!match) {
      if (spanCount === 0) {
        spanStart = out.lines.length + 1;
        spanOrigin = index + 1;
      }
      out.lines.push(line);
      spanCount++;
      return;
    }

    flush();

    const name = match[1];
    const target = project.files.find((file) => file.name === name);
    const at = index + 1;

    if (!target) {
      out.errors.push({
        message: `#include "${name}" — no file by that name is in the project.`,
        docId,
        line: at,
      });
      out.lines.push('');
    } else if (stack.includes(target.id)) {
      const loop = [...stack, target.id].map((id) => findFile(project, id)?.name ?? id).join(' → ');
      out.errors.push({
        message: `Circular #include: ${loop}.`,
        docId,
        line: at,
      });
      out.lines.push('');
    } else if (stack.length >= MAX_INCLUDE_DEPTH) {
      out.errors.push({
        message: `#include "${name}" nests more than ${MAX_INCLUDE_DEPTH} deep.`,
        docId,
        line: at,
      });
      out.lines.push('');
    } else {
      emit(project, target.id, target.name, target.source, out, [...stack, target.id]);
    }

    // Whatever happened, the next line of *this* file starts a fresh span.
    spanStart = out.lines.length + 1;
    spanOrigin = index + 2;
  });

  flush();
}

/**
 * The source the driver compiles for one pass, plus the map back to the files
 * it came from.
 *
 * Common goes first so that everything it declares is in scope for the pass —
 * that is the whole contract of a Common pass, and it is why an empty Common
 * contributes nothing at all rather than a blank line that would shift every
 * subsequent diagnostic by one.
 */
export function composePass(
  project: ShaderProject,
  pass: RenderPass,
): ComposedPass & {
  errors: CompositionError[];
} {
  const out: Emitter = { lines: [], spans: [], errors: [] };

  const common = commonPass(project);
  if (common && common.source.trim()) {
    emit(project, common.id, common.name, common.source, out, []);
  }

  emit(project, pass.id, pass.name, pass.source, out, []);

  return { source: out.lines.join('\n'), spans: out.spans, errors: out.errors };
}

/**
 * Which file, and which line of it, a line of the composed source came from.
 *
 * Returns `null` for a line inside no span at all, which the caller should
 * treat as "belongs to the pass, position unknown" rather than dropping: an
 * error you cannot see is worse than one in the wrong place.
 */
export function locate(spans: readonly SourceSpan[], line: number): SourceLocation | null {
  for (const span of spans) {
    if (line < span.start || line >= span.start + span.count) continue;
    return {
      docId: span.docId,
      docName: span.docName,
      line: span.originLine + (line - span.start),
    };
  }
  return null;
}

/**
 * Every file that ends up inside a pass's compiled source — the pass, the
 * Common pass if it has anything in it, and the transitive `#include`s.
 *
 * This is what tells the store *which* passes an edit invalidates. Typing in
 * Buffer C recompiles Buffer C; typing in Common, or in a file two passes both
 * include, recompiles both of them and nothing else.
 */
export function passDependsOn(project: ShaderProject, pass: RenderPass): Set<string> {
  const { spans } = composePass(project, pass);
  const ids = new Set<string>(spans.map((span) => span.docId));
  ids.add(pass.id);
  return ids;
}
