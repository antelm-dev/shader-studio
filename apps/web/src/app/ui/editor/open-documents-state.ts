/**
 * Session-local open editor tabs, scoped by shader id.
 *
 * Membership and order live here; `ShaderStore.activeDoc()` remains the
 * authoritative active document. Closing never deletes project content.
 *
 * Last-tab rule: the open set for a shader is never emptied. Closing the sole
 * remaining tab is a no-op (UI should hide/disable the close affordance).
 */

export type OpenDocumentsState = ReadonlyMap<string, readonly string[]>;

export function emptyOpenDocumentsState(): OpenDocumentsState {
  return new Map();
}

function setOpenIds(
  state: OpenDocumentsState,
  shaderId: string,
  openIds: readonly string[],
): OpenDocumentsState {
  const next = new Map(state);
  next.set(shaderId, openIds);
  return next;
}

export function openIdsFor(
  state: OpenDocumentsState,
  shaderId: string | null | undefined,
): readonly string[] {
  if (!shaderId) return [];
  return state.get(shaderId) ?? [];
}

/** Seed a shader's open set with `defaultDocId` when it has none yet. */
export function ensureShaderOpen(
  state: OpenDocumentsState,
  shaderId: string,
  defaultDocId: string,
): OpenDocumentsState {
  const current = state.get(shaderId);
  if (current && current.length > 0) return state;
  return setOpenIds(state, shaderId, [defaultDocId]);
}

/** Add `docId` if missing; no duplicate, preserve existing order. */
export function openDocument(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): OpenDocumentsState {
  const current = state.get(shaderId) ?? [];
  if (current.includes(docId)) return state;
  return setOpenIds(state, shaderId, [...current, docId]);
}

export interface CloseDocumentResult {
  state: OpenDocumentsState;
  /** False when the tab was absent or was the last open tab (kept open). */
  closed: boolean;
  /**
   * Suggested next active id when the closed tab was active: the right neighbor,
   * else the left neighbor. Null when nothing closed.
   */
  nextActiveHint: string | null;
}

/**
 * Remove a tab from the open set.
 *
 * Last-tab rule: refusing to close the only open tab keeps the editor usable
 * without introducing an empty active-document state.
 */
export function closeDocument(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): CloseDocumentResult {
  const current = state.get(shaderId) ?? [];
  const index = current.indexOf(docId);
  if (index < 0) return { state, closed: false, nextActiveHint: null };
  if (current.length === 1) return { state, closed: false, nextActiveHint: null };

  const next = current.filter((id) => id !== docId);
  const nextActiveHint = current[index + 1] ?? current[index - 1] ?? null;
  return { state: setOpenIds(state, shaderId, next), closed: true, nextActiveHint };
}

/** Keep only `docId` open (must already be in the set). */
export function closeOtherDocuments(
  state: OpenDocumentsState,
  shaderId: string,
  docId: string,
): OpenDocumentsState {
  const current = state.get(shaderId) ?? [];
  if (!current.includes(docId)) return state;
  if (current.length === 1 && current[0] === docId) return state;
  return setOpenIds(state, shaderId, [docId]);
}

/** Reorder open tabs only — does not touch project buffer/file order. */
export function reorderOpenDocument(
  state: OpenDocumentsState,
  shaderId: string,
  sourceId: string,
  targetId: string,
): OpenDocumentsState {
  const current = [...(state.get(shaderId) ?? [])];
  const from = current.indexOf(sourceId);
  const to = current.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return state;

  current.splice(from, 1);
  current.splice(to, 0, sourceId);
  return setOpenIds(state, shaderId, current);
}

/**
 * Drop open ids that no longer exist. If pruning empties the set, seed with
 * `fallbackDocId` so the last-tab rule still holds.
 */
export function pruneOpenDocuments(
  state: OpenDocumentsState,
  shaderId: string,
  existingIds: ReadonlySet<string>,
  fallbackDocId: string,
): OpenDocumentsState {
  const current = state.get(shaderId);
  if (!current) return state;

  const next = current.filter((id) => existingIds.has(id));
  if (next.length === current.length) return state;
  if (next.length === 0) return setOpenIds(state, shaderId, [fallbackDocId]);
  return setOpenIds(state, shaderId, next);
}
