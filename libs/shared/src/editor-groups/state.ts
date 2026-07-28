/**
 * Pure transitions for shader-scoped editor groups.
 */

import { DEFAULT_EDITOR_GROUP_ID, asEditorGroupId, type EditorGroupId } from '../surfaces/types';
import type {
  CloseDocumentInGroupResult,
  CloseEditorGroupResult,
  EditorGroupMutationFailure,
  EditorGroupMutationResult,
  EditorGroupPresentation,
  EditorGroupRecord,
  EditorGroupsState,
  EditorDocumentViewTransfer,
  ShaderEditorGroups,
} from './types';

export function emptyEditorGroupsState(): EditorGroupsState {
  return new Map();
}

export function allocateEditorGroupId(groups: readonly EditorGroupRecord[]): EditorGroupId {
  const existing = new Set(groups.map((group) => group.id));
  if (!existing.has(DEFAULT_EDITOR_GROUP_ID)) return DEFAULT_EDITOR_GROUP_ID;

  let index = 1;
  while (existing.has(asEditorGroupId(`editor-group:${index}`))) {
    index += 1;
  }
  return asEditorGroupId(`editor-group:${index}`);
}

function fail<T = void>(code: EditorGroupMutationFailure['code']): EditorGroupMutationResult<T> {
  return { ok: false, code };
}

function ok<T = void>(state: EditorGroupsState, value?: T): EditorGroupMutationResult<T> {
  return value === undefined ? { ok: true, state } : { ok: true, state, value };
}

function setShaderState(
  state: EditorGroupsState,
  shaderId: string,
  shaderGroups: ShaderEditorGroups,
): EditorGroupsState {
  const next = new Map(state);
  next.set(shaderId, shaderGroups);
  return next;
}

function updateShader(
  state: EditorGroupsState,
  shaderId: string,
  updater: (current: ShaderEditorGroups | undefined) => ShaderEditorGroups | null,
): EditorGroupsState {
  const current = state.get(shaderId);
  const nextShader = updater(current);
  if (!nextShader) return state;
  if (nextShader === current) return state;
  return setShaderState(state, shaderId, nextShader);
}

function updateGroup(
  shaderGroups: ShaderEditorGroups,
  groupId: EditorGroupId,
  updater: (group: EditorGroupRecord) => EditorGroupRecord | null,
): ShaderEditorGroups | null {
  const index = shaderGroups.groups.findIndex((group) => group.id === groupId);
  if (index < 0) return null;

  const current = shaderGroups.groups[index]!;
  const nextGroup = updater(current);
  if (!nextGroup || nextGroup === current) return shaderGroups;

  const groups = [...shaderGroups.groups];
  groups[index] = nextGroup;
  return { ...shaderGroups, groups };
}

function findGroup(
  shaderGroups: ShaderEditorGroups,
  groupId: EditorGroupId,
): EditorGroupRecord | null {
  return shaderGroups.groups.find((group) => group.id === groupId) ?? null;
}

function groupOwningDocument(
  shaderGroups: ShaderEditorGroups,
  documentId: string,
): EditorGroupRecord | null {
  return shaderGroups.groups.find((group) => group.documentIds.includes(documentId)) ?? null;
}

function nextActiveAfterClose(documentIds: readonly string[], closedIndex: number): string | null {
  if (documentIds.length === 0) return null;
  return documentIds[closedIndex + 1] ?? documentIds[closedIndex - 1] ?? null;
}

function createPrimaryGroup(defaultDocId: string): EditorGroupRecord {
  return {
    id: DEFAULT_EDITOR_GROUP_ID,
    documentIds: [defaultDocId],
    activeDocumentId: defaultDocId,
    presentation: 'full',
  };
}

export function shaderEditorGroupsFor(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
): ShaderEditorGroups | null {
  if (!shaderId) return null;
  return state.get(shaderId) ?? null;
}

export function editorGroupIdsFor(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
): readonly EditorGroupId[] {
  const shaderGroups = shaderEditorGroupsFor(state, shaderId);
  return shaderGroups?.groups.map((group) => group.id) ?? [];
}

export function openIdsForGroup(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
  groupId: EditorGroupId,
): readonly string[] {
  const shaderGroups = shaderEditorGroupsFor(state, shaderId);
  if (!shaderGroups) return [];
  return findGroup(shaderGroups, groupId)?.documentIds ?? [];
}

export function activeDocumentForGroup(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
  groupId: EditorGroupId,
): string | null {
  const shaderGroups = shaderEditorGroupsFor(state, shaderId);
  if (!shaderGroups) return null;
  return findGroup(shaderGroups, groupId)?.activeDocumentId ?? null;
}

export function activeGroupIdFor(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
): EditorGroupId | null {
  return shaderEditorGroupsFor(state, shaderId)?.activeGroupId ?? null;
}

