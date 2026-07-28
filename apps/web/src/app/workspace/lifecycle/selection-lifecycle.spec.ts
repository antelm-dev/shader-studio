import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage, flush, makeRecord, setupLifecycle } from './testing/lifecycle-harness';

/**
 * Selection, and specifically what happens when two of them overlap.
 *
 * A read is not instant. Click Waves, change your mind and click Plasma, and
 * both requests are in the air at once with nothing to say which answers first.
 * The rule is simply that the shader the user asked for *last* is the shader
 * they end up looking at — including when the older answer is the one that
 * arrives last, which is the case a naive implementation gets wrong.
 */

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('SelectionLifecycle: overlapping selections', () => {
  it('keeps the newer selection when the older read answers last', async () => {
    const { selection, state, preferences, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    const first = selection.select('waves');
    const second = selection.select('plasma');

    // B answers first and wins.
    api.settle('plasma');
    await second;
    expect(state.selectedId()).toBe('plasma');

    // A answers second, about a shader nobody is looking at any more.
    api.settle('waves');
    await first;

    expect(state.selectedId()).toBe('plasma');
    expect(preferences.value().lastShaderId).toBe('plasma');
    expect(state.loading()).toBe(false);
  });

  it('keeps the spinner up until the last outstanding read has landed', async () => {
    const { selection, state, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    const first = selection.select('waves');
    const second = selection.select('plasma');
    expect(state.loading()).toBe(true);

    api.settle('plasma');
    await second;
    // The superseded read is still in the air: saying "loaded" now and then
    // going quiet would be a lie either way round.
    expect(state.loading()).toBe(true);

    api.settle('waves');
    await first;
    expect(state.loading()).toBe(false);
  });

  it('says nothing about a superseded read that failed', async () => {
    const { selection, state, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    api.failures.set('waves', new Error('Cannot reach the server'));
    const first = selection.select('waves');
    const second = selection.select('plasma');

    api.settle('plasma');
    await second;
    api.settle('waves');
    await first;

    // The user asked for Plasma and got Plasma. An error about the request they
    // abandoned is noise, not news.
    expect(state.selectedId()).toBe('plasma');
    expect(state.notice()).toBeNull();
  });

  it('reports a failure that is still the current selection', async () => {
    const { selection, state, api } = setupLifecycle(new MemoryStorage(), makeRecord());

    api.failures.set('waves', new Error('Cannot reach the server'));
    const pending = selection.select('waves');
    api.settle('waves');
    await pending;

    expect(state.notice()?.error).toBe(true);
    expect(state.record()).toBeNull();
    expect(state.loading()).toBe(false);
  });

  it('does not let a read in flight overwrite a shader that was just created', async () => {
    const { selection, state, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    const pending = selection.select('waves');
    selection.adoptCreated(makeRecord({ id: 'plasma', name: 'Plasma' }));
    expect(state.selectedId()).toBe('plasma');

    api.settle('waves');
    await pending;

    expect(state.selectedId()).toBe('plasma');
  });

  it('does not let a read in flight repopulate a workspace that was just cleared', async () => {
    const { selection, state, api } = setupLifecycle(new MemoryStorage(), makeRecord());

    const pending = selection.select('waves');
    selection.clearCurrent();

    api.settle('waves');
    await pending;

    expect(state.record()).toBeNull();
    expect(state.draft()).toBeNull();
  });

  it('does not read a shader that is already open', async () => {
    const { selection, api } = setupLifecycle(new MemoryStorage(), makeRecord());

    const pending = selection.select('waves');
    api.settle('waves');
    await pending;

    await selection.select('waves');
    expect(api.reads).toEqual(['waves']);
  });

  it('reloads the open shader when force-selected', async () => {
    const { selection, api } = setupLifecycle(new MemoryStorage(), makeRecord());

    const first = selection.select('waves');
    api.settle('waves');
    await first;

    const forced = selection.forceSelect('waves');
    api.settle('waves');
    await forced;

    expect(api.reads).toEqual(['waves', 'waves']);
  });
});

describe('SelectionLifecycle: adoption', () => {
  it('resets the compile revision exactly once per adopted shader', async () => {
    const { selection, state, compilation, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    const first = selection.select('waves');
    api.settle('waves');
    await first;

    // Something the compile machinery has to be told about.
    state.patchDraft({ controlsText: '[]' });
    expect(compilation.draftRevision()).toBeGreaterThan(0);

    const second = selection.select('plasma');
    api.settle('plasma');
    await second;

    expect(compilation.draftRevision()).toBe(0);
  });

  it('clears the workspace and forgets the remembered shader', async () => {
    const { selection, state, preferences, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
    );

    const pending = selection.select('waves');
    api.settle('waves');
    await pending;
    expect(preferences.value().lastShaderId).toBe('waves');

    selection.clearCurrent();

    expect(state.record()).toBeNull();
    expect(state.draft()).toBeNull();
    expect(state.params()).toEqual({});
    expect(preferences.value().lastShaderId).toBeNull();
  });

  it('falls back to the first shader left, and says when there is none', async () => {
    const { selection, state, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    await selection.refreshList();
    const fallback = selection.selectFallback();
    api.settle('plasma');
    expect(await fallback).toBe(true);
    expect(state.selectedId()).toBe('plasma');

    state.shaders.set([]);
    expect(await selection.selectFallback()).toBe(false);
  });
});

describe('SelectionLifecycle: startup', () => {
  it('opens the route shader when it exists, and the first one otherwise', async () => {
    const { selection, state, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );

    const pending = selection.initialize('plasma');
    await flush();
    api.settle('plasma');
    await pending;

    expect(state.selectedId()).toBe('plasma');
  });

  it('honours the remembered shader once the client takes over', async () => {
    const { selection, state, preferences, api } = setupLifecycle(
      new MemoryStorage(),
      makeRecord(),
      makeRecord({ id: 'plasma', name: 'Plasma' }),
    );
    preferences.patch({ lastShaderId: 'plasma' });

    const pending = selection.initializeClient();
    await flush();
    api.settle('waves');
    await flush();
    api.settle('plasma');
    await pending;

    expect(state.selectedId()).toBe('plasma');
  });
});
