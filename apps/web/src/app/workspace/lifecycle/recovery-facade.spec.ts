import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  addBuffer,
  bufferPasses,
  imagePass,
  migrateLegacyProject,
} from '@shader-studio/shared';
import type { ShaderDraft } from '../state/document-state';
import {
  FRAGMENT,
  MemoryStorage,
  VERTEX,
  flush,
  makeRecord,
  setupLifecycle,
} from './testing/lifecycle-harness';

/**
 * What the browser is still holding, and what happens to it when a shader is
 * opened.
 *
 * Two stores, two quite different meanings, and the whole risk lives in keeping
 * them apart: `DraftRecovery` holds work that was *not* saved, and
 * `ProjectPersistence` holds a pre-upgrade copy of a project on its way to the
 * server. Treating either as the other loses somebody's work.
 */

const RECOVERY_KEY = 'shader-studio.recovered-drafts';
const PROJECTS_KEY = 'shader-studio.projects';

function seedRecoveredDraft(
  storage: MemoryStorage,
  baselineUpdatedAt: string,
  draft: ShaderDraft,
): void {
  storage.setItem(
    RECOVERY_KEY,
    JSON.stringify({
      version: 2,
      drafts: {
        waves: {
          shaderId: 'waves',
          baselineUpdatedAt,
          draftUpdatedAt: '2024-01-02T00:00:00.000Z',
          ...draft,
        },
      },
    }),
  );
}

function seedLocalProject(
  storage: MemoryStorage,
  baselineUpdatedAt: string,
  project = migrateLegacyProject(FRAGMENT, VERTEX),
): void {
  storage.setItem(
    PROJECTS_KEY,
    JSON.stringify({
      version: 1,
      projects: { waves: { shaderId: 'waves', baselineUpdatedAt, project } },
    }),
  );
}

function unsavedDraft(): ShaderDraft {
  return {
    project: addBuffer(migrateLegacyProject('void main() { /* recovered */ }', VERTEX)),
    controlsText: '[]',
    render: structuredClone(DEFAULT_RENDER),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('RecoveryFacade: unsaved drafts', () => {
  it('restores a recovered draft whose baseline still matches, without asking', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedRecoveredDraft(storage, record.updatedAt, unsavedDraft());

    const { selection, state } = setupLifecycle(storage, record);
    selection.adopt(record);

    // Same document, one reload later: nothing to ask about.
    expect(state.staleRecovery()).toBeNull();
    expect(state.fragment()).toBe('void main() { /* recovered */ }');
    expect(bufferPasses(state.project()!)).toHaveLength(1);
    // Restored through the controls path, so the schema is re-projected onto the
    // live params rather than leaving the previous shader's uniforms behind.
    expect(state.controls()).toEqual([]);
    expect(state.dirty()).toBe(true);
  });

  it('parks a stale recovered draft instead of restoring it', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedRecoveredDraft(storage, 'a baseline from before an import', unsavedDraft());

    const { selection, state } = setupLifecycle(storage, record);
    selection.adopt(record);

    // The shader moved on underneath the draft. Reinstating it silently could
    // undo an import or another tab's save, so it waits for an answer.
    expect(state.staleRecovery()?.shaderId).toBe('waves');
    expect(state.fragment()).toBe(FRAGMENT);
    expect(state.dirty()).toBe(false);
  });

  it('restores a stale draft when the user says so', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedRecoveredDraft(storage, 'stale', unsavedDraft());

    const { selection, recovery, state } = setupLifecycle(storage, record);
    selection.adopt(record);
    recovery.resolve(true);

    expect(state.fragment()).toBe('void main() { /* recovered */ }');
    expect(state.staleRecovery()).toBeNull();
  });

  it('removes the stored copy when the user discards a stale draft', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedRecoveredDraft(storage, 'stale', unsavedDraft());

    const { selection, recovery, state } = setupLifecycle(storage, record);
    selection.adopt(record);
    recovery.resolve(false);

    expect(state.staleRecovery()).toBeNull();
    expect(state.fragment()).toBe(FRAGMENT);
    expect(storage.getItem(RECOVERY_KEY)).not.toContain('recovered');
  });

  it('refuses to paste a stale draft onto a different shader', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedRecoveredDraft(storage, 'stale', unsavedDraft());

    const { selection, recovery, state, api } = setupLifecycle(
      storage,
      record,
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );
    selection.adopt(record);
    expect(state.staleRecovery()).not.toBeNull();

    const pending = selection.select('plasma');
    api.settle('plasma');
    await pending;

    // `adopt` cleared it, but even if it had not, the id no longer matches.
    recovery.resolve(true);
    expect(state.fragment()).toBe(FRAGMENT);
    expect(state.staleRecovery()).toBeNull();
  });

  it('flushes a dirty draft, and only a dirty one', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();

    const { selection, recovery, state } = setupLifecycle(storage, record);
    selection.adopt(record);

    // Clean: what the server already holds. Storing it would be
    // indistinguishable from unsaved work on the next load.
    recovery.flush();
    expect(storage.getItem(RECOVERY_KEY)).toBeNull();

    state.patchDraft({ controlsText: '[]' });
    expect(state.dirty()).toBe(true);
    recovery.flush();

    expect(storage.getItem(RECOVERY_KEY)).toContain('waves');
  });

  it('discarding the draft drops the recovery copy and re-opens the record', () => {
    const storage = new MemoryStorage();
    const record = makeRecord();

    const { selection, recovery, state } = setupLifecycle(storage, record);
    selection.adopt(record);
    state.patchDraft({ controlsText: '[]' });
    recovery.flush();
    expect(storage.getItem(RECOVERY_KEY)).toContain('waves');

    selection.discardDraft();

    // Removed *before* re-adopting: otherwise adoption would find the draft
    // that was just discarded and put it straight back.
    expect(storage.getItem(RECOVERY_KEY)).not.toContain('"waves"');
    expect(state.dirty()).toBe(false);
    expect(state.staleRecovery()).toBeNull();
  });
});