export function primaryGroupIdFor(
  state: EditorGroupsState,
  shaderId: string | null | undefined,
): EditorGroupId | null {
  return shaderEditorGroupsFor(state, shaderId)?.primaryGroupId ?? null;
}

export function groupOwningDocumentFor(
  state: EditorGroupsState,
  shaderId: string,
  documentId: string,
): EditorGroupId | null {
  const shaderGroups = shaderEditorGroupsFor(state, shaderId);
  if (!shaderGroups) return null;
  return groupOwningDocument(shaderGroups, documentId)?.id ?? null;
}

/** True when every document id appears in at most one group. */
export function hasUniqueDocumentOwnership(shaderGroups: ShaderEditorGroups): boolean {
  const seen = new Set<string>();
  for (const group of shaderGroups.groups) {
    for (const documentId of group.documentIds) {
      if (seen.has(documentId)) return false;
      seen.add(documentId);
    }
  }
  return true;
}

/** Seed a shader with a primary group when it has none yet. */
export function ensureShaderGroups(
  state: EditorGroupsState,
  shaderId: string,
  defaultDocId: string,
): EditorGroupsState {
  const current = state.get(shaderId);
  if (current && current.groups.length > 0) return state;

  const primary = createPrimaryGroup(defaultDocId);
  return setShaderState(state, shaderId, {
    groups: [primary],
    primaryGroupId: primary.id,
    activeGroupId: primary.id,
  });
}

export function createEditorGroup(
  state: EditorGroupsState,
  shaderId: string,
  options: {
    readonly presentation?: EditorGroupPresentation;
    readonly activate?: boolean;
  } = {},
): EditorGroupMutationResult<EditorGroupId> {
  const shaderGroups = state.get(shaderId);
  if (!shaderGroups) return fail('not-found');

  const id = allocateEditorGroupId(shaderGroups.groups);
  const group: EditorGroupRecord = {
    id,
    documentIds: [],
    activeDocumentId: null,
    presentation: options.presentation ?? 'full',
  };

  const nextShader: ShaderEditorGroups = {
    ...shaderGroups,
    groups: [...shaderGroups.groups, group],
    activeGroupId: options.activate ? id : shaderGroups.activeGroupId,
  };

  return ok(setShaderState(state, shaderId, nextShader), id);
}

export function activateEditorGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
): EditorGroupMutationResult {
  const shaderGroups = state.get(shaderId);
  if (!shaderGroups || !findGroup(shaderGroups, groupId)) return fail('not-found');
  if (shaderGroups.activeGroupId === groupId) return ok(state);

  return ok(
    setShaderState(state, shaderId, {
      ...shaderGroups,
      activeGroupId: groupId,
    }),
  );
}

export function openDocumentInGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  documentId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;
    const owner = groupOwningDocument(shaderGroups, documentId);
    if (owner && owner.id !== groupId) return shaderGroups;

    const updated = updateGroup(shaderGroups, groupId, (group) => {
      if (group.documentIds.includes(documentId)) {
        if (group.activeDocumentId === documentId) return group;
        return { ...group, activeDocumentId: documentId };
      }
      return {
        ...group,
        documentIds: [...group.documentIds, documentId],
        activeDocumentId: documentId,
      };
    });
    if (!updated) return shaderGroups;

    return {
      ...updated,
      activeGroupId: groupId,
    };
  });
}

export function selectDocumentInGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  documentId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;
    const updated = updateGroup(shaderGroups, groupId, (group) => {
      if (!group.documentIds.includes(documentId)) return group;
      if (group.activeDocumentId === documentId) return group;
      return { ...group, activeDocumentId: documentId };
    });
    if (!updated) return shaderGroups;
    return { ...updated, activeGroupId: groupId };
  });
}

export function closeDocumentInGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  documentId: string,
): { state: EditorGroupsState; result: CloseDocumentInGroupResult } {
  const shaderGroups = state.get(shaderId);
  if (!shaderGroups) {
    return { state, result: { closed: false, nextActiveHint: null } };
  }

  const group = findGroup(shaderGroups, groupId);
  if (!group) {
    return { state, result: { closed: false, nextActiveHint: null } };
  }

  const index = group.documentIds.indexOf(documentId);
  if (index < 0) {
    return { state, result: { closed: false, nextActiveHint: null } };
  }
  if (group.documentIds.length === 1) {
    return { state, result: { closed: false, nextActiveHint: null } };
  }

  const nextDocumentIds = group.documentIds.filter((id) => id !== documentId);
  const nextActiveHint = nextActiveAfterClose(group.documentIds, index);
  const nextActiveDocumentId =
    group.activeDocumentId === documentId ? nextActiveHint : group.activeDocumentId;

  const nextShader = updateGroup(shaderGroups, groupId, () => ({
    ...group,
    documentIds: nextDocumentIds,
    activeDocumentId: nextActiveDocumentId,
  }));
  if (!nextShader) {
    return { state, result: { closed: false, nextActiveHint: null } };
  }

  return {
    state: setShaderState(state, shaderId, nextShader),
    result: { closed: true, nextActiveHint },
  };
}

