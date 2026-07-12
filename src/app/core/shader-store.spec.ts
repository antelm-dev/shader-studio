import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RENDER,
  toSummary,
  type ImportResult,
  type Preset,
  type ShaderControl,
  type ShaderParams,
  type ShaderRecord,
  type ShaderSummary,
} from '../../shared/model';
import { Preferences, type WorkspacePreferences } from './preferences';
import { DEFAULT_EDITOR_APPEARANCE, DEFAULT_EDITOR_WINDOW } from './editor-prefs';
import { ApiError, type UpdateShaderPatch } from './shader-api';
import { ShaderApi } from './shader-api';
import { ShaderStore } from './shader-store';

/**
 * The store is tested against a fake API rather than an HTTP mock: what is
 * worth pinning down here is the state machine — what the draft, the params and
 * the active preset do to each other — not the wire format, which `shader-api`
 * owns and the server specs already cover.
 */

const CONTROLS: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'glow', type: 'boolean', default: false },
];

function makeRecord(overrides: Partial<ShaderRecord> = {}): ShaderRecord {
  return {
    id: 'waves',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    fragment: 'void main() { gl_FragColor = vec4(1.0); }',
    vertex: 'void main() { gl_Position = vec4(position, 1.0); }',
    presets: [],
    ...overrides,
  };
}

function controlsText(controls: readonly ShaderControl[]): string {
  return JSON.stringify(controls, null, 2);
}

/** An in-memory stand-in for the server. Only what the store actually calls. */
class FakeApi implements Partial<ShaderApi> {
  records = new Map<string, ShaderRecord>();

  /** Set to make the next call of that name reject. */
  failures = new Map<string, ApiError>();

  readonly calls: string[] = [];

  constructor(...records: ShaderRecord[]) {
    for (const record of records) this.records.set(record.id, record);
  }

  private track<T>(name: string, produce: () => T): Promise<T> {
    this.calls.push(name);
    const failure = this.failures.get(name);
    if (failure) {
      this.failures.delete(name);
      return Promise.reject(failure);
    }
    return Promise.resolve(produce());
  }

  list(): Promise<ShaderSummary[]> {
    return this.track('list', () => [...this.records.values()].map(toSummary));
  }

  read(id: string): Promise<ShaderRecord> {
    return this.track('read', () => {
      const record = this.records.get(id);
      if (!record) throw new ApiError(`No such shader ${id}`, [], 404);
      return structuredClone(record);
    });
  }

  create(name: string): Promise<ShaderRecord> {
    return this.track('create', () => {
      const created = makeRecord({ id: name.toLowerCase(), name, presets: [] });
      this.records.set(created.id, created);
      return structuredClone(created);
    });
  }

  update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    return this.track('update', () => {
      const current = this.records.get(id);
      if (!current) throw new ApiError(`No such shader ${id}`, [], 404);

      const updated: ShaderRecord = {
        ...current,
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.fragment === undefined ? {} : { fragment: patch.fragment }),
        ...(patch.vertex === undefined ? {} : { vertex: patch.vertex }),
        ...(patch.controls === undefined ? {} : { controls: patch.controls as ShaderControl[] }),
        ...(patch.render === undefined ? {} : { render: patch.render as ShaderRecord['render'] }),
        updatedAt: '2024-02-02T00:00:00.000Z',
      };
      this.records.set(id, updated);
      return structuredClone(updated);
    });
  }

  duplicate(id: string, name?: string): Promise<ShaderRecord> {
    return this.track('duplicate', () => {
      const source = this.records.get(id);
      if (!source) throw new ApiError(`No such shader ${id}`, [], 404);

      const copy = structuredClone(source);
      copy.id = `${id}-2`;
      copy.name = name ?? `${source.name} copy`;
      this.records.set(copy.id, copy);
      return structuredClone(copy);
    });
  }

  remove(id: string): Promise<void> {
    return this.track('remove', () => {
      this.records.delete(id);
    });
  }

  savePreset(_id: string, name: string, values: ShaderParams): Promise<Preset> {
    return this.track('savePreset', () => ({
      id: name.toLowerCase(),
      name,
      createdAt: '2024-03-03T00:00:00.000Z',
      values: structuredClone(values),
    }));
  }

  deletePreset(): Promise<void> {
    return this.track('deletePreset', () => undefined);
  }

  importBundle(): Promise<ImportResult> {
    return this.track('importBundle', () => ({
      imported: [{ id: 'waves', name: 'Waves', replaced: true }],
    }));
  }
}

