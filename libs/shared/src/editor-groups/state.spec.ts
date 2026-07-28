import { describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_GROUP_ID, asEditorGroupId } from '../surfaces/types';
import {
  activateEditorGroup,
  closeDocumentInGroup,
  closeEditorGroup,
  closeOtherDocumentsInGroup,
  createEditorGroup,
  editorGroupIdsFor,
  emptyEditorGroupsState,
  ensureShaderGroups,
  groupOwningDocumentFor,
  hasUniqueDocumentOwnership,
  mergeEditorGroups,
  moveDocumentBetweenGroups,
  openDocumentInGroup,
  openIdsForGroup,
  pruneEmptyEditorGroups,
  pruneStaleDocumentsInShader,
  reorderDocumentInGroup,
  selectDocumentInGroup,
} from './state';

const SHADER_A = 'shader-a';
const SHADER_B = 'shader-b';
const GROUP_B = asEditorGroupId('editor-group:1');

function seed(shaderId: string, defaultDocId: string, state = emptyEditorGroupsState()) {
  return ensureShaderGroups(state, shaderId, defaultDocId);
}

describe('editor-groups state', () => {
  it('seeds a primary group per shader', () => {
    const state = seed(SHADER_A, 'image');
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image']);
    expect(editorGroupIdsFor(state, SHADER_A)).toEqual([DEFAULT_EDITOR_GROUP_ID]);
  });

  it('isolates group state across shaders', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    state = seed(SHADER_B, 'image', state);
    state = openDocumentInGroup(state, SHADER_B, DEFAULT_EDITOR_GROUP_ID, 'config');

    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image', 'vertex']);
    expect(openIdsForGroup(state, SHADER_B, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image', 'config']);
  });

  it('opens documents once per group without duplicates', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image', 'vertex']);
  });

  it('enforces last-tab rule per group', () => {
    const state = seed(SHADER_A, 'image');
    const result = closeDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'image');
    expect(result.result.closed).toBe(false);
    expect(openIdsForGroup(result.state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image']);
  });

  it('closes tabs with deterministic next-active hints', () => {
    let state = seed(SHADER_A, 'a');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'b');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'c');

    const closeMiddle = closeDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'b');
    expect(closeMiddle.result.closed).toBe(true);
    expect(closeMiddle.result.nextActiveHint).toBe('c');

    const closeLast = closeDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'c');
    expect(closeLast.result.nextActiveHint).toBe('b');
  });

  it('reorders tabs within a group', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'config');
    state = reorderDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'config', 'image');
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual([
      'config',
      'image',
      'vertex',
    ]);
  });

  it('closes other tabs in a group', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    state = closeOtherDocumentsInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['vertex']);
  });

  it('creates and activates additional groups', () => {
    let state = seed(SHADER_A, 'image');
    const created = createEditorGroup(state, SHADER_A, { activate: true });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    state = created.state;
    expect(editorGroupIdsFor(state, SHADER_A)).toHaveLength(2);
    expect(created.value).toBe(GROUP_B);

    const activated = activateEditorGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID);
    expect(activated.ok).toBe(true);
    if (!activated.ok) return;
    expect(activated.state.get(SHADER_A)?.activeGroupId).toBe(DEFAULT_EDITOR_GROUP_ID);
  });

  it('moves a document between groups without duplicating ownership', () => {
    let state = seed(SHADER_A, 'image');
    const created = createEditorGroup(state, SHADER_A);
    if (!created.ok) throw new Error('expected group');
    state = created.state;
    const groupB = created.value!;

    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    const moved = moveDocumentBetweenGroups(state, SHADER_A, 'vertex', groupB, {
      transfer: { documentId: 'vertex', viewState: { scrollTop: 12 } },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    state = pruneEmptyEditorGroups(moved.state, SHADER_A);
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image']);
    expect(openIdsForGroup(state, SHADER_A, groupB)).toEqual(['vertex']);
    expect(groupOwningDocumentFor(state, SHADER_A, 'vertex')).toBe(groupB);
    expect(hasUniqueDocumentOwnership(state.get(SHADER_A)!)).toBe(true);
  });

  it('rejects moving the last primary tab away', () => {
    const state = seed(SHADER_A, 'image');
    const created = createEditorGroup(state, SHADER_A);
    if (!created.ok) throw new Error('expected group');
    const moved = moveDocumentBetweenGroups(created.state, SHADER_A, 'image', created.value!);
    expect(moved.ok).toBe(false);
    if (moved.ok) return;
    expect(moved.code).toBe('empty-primary');
  });

  it('merges and closes non-primary groups without deleting documents', () => {
    let state = seed(SHADER_A, 'image');
    const created = createEditorGroup(state, SHADER_A);
    if (!created.ok) throw new Error('expected group');
    state = created.state;
    const groupB = created.value!;

    state = openDocumentInGroup(state, SHADER_A, groupB, 'vertex');
    const closed = closeEditorGroup(state, SHADER_A, groupB);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;

    state = closed.state;
    expect(editorGroupIdsFor(state, SHADER_A)).toEqual([DEFAULT_EDITOR_GROUP_ID]);
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image', 'vertex']);
    expect(closed.value?.mergedDocumentIds).toEqual(['vertex']);
  });

  it('rejects closing the sole editor group', () => {
    const state = seed(SHADER_A, 'image');
    const closed = closeEditorGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID);
    expect(closed.ok).toBe(false);
    if (closed.ok) return;
    expect(closed.code).toBe('last-group');
  });

  it('merges groups explicitly', () => {
    let state = seed(SHADER_A, 'image');
    const created = createEditorGroup(state, SHADER_A);
    if (!created.ok) throw new Error('expected group');
    state = created.state;
    const groupB = created.value!;
    state = openDocumentInGroup(state, SHADER_A, groupB, 'vertex');

    const merged = mergeEditorGroups(state, SHADER_A, groupB, DEFAULT_EDITOR_GROUP_ID);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(openIdsForGroup(merged.state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual([
      'image',
      'vertex',
    ]);
  });

  it('prunes stale document ids and reseeds the primary group', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'gone');
    state = pruneStaleDocumentsInShader(state, SHADER_A, new Set(['image']), 'image');
    expect(openIdsForGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID)).toEqual(['image']);
  });

  it('selects a document within a group', () => {
    let state = seed(SHADER_A, 'image');
    state = openDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'vertex');
    state = selectDocumentInGroup(state, SHADER_A, DEFAULT_EDITOR_GROUP_ID, 'image');
    const group = state.get(SHADER_A)?.groups.find((entry) => entry.id === DEFAULT_EDITOR_GROUP_ID);
    expect(group?.activeDocumentId).toBe('image');
  });
});