export function closeOtherDocumentsInGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  documentId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;
    return (
      updateGroup(shaderGroups, groupId, (group) => {
        if (!group.documentIds.includes(documentId)) return group;
        if (group.documentIds.length === 1 && group.documentIds[0] === documentId) return group;
        return {
          ...group,
          documentIds: [documentId],
          activeDocumentId: documentId,
        };
      }) ?? shaderGroups
    );
  });
}

export function reorderDocumentInGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  sourceId: string,
  targetId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;
    return (
      updateGroup(shaderGroups, groupId, (group) => {
        const current = [...group.documentIds];
        const from = current.indexOf(sourceId);
        const to = current.indexOf(targetId);
        if (from < 0 || to < 0 || from === to) return group;
        current.splice(from, 1);
        current.splice(to, 0, sourceId);
        return { ...group, documentIds: current };
      }) ?? shaderGroups
    );
  });
}

export function moveDocumentBetweenGroups(
  state: EditorGroupsState,
  shaderId: string,
  documentId: string,
  targetGroupId: EditorGroupId,
  options: {
    readonly sourceGroupId?: EditorGroupId;
    readonly index?: number;
    readonly transfer?: EditorDocumentViewTransfer | null;
  } = {},
): EditorGroupMutationResult {
  const shaderGroups = state.get(shaderId);
  if (!shaderGroups) return fail('not-found');

  const sourceGroup =
    (options.sourceGroupId ? findGroup(shaderGroups, options.sourceGroupId) : null) ??
    groupOwningDocument(shaderGroups, documentId);
  if (!sourceGroup) return fail('not-found');

  const targetGroup = findGroup(shaderGroups, targetGroupId);
  if (!targetGroup) return fail('invalid-target');
  if (sourceGroup.id === targetGroup.id && targetGroup.documentIds.includes(documentId)) {
    return ok(state);
  }

  if (!sourceGroup.documentIds.includes(documentId)) return fail('not-found');

  const ownerElsewhere = groupOwningDocument(shaderGroups, documentId);
  if (ownerElsewhere && ownerElsewhere.id !== sourceGroup.id) {
    return fail('duplicate-document');
  }

  const isLastInSource = sourceGroup.documentIds.length === 1;
  const isPrimarySource = sourceGroup.id === shaderGroups.primaryGroupId;
  if (isLastInSource && isPrimarySource) {
    return fail('empty-primary');
  }

  let nextShader = shaderGroups;

  if (isLastInSource) {
    const withoutDoc: EditorGroupRecord = {
      ...sourceGroup,
      documentIds: [],
      activeDocumentId: null,
    };
    const groups = nextShader.groups.map((group) =>
      group.id === sourceGroup.id ? withoutDoc : group,
    );
    nextShader = { ...nextShader, groups };
  } else {
    const sourceIndex = sourceGroup.documentIds.indexOf(documentId);
    const remaining = sourceGroup.documentIds.filter((id) => id !== documentId);
    const nextSourceActive =
      sourceGroup.activeDocumentId === documentId
        ? nextActiveAfterClose(sourceGroup.documentIds, sourceIndex)
        : sourceGroup.activeDocumentId;
    const withoutDoc: EditorGroupRecord = {
      ...sourceGroup,
      documentIds: remaining,
      activeDocumentId: nextSourceActive,
    };
    const groups = nextShader.groups.map((group) =>
      group.id === sourceGroup.id ? withoutDoc : group,
    );
    nextShader = { ...nextShader, groups };
  }

  const targetIds = targetGroup.documentIds.filter((id) => id !== documentId);
  const insertAt =
    options.index === undefined
      ? targetIds.length
      : Math.max(0, Math.min(options.index, targetIds.length));
  const nextTargetIds = [...targetIds];
  nextTargetIds.splice(insertAt, 0, documentId);

  const nextTarget: EditorGroupRecord = {
    ...targetGroup,
    documentIds: nextTargetIds,
    activeDocumentId: documentId,
    presentation: options.transfer?.presentation ?? targetGroup.presentation,
  };

  const groups = nextShader.groups.map((group) =>
    group.id === targetGroup.id ? nextTarget : group,
  );
  nextShader = {
    ...nextShader,
    groups,
    activeGroupId: targetGroupId,
  };

  if (!hasUniqueDocumentOwnership(nextShader)) return fail('duplicate-document');
  return ok(setShaderState(state, shaderId, nextShader));
}

