import { Injectable, signal } from '@angular/core';

/**
 * A request to put the cursor on a line of a document, addressed to whichever
 * `EditorPanel` is currently mounted.
 *
 * `requestId` is monotonically increasing so that clicking the *same*
 * diagnostic twice in a row still produces a new signal value — `docId` and
 * `line` alone would be identical to the previous request, and a `computed`
 * or `effect` watching the signal would not see a change to react to.
 */
export interface EditorLocationRequest {
  docId: string;
  line: number;
  requestId: number;
}

/**
 * The one door the Problems panel is allowed to reach the source editor
 * through.
 *
 * The panel does not know `CodeEditor` exists — it has no reference to the
 * Monaco instance, which lives inside `EditorPanel` and is usually not even
 * mounted for the document being navigated to. So a reveal is not performed
 * here; it is *announced*, and `EditorPanel` — the one place that actually
 * holds a `CodeEditor` — picks the request up once the target document has
 * been selected and hands it to `CodeEditor.revealIn`.
 */
@Injectable({ providedIn: 'root' })
export class EditorNavigation {
  private nextId = 0;

  readonly request = signal<EditorLocationRequest | null>(null);

  reveal(docId: string, line: number): void {
    this.nextId++;
    this.request.set({ docId, line, requestId: this.nextId });
  }
}

/** What a resolved request means for the editor: which document, which line, and whether the line is worth revealing at all. */
export interface ResolvedNavigation {
  docId: string;
  line: number;
  /** `false` for line 0 — nothing to reveal, so the target is just focused. */
  reveal: boolean;
}

/**
 * Turns a request into something `EditorPanel` can act on, against *its* view
 * of the world: which documents currently exist, and which one is open.
 *
 * Kept as a pure function, apart from the service, so the three things that
 * can go wrong with a diagnostic — a document that no longer exists, no
 * `docId` at all, line 0 — are each one assertion away rather than requiring
 * a mounted `CodeEditor` and a live Monaco instance to exercise.
 */
export function resolveNavigationTarget(
  request: EditorLocationRequest,
  documentIds: readonly string[],
  activeDocId: string | null,
): ResolvedNavigation | null {
  const known = documentIds.includes(request.docId);
  const docId = known ? request.docId : activeDocId;
  if (!docId) return null;

  return { docId, line: request.line, reveal: request.line > 0 };
}