describe('RecoveryFacade: pre-upgrade local projects', () => {
  it('reconciles a stale local project onto the record and migrates the result', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord({
      fragment: 'REPLACED BY AN IMPORT',
      updatedAt: '2099-01-01T00:00:00.000Z',
      project: migrateLegacyProject('REPLACED BY AN IMPORT', VERTEX),
    });
    seedLocalProject(
      storage,
      'a stale baseline',
      addBuffer(migrateLegacyProject(FRAGMENT, VERTEX)),
    );

    const { selection, state, api } = setupLifecycle(storage, record);
    selection.adopt(record);

    // The record wins for what the record owns; the buffer survives regardless.
    expect(state.fragment()).toBe('REPLACED BY AN IMPORT');
    expect(bufferPasses(state.project()!)).toHaveLength(1);

    await flush();

    expect(api.updates).toHaveLength(1);
    expect(imagePass(api.updates[0].patch.project!).source).toBe('REPLACED BY AN IMPORT');
    expect(storage.getItem(PROJECTS_KEY)).not.toContain('waves');
  });

  it('keeps the local copy when the push fails, so a later load can retry', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedLocalProject(storage, record.updatedAt);

    const { selection, state, api } = setupLifecycle(storage, record);
    api.failNextUpdate = new Error('offline');
    selection.adopt(record);
    await flush();

    expect(api.updates).toHaveLength(1);
    expect(storage.getItem(PROJECTS_KEY)).toContain('waves');
    // The shader itself is still perfectly usable in the meantime.
    expect(state.record()).not.toBeNull();
  });

  it('does not fire a second push while the first is still in the air', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord();
    seedLocalProject(storage, record.updatedAt);

    const { selection, api } = setupLifecycle(storage, record);
    api.stallUpdates = true;

    selection.adopt(record);
    selection.adopt(record);
    await flush();

    expect(api.updates).toHaveLength(1);
  });

  it('leaves a record with no local copy entirely alone', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord();

    const { selection, state, api } = setupLifecycle(storage, record);
    selection.adopt(record);
    await flush();

    expect(api.updates).toHaveLength(0);
    expect(state.dirty()).toBe(false);
  });
});