export function mergeEditorGroups(
  state: EditorGroupsState,
  shaderId: string,
  sourceGroupId: EditorGroupId,
  targetGroupId: EditorGroupId,
): EditorGroupMutationResult {
  if (sourceGroupId === targetGroupId) return ok(state);

  const shaderGroups = state.get(shaderId);
  if (!shaderGroups) return fail('not-found');

  const source = findGroup(shaderGroups, sourceGroupId);
  const target = findGroup(shaderGroups, targetGroupId);
  if (!source || !target) return fail('not-found');
  if (shaderGroups.groups.length <= 1) return fail('last-group');

  const targetIds = new Set(target.documentIds);
  const appended = source.documentIds.filter((id) => !targetIds.has(id));
  const mergedTarget: EditorGroupRecord = {
    ...target,
    documentIds: [...target.documentIds, ...appended],
    activeDocumentId: target.activeDocumentId ?? source.activeDocumentId ?? appended[0] ?? null,
  };

  const groups = shaderGroups.groups
    .filter((group) => group.id !== sourceGroupId)
    .map((group) => (group.id === targetGroupId ? mergedTarget : group));

  const activeGroupId =
    shaderGroups.activeGroupId === sourceGroupId ? targetGroupId : shaderGroups.activeGroupId;

  const nextShader: ShaderEditorGroups = {
    ...shaderGroups,
    groups,
    activeGroupId,
  };

  if (!hasUniqueDocumentOwnership(nextShader)) return fail('duplicate-document');
  return ok(setShaderState(state, shaderId, nextShader));
}

export function closeEditorGroup(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  mergeTargetId?: EditorGroupId,
): EditorGroupMutationResult<CloseEditorGroupResult> {
  const shaderGroups = state.get(shaderId);
  if (!shaderGroups) return fail('not-found');
  if (shaderGroups.groups.length <= 1) return fail('last-group');

  const source = findGroup(shaderGroups, groupId);
  if (!source) return fail('not-found');

  const targetId = mergeTargetId ?? shaderGroups.primaryGroupId;
  const merged = mergeEditorGroups(state, shaderId, groupId, targetId);
  if (!merged.ok) return merged;

  return ok(merged.state, {
    mergedDocumentIds: source.documentIds,
    targetGroupId: targetId,
  });
}

export function pruneStaleDocumentsInShader(
  state: EditorGroupsState,
  shaderId: string,
  existingIds: ReadonlySet<string>,
  fallbackDocId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;

    let changed = false;
    const groups = shaderGroups.groups.map((group) => {
      const nextIds = group.documentIds.filter((id) => existingIds.has(id));
      if (nextIds.length === group.documentIds.length) return group;
      changed = true;

      let documentIds = nextIds;
      if (documentIds.length === 0 && group.id === shaderGroups.primaryGroupId) {
        documentIds = [fallbackDocId];
      }

      const activeDocumentId =
        group.activeDocumentId && documentIds.includes(group.activeDocumentId)
          ? group.activeDocumentId
          : (documentIds[0] ?? null);

      return { ...group, documentIds, activeDocumentId };
    });

    if (!changed) return shaderGroups;

    const primary = groups.find((group) => group.id === shaderGroups.primaryGroupId);
    if (primary && primary.documentIds.length === 0) {
      const index = groups.findIndex((group) => group.id === primary.id);
      const patched = [...groups];
      patched[index] = {
        ...primary,
        documentIds: [fallbackDocId],
        activeDocumentId: fallbackDocId,
      };
      return { ...shaderGroups, groups: patched };
    }

    return { ...shaderGroups, groups };
  });
}

export function setGroupPresentation(
  state: EditorGroupsState,
  shaderId: string,
  groupId: EditorGroupId,
  presentation: EditorGroupPresentation,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;
    return (
      updateGroup(shaderGroups, groupId, (group) =>
        group.presentation === presentation ? group : { ...group, presentation },
      ) ?? shaderGroups
    );
  });
}

/** Remove empty non-primary groups after the last tab moves away. */
export function pruneEmptyEditorGroups(
  state: EditorGroupsState,
  shaderId: string,
): EditorGroupsState {
  return updateShader(state, shaderId, (shaderGroups) => {
    if (!shaderGroups) return null;

    const groups = shaderGroups.groups.filter(
      (group) =>
        group.documentIds.length > 0 ||
        group.id === shaderGroups.primaryGroupId ||
        shaderGroups.groups.length === 1,
    );

    if (groups.length === shaderGroups.groups.length) return shaderGroups;

    const activeGroupId = groups.some((group) => group.id === shaderGroups.activeGroupId)
      ? shaderGroups.activeGroupId
      : (groups[0]?.id ?? shaderGroups.primaryGroupId);

    return { ...shaderGroups, groups, activeGroupId };
  });
}