/** Preferences without the browser: a signal and a patch, nothing persisted. */
class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>({
    lastShaderId: null,
    browserOpen: true,
    editorOpen: false,
    guiVisible: true,
    resolutionScale: 1,
    paused: false,
    autoRipples: false,
    colorScheme: 'dark',
    editorAppearance: DEFAULT_EDITOR_APPEARANCE,
    editorWindow: DEFAULT_EDITOR_WINDOW,
  });

  readonly value = this.state.asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

interface Harness {
  store: ShaderStore;
  api: FakeApi;
  preferences: FakePreferences;
}

function setup(...records: ShaderRecord[]): Harness {
  const api = new FakeApi(...records);
  const preferences = new FakePreferences();

  TestBed.configureTestingModule({
    providers: [
      { provide: ShaderApi, useValue: api },
      { provide: Preferences, useValue: preferences },
    ],
  });

  return { store: TestBed.inject(ShaderStore), api, preferences };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  // `report` logs every failure; the failure paths below are deliberate.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ShaderStore: loading', () => {
  it('opens the first shader and mirrors it into the draft', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    const record = store.record();
    expect(record?.id).toBe('waves');
    expect(store.draft()).toEqual({
      fragment: record!.fragment,
      vertex: record!.vertex,
      controlsText: controlsText(record!.controls),
      render: record!.render,
    });
    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.dirty()).toBe(false);
  });

  it('remembers the shader as the last one opened', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    expect(preferences.value().lastShaderId).toBe('waves');
  });

  it('does not reload a shader that is already open', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    const before = api.calls.filter((call) => call === 'read').length;

    await store.select('waves');
    expect(api.calls.filter((call) => call === 'read')).toHaveLength(before);
  });

  it('reports a failed load as a notice instead of throwing', async () => {
    const { store, api } = setup(makeRecord());
    api.failures.set('read', new ApiError('Cannot reach the server'));

    await store.select('waves');

    expect(store.notice()).toEqual({ text: 'Cannot reach the server', error: true });
    expect(store.record()).toBeNull();
    expect(store.loading()).toBe(false);
  });

  it('honours the remembered shader once the client takes over', async () => {
    const { store, preferences } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    preferences.patch({ lastShaderId: 'plasma' });

    await store.initializeClient();

    expect(store.selectedId()).toBe('plasma');
  });

  it('ignores a remembered shader that no longer exists', async () => {
    const { store, preferences } = setup(makeRecord());
    preferences.patch({ lastShaderId: 'deleted' });

    await store.initializeClient();

    expect(store.selectedId()).toBe('waves');
  });
});

describe('ShaderStore: dirty', () => {
  it('tracks each buffer against the record', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const record = store.record()!;

    store.setFragment('void main() {}');
    expect(store.dirty()).toBe(true);

    store.setFragment(record.fragment);
    expect(store.dirty()).toBe(false);

    store.setVertex('void main() {}');
    expect(store.dirty()).toBe(true);

    store.setVertex(record.vertex);
    store.setRender({ bloom: { ...record.render.bloom, enabled: true } });
    expect(store.dirty()).toBe(true);

    store.setRender(structuredClone(record.render));
    expect(store.dirty()).toBe(false);
  });

  it('does not count a turned knob as an unsaved edit', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setParam('speed', 4);

    expect(store.params()['speed']).toBe(4);
    expect(store.dirty()).toBe(false);
  });
});

describe('ShaderStore: config buffer', () => {
  it('keeps the last known-good schema while the text is half-typed', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText('[{"key": "speed", "type": "num');

    expect(store.configValid()).toBe(false);
    expect(store.controls()).toEqual(CONTROLS);
    expect(store.hasErrors()).toBe(true);
    expect(store.diagnostics()[0]).toMatchObject({ source: 'config', severity: 'error', line: 0 });
  });

  it('surfaces a schema that parses but does not validate', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText(JSON.stringify([{ key: 'speed', type: 'number', default: 5, min: 10, max: 0 }]));

    expect(store.configValid()).toBe(false);
    expect(store.diagnostics().some((entry) => entry.source === 'config')).toBe(true);
  });

  it('re-projects the live params as soon as the schema parses again', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setParam('speed', 7);

    store.setControlsText(
      controlsText([
        { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
        { key: 'hue', type: 'color', default: '#ff0000' },
      ]),
    );

    // `speed` survives at its live value, `hue` appears at its default, and the
    // dropped `glow` takes its value with it.
    expect(store.params()).toEqual({ speed: 7, hue: '#ff0000' });
    expect(store.configValid()).toBe(true);
    expect(store.diagnostics()).toEqual([]);
  });

  it('clamps a live value that the new schema no longer allows', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setParam('speed', 9);

    store.setControlsText(controlsText([{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }]));

    expect(store.params()['speed']).toBe(2);
  });
});

describe('ShaderStore: diagnostics', () => {
  it('replaces compile diagnostics without dropping the config ones', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setControlsText('not json');

    store.setCompileDiagnostics([
      { severity: 'error', line: 3, message: 'undeclared identifier', source: 'fragment' },
    ]);
    store.setCompileDiagnostics([
      { severity: 'warning', line: 5, message: 'unused variable', source: 'fragment' },
    ]);

    const sources = store.diagnostics().map((entry) => entry.source);
    expect(sources).toEqual(['config', 'fragment']);
    expect(store.diagnostics().filter((entry) => entry.source === 'fragment')).toHaveLength(1);
  });

  it('has errors only when something is an error', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setCompileDiagnostics([
      { severity: 'warning', line: 5, message: 'unused variable', source: 'fragment' },
    ]);
    expect(store.hasErrors()).toBe(false);

    store.setCompileDiagnostics([
      { severity: 'error', line: 5, message: 'syntax error', source: 'fragment' },
    ]);
    expect(store.hasErrors()).toBe(true);
  });
});

describe('ShaderStore: saving', () => {
  it('refuses to save a broken schema and says why', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setControlsText('not json');

    await store.save();

    expect(api.calls).not.toContain('update');
    expect(store.notice()).toEqual({
      text: 'Fix the configuration schema before saving',
      error: true,
    });
  });

  it('adopts the saved record and comes back clean', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() { gl_FragColor = vec4(0.0); }');

    await store.save();

    expect(store.record()?.fragment).toBe('void main() { gl_FragColor = vec4(0.0); }');
    expect(store.dirty()).toBe(false);
    expect(store.notice()).toEqual({ text: 'Saved “Waves”', error: false });
  });

  it('keeps the live params and the open preset across a save', async () => {
    const preset: Preset = {
      id: 'calm',
      name: 'Calm',
      createdAt: '2024-01-01T00:00:00.000Z',
      values: { speed: 2, glow: true },
    };
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.setFragment('void main() {}');
    await store.save();

    expect(store.params()).toEqual({ speed: 2, glow: true });
    expect(store.activePresetId()).toBe('calm');
  });

  it('drops a param the saved schema no longer declares', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.setControlsText(controlsText([{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }]));
    store.setParam('speed', 6);
    await store.save();

    expect(store.params()).toEqual({ speed: 6 });
  });

  it('ignores a second save while the first is in flight', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');

    await Promise.all([store.save(), store.save()]);

    expect(api.calls.filter((call) => call === 'update')).toHaveLength(1);
  });

  it('leaves the draft alone when the save fails', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');
    api.failures.set('update', new ApiError('Write failed', ['disk full']));

    await store.save();

    expect(store.draft()?.fragment).toBe('void main() {}');
    expect(store.dirty()).toBe(true);
    expect(store.saving()).toBe(false);
    expect(store.notice()).toEqual({ text: 'Write failed: disk full', error: true });
  });

  it('throws the draft away on revert', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    const original = store.record()!.fragment;

    store.setFragment('void main() {}');
    store.setParam('speed', 8);
    store.revert();

    expect(store.draft()?.fragment).toBe(original);
    expect(store.dirty()).toBe(false);
    // Reverting the source resets the knobs too: `adopt` is a full reset.
    expect(store.params()).toEqual({ speed: 1, glow: false });
  });
});

describe('ShaderStore: presets', () => {
  const preset: Preset = {
    id: 'calm',
    name: 'Calm',
    createdAt: '2024-01-01T00:00:00.000Z',
    values: { speed: 3, glow: true },
  };

  it('applies a preset onto the live params', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');

    expect(store.params()).toEqual({ speed: 3, glow: true });
    expect(store.activePresetId()).toBe('calm');
  });

  it('projects an old preset onto the schema being edited now', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    // The draft adds a control and narrows `speed`; neither is saved yet.
    store.setControlsText(
      controlsText([
        { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
        { key: 'hue', type: 'color', default: '#00ff00' },
      ]),
    );
    store.applyPreset('calm');

    // `speed` clamped into the new range, `hue` defaulted, `glow` dropped.
    expect(store.params()).toEqual({ speed: 2, hue: '#00ff00' });
  });

  it('forgets the preset as soon as a knob moves', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.setParam('speed', 5);

    expect(store.activePresetId()).toBeNull();
  });

  it('resets the knobs to the schema defaults', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.applyPreset('calm');
    store.resetParams();

    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.activePresetId()).toBeNull();
  });

  it('ignores a preset that is not there', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    store.applyPreset('ghost');

    expect(store.params()).toEqual({ speed: 1, glow: false });
    expect(store.activePresetId()).toBeNull();
  });

  it('replaces a preset saved under an existing name rather than adding a second', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();

    store.setParam('speed', 9);
    await store.savePreset('Calm');

    expect(store.presets()).toHaveLength(1);
    expect(store.presets()[0].values).toEqual({ speed: 9, glow: false });
    expect(store.activePresetId()).toBe('calm');
  });

  it('deletes a preset and clears it if it was the open one', async () => {
    const { store } = setup(makeRecord({ presets: [preset] }));
    await store.initialize();
    store.applyPreset('calm');

    await store.deletePreset('calm');

    expect(store.presets()).toEqual([]);
    expect(store.activePresetId()).toBeNull();
  });
});

describe('ShaderStore: collection', () => {
  it('opens a newly created shader', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    await store.create('Plasma');

    expect(store.selectedId()).toBe('plasma');
    expect(store.dirty()).toBe(false);
    expect(preferences.value().lastShaderId).toBe('plasma');
    expect(store.notice()).toEqual({ text: 'Created “Plasma”', error: false });
  });

  it('opens the copy, not the original', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();

    await store.duplicate('waves');

    expect(store.selectedId()).toBe('waves-2');
    expect(store.shaders().map((shader) => shader.id)).toContain('waves-2');
  });

  it('renames in place without disturbing the draft', async () => {
    const { store } = setup(makeRecord());
    await store.initialize();
    store.setFragment('void main() {}');

    await store.rename('waves', 'Ripples');

    expect(store.record()?.name).toBe('Ripples');
    expect(store.draft()?.fragment).toBe('void main() {}');
    expect(store.dirty()).toBe(true);
  });

  it('falls back to the next shader when the open one is deleted', async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();

    await store.remove('waves');

    expect(store.selectedId()).toBe('plasma');
    expect(store.draft()).not.toBeNull();
  });

  it('empties the workspace when the last shader is deleted', async () => {
    const { store, preferences } = setup(makeRecord());
    await store.initialize();

    await store.remove('waves');

    expect(store.record()).toBeNull();
    expect(store.draft()).toBeNull();
    expect(store.params()).toEqual({});
    expect(preferences.value().lastShaderId).toBeNull();
  });

  it('keeps the open shader when a different one is deleted', async () => {
    const { store } = setup(makeRecord(), makeRecord({ id: 'plasma', name: 'Plasma' }));
    await store.initialize();

    await store.remove('plasma');

    expect(store.selectedId()).toBe('waves');
    expect(store.shaders().map((shader) => shader.id)).toEqual(['waves']);
  });

  it('reloads the shader an import replaced under it', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    api.records.set('waves', makeRecord({ fragment: 'void main() { /* imported */ }' }));

    await store.importBundle({}, 'overwrite');

    // Same id as the open one, so a plain `select` would have been a no-op.
    expect(store.record()?.fragment).toBe('void main() { /* imported */ }');
    expect(store.notice()).toEqual({ text: 'Imported 1 shader (1 replaced)', error: false });
  });

  it('reports an import the server rejected', async () => {
    const { store, api } = setup(makeRecord());
    await store.initialize();
    api.failures.set('importBundle', new ApiError('Invalid bundle', ['unsupported format']));

    await store.importBundle({});

    expect(store.notice()).toEqual({ text: 'Invalid bundle: unsupported format', error: true });
    expect(store.selectedId()).toBe('waves');
  });
});
