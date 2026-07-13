import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CAPTURE,
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  bufferPasses,
  commonPass,
  imagePass,
  migrateLegacyProject,
  toSummary,
  type ShaderControl,
  type ShaderRecord,
  type ShaderSummary,
} from '@shader-studio/shared';

import { CONFIG_DOC, VERTEX_DOC } from './diagnostic';
import { DEFAULT_EDITOR_APPEARANCE, DEFAULT_EDITOR_WINDOW } from './editor-prefs';
import { DEFAULT_PREVIEW_WINDOW } from './preview-prefs';
import { DEFAULT_PANEL_WIDTHS } from './panel-prefs';
import { Preferences, type WorkspacePreferences } from './preferences';
import { ProjectPersistence } from './project-persistence';
import { ShaderApi, type UpdateShaderPatch } from './shader-api';
import { ShaderStore } from './shader-store';

/**
 * The project half of the store: how a shader record becomes a multi-pass
 * project, what happens to that project across a save and a reload, and what a
 * shader that has never heard of passes does when it meets this code.
 *
 * That last one is the one that matters most. Every shader anyone already has is
 * a "legacy" shader, and the acceptance criterion is not that they can be
 * migrated but that nobody has to notice.
 */

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

const CONTROLS: ShaderControl[] = [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }];

function makeRecord(overrides: Partial<ShaderRecord> = {}): ShaderRecord {
  return {
    id: 'waves',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

/**
 * The real document, with only `localStorage` swapped out.
 *
 * A hand-rolled stand-in for `DOCUMENT` is not an option here: the store pulls in
 * enough of Angular that the document it is given has to be a real one. So the
 * substitution is made as narrow as it can be — one property, on the window —
 * and everything else is forwarded to the document the test environment made.
 */
function documentWith(storage: Storage): Document {
  const view = new Proxy(globalThis.window, {
    get: (target, property) =>
      property === 'localStorage' ? storage : Reflect.get(target, property, target),
  });

  return new Proxy(globalThis.document, {
    get(target, property) {
      if (property === 'defaultView') return view;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Document;
}

class FakeApi implements Partial<ShaderApi> {
  records = new Map<string, ShaderRecord>();
  private saves = 0;

  constructor(...records: ShaderRecord[]) {
    for (const record of records) this.records.set(record.id, record);
  }

  list(): Promise<ShaderSummary[]> {
    return Promise.resolve([...this.records.values()].map(toSummary));
  }

  read(id: string): Promise<ShaderRecord> {
    return Promise.resolve(structuredClone(this.records.get(id)!));
  }

  update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    const current = this.records.get(id)!;
    const updated: ShaderRecord = {
      ...current,
      ...(patch.fragment === undefined ? {} : { fragment: patch.fragment }),
      ...(patch.vertex === undefined ? {} : { vertex: patch.vertex }),
      ...(patch.controls === undefined ? {} : { controls: patch.controls as ShaderControl[] }),
      ...(patch.render === undefined ? {} : { render: patch.render as ShaderRecord['render'] }),
      // A new `updatedAt` on every save: this is the value the stored project's
      // baseline is pinned to, and reusing one would hide any bug in that.
      updatedAt: `2024-02-0${++this.saves}T00:00:00.000Z`,
    };
    this.records.set(id, updated);
    return Promise.resolve(structuredClone(updated));
  }

  remove(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }
}

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>({
    lastShaderId: null,
    browserOpen: true,
    editorOpen: false,
    guiVisible: true,
    browserWidth: DEFAULT_PANEL_WIDTHS.browser,
    inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
    inspectorTab: 'controls',
    resolutionScale: 1,
    paused: false,
    autoRipples: false,
    colorScheme: 'dark',
    editorAppearance: DEFAULT_EDITOR_APPEARANCE,
    editorWindow: DEFAULT_EDITOR_WINDOW,
    previewWindow: DEFAULT_PREVIEW_WINDOW,
    capture: DEFAULT_CAPTURE,
  });

  readonly value = this.state.asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

interface Harness {
  store: ShaderStore;
  api: FakeApi;
  storage: MemoryStorage;
}

/**
 * A store on top of a given storage. Passing the *same* `MemoryStorage` to two
 * of these is how a page reload is simulated: new store, new everything, same
 * bytes on disk.
 */
function setup(storage: MemoryStorage, ...records: ShaderRecord[]): Harness {
  TestBed.resetTestingModule();

  const api = new FakeApi(...records);

  TestBed.configureTestingModule({
    providers: [
      { provide: ShaderApi, useValue: api },
      { provide: Preferences, useValue: new FakePreferences() },
      { provide: PLATFORM_ID, useValue: 'browser' },
      { provide: DOCUMENT, useValue: documentWith(storage) },
    ],
  });

  return { store: TestBed.inject(ShaderStore), api, storage };
}

beforeEach(() => {
  TestBed.resetTestingModule();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// Legacy shaders
// ---------------------------------------------------------------------------

describe('a shader that predates passes', () => {
  it('opens as a project with an Image pass and an empty Common', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    expect(store.fragment()).toBe(FRAGMENT);
    expect(store.vertex()).toBe(VERTEX);
    expect(commonPass(store.project()!)?.source).toBe('');
    expect(store.buffers()).toHaveLength(0);
    // Nothing was migrated *to*: it opens clean, so the user is not told they
    // have unsaved changes they never made.
    expect(store.dirty()).toBe(false);
  });

  it('keeps sampling its textures through the same channels', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    // The old engine bound iChannelN straight to texture slot N. A migrated
    // project has to reproduce that or every shader with an image comes back
    // wrong — and it would look like a renderer bug, not a migration one.
    expect(imagePass(store.project()!).channels).toEqual([
      { kind: 'texture', slot: 0 },
      { kind: 'texture', slot: 1 },
      { kind: 'texture', slot: 2 },
      { kind: 'texture', slot: 3 },
    ]);
  });

  it('still saves as a plain record the server understands', async () => {
    const { store, api } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.setFragment('void main() { gl_FragColor = vec4(0.5); }');
    await store.save();

    // The record the server holds is exactly what it always was.
    expect(api.records.get('waves')!.fragment).toBe('void main() { gl_FragColor = vec4(0.5); }');
    expect(api.records.get('waves')!.vertex).toBe(VERTEX);
  });
});

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

describe('unsaved changes', () => {
  it('notices a new buffer', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();
    expect(store.dirty()).toBe(false);

    store.addBufferPass();

    // The record cannot express a buffer, so measuring dirtiness against it
    // would let this change be thrown away without a word.
    expect(store.dirty()).toBe(true);
  });

  it('notices an edit to Common, to a buffer, and to a file', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.setDocSource(commonPass(store.project()!)!.id, '#define PI 3.14');
    expect(store.dirty()).toBe(true);

    await store.save();
    expect(store.dirty()).toBe(false);

    store.addSourceFile('lib.glsl');
    expect(store.dirty()).toBe(true);
  });

  it('notices a channel rewiring, with no source change at all', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    await store.save();
    expect(store.dirty()).toBe(false);

    const a = store.buffers()[0];
    store.setChannel(imagePass(store.project()!).id, 0, {
      kind: 'buffer',
      passId: a.id,
      feedback: false,
    });

    expect(store.dirty()).toBe(true);
  });

  it('goes clean again on revert, throwing the buffer away', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    store.revert();

    expect(store.buffers()).toHaveLength(0);
    expect(store.dirty()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Surviving a reload
// ---------------------------------------------------------------------------

describe('across a reload', () => {
  it('restores the buffers, the files and the wiring of a saved project', async () => {
    const storage = new MemoryStorage();
    const record = makeRecord();

    {
      const { store } = setup(storage, record);
      await store.initialize();

      store.addBufferPass();
      const a = store.buffers()[0];
      store.setDocSource(a.id, 'BUFFER A SOURCE');
      store.setChannel(imagePass(store.project()!).id, 2, {
        kind: 'buffer',
        passId: a.id,
        feedback: true,
      });
      store.addSourceFile('lib.glsl');

      expect(await store.save()).toBe(true);
    }

    // A brand new store over the same storage, and a server holding the record
    // the save left behind. That is a reload.
    const { store } = setup(storage, {
      ...record,
      fragment: FRAGMENT,
      updatedAt: '2024-02-01T00:00:00.000Z',
    });
    await store.initialize();

    const buffers = store.buffers();
    expect(buffers).toHaveLength(1);
    expect(buffers[0].source).toBe('BUFFER A SOURCE');
    expect(buffers[0].slot).toBe('A');

    expect(imagePass(store.project()!).channels[2]).toEqual({
      kind: 'buffer',
      passId: buffers[0].id,
      feedback: true,
    });

    expect(store.project()!.files.map((file) => file.name)).toEqual(['lib.glsl']);
    // And it comes back *clean*: this is a saved project, not a recovered one.
    expect(store.dirty()).toBe(false);
  });

  it('forgets a project whose shader was deleted', async () => {
    const storage = new MemoryStorage();

    const { store } = setup(storage, makeRecord(), makeRecord({ id: 'other', name: 'Other' }));
    await store.initialize();

    store.addBufferPass();
    await store.save();
    expect(storage.getItem('shader-studio.projects')).toContain('waves');

    await store.remove('waves');

    expect(storage.getItem('shader-studio.projects')).not.toContain('waves');
  });

  it('lets the record win for the Image pass when the shader changed underneath it', async () => {
    // An import, a desktop sync, another tab. The stored project's Image source
    // is stale; the buffers around it are not, and throwing them away because the
    // fragment moved would lose far more than it protects.
    const storage = new MemoryStorage();
    const record = makeRecord();

    {
      const { store } = setup(storage, record);
      await store.initialize();
      store.addBufferPass();
      store.setDocSource(store.buffers()[0].id, 'PRECIOUS');
      await store.save();
    }

    const { store } = setup(storage, {
      ...record,
      fragment: 'REPLACED BY AN IMPORT',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    await store.initialize();

    expect(store.fragment()).toBe('REPLACED BY AN IMPORT');
    expect(store.buffers()[0].source).toBe('PRECIOUS');
  });
});

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

describe('editor documents', () => {
  it('lists the passes, then the files, then Vertex and Config', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    store.addSourceFile('lib.glsl');

    expect(store.documents().map((document) => document.name)).toEqual([
      'Image',
      'Common',
      'Buffer A',
      'lib.glsl',
      'Vertex',
      'Config',
    ]);
  });

  it('marks passes and files as different kinds, so the tab bar can too', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();
    store.addSourceFile('lib.glsl');

    const byName = new Map(store.documents().map((document) => [document.name, document]));

    expect(byName.get('Image')).toMatchObject({ kind: 'pass', passKind: 'image' });
    expect(byName.get('Common')).toMatchObject({ kind: 'pass', passKind: 'common' });
    expect(byName.get('lib.glsl')).toMatchObject({ kind: 'file' });
    expect(byName.get('Config')).toMatchObject({ kind: 'config', language: 'json' });
  });

  it('opens the Image pass, and writes through to whichever document is named', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    expect(store.activeDoc()?.name).toBe('Image');

    store.setDocSource(VERTEX_DOC, 'NEW VERTEX');
    expect(store.vertex()).toBe('NEW VERTEX');

    store.setDocSource(CONFIG_DOC, '[]');
    expect(store.draft()?.controlsText).toBe('[]');
    expect(store.controls()).toEqual([]);
  });

  it('falls back to the Image pass when the open document is deleted', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    const a = store.buffers()[0];
    expect(store.activeDocId()).toBe(a.id);

    store.removeBufferPass(a.id);

    // An editor showing nothing at all is a worse answer than one showing the
    // document that always exists.
    expect(store.activeDoc()?.passKind).toBe('image');
  });
});

// ---------------------------------------------------------------------------
// The graph, as the store sees it
// ---------------------------------------------------------------------------

describe('render order and errors', () => {
  it('reports a circular dependency as an error against the pass', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    store.addBufferPass();
    const [a, b] = store.buffers();

    store.setChannel(a.id, 0, { kind: 'buffer', passId: b.id, feedback: false });
    store.setChannel(b.id, 0, { kind: 'buffer', passId: a.id, feedback: false });

    expect(store.projectErrors()).toHaveLength(1);
    // It lands in the same list as a compile error, and on a tab, because it is
    // exactly as much a reason the shader is not doing what you asked.
    expect(store.hasErrors()).toBe(true);
    expect(store.errorCountFor(a.id) + store.errorCountFor(b.id)).toBe(1);
  });

  it('shows an error in Common once, not once per pass that includes it', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    const common = commonPass(store.project()!)!;

    // The driver compiles Common into every pass that uses it, so it reports the
    // same broken line once per pass. The user made one mistake.
    store.setCompileDiagnostics([
      { severity: 'error', line: 2, message: 'syntax error', source: 'fragment', docId: common.id },
      { severity: 'error', line: 2, message: 'syntax error', source: 'fragment', docId: common.id },
    ]);

    expect(store.allDiagnostics()).toHaveLength(1);
    expect(store.errorCountFor(common.id)).toBe(1);
  });

  it('accepts self-feedback and orders the buffer before the Image pass', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    store.addBufferPass();
    const a = store.buffers()[0];
    store.setChannel(a.id, 0, { kind: 'buffer', passId: a.id, feedback: true });

    expect(store.projectErrors()).toEqual([]);
    expect(store.renderOrder().map((pass) => pass.name)).toEqual(['Buffer A', 'Image']);
  });

  it('stops at four buffers and says so', async () => {
    const { store } = setup(new MemoryStorage(), makeRecord());
    await store.initialize();

    for (let n = 0; n < 4; n++) store.addBufferPass();
    expect(store.canAddBuffer()).toBe(false);

    store.addBufferPass();

    expect(store.buffers()).toHaveLength(4);
    expect(store.notice()?.text).toContain('All four buffer slots');
  });
});

// ---------------------------------------------------------------------------
// The storage layer on its own
// ---------------------------------------------------------------------------

describe('ProjectPersistence', () => {
  function persistence(storage: Storage): ProjectPersistence {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ProjectPersistence,
        { provide: PLATFORM_ID, useValue: 'browser' },
        { provide: DOCUMENT, useValue: documentWith(storage) },
      ],
    });
    return TestBed.inject(ProjectPersistence);
  }

  it('returns null for a shader it has never seen', () => {
    expect(persistence(new MemoryStorage()).load('waves', FRAGMENT, VERTEX)).toBeNull();
  });

  it('drops malformed storage instead of exposing it', () => {
    const storage = new MemoryStorage();
    storage.setItem('shader-studio.projects', '{broken');

    expect(persistence(storage).load('waves', FRAGMENT, VERTEX)).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('repairs a stored project rather than losing it', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'shader-studio.projects',
      JSON.stringify({
        version: 1,
        projects: {
          waves: {
            shaderId: 'waves',
            baselineUpdatedAt: 'then',
            // No Image pass, and a buffer with no slot: both recoverable.
            project: {
              version: 1,
              vertex: VERTEX,
              passes: [{ kind: 'buffer', id: 'b', name: 'B', source: 'x' }],
              files: [],
            },
          },
        },
      }),
    );

    const loaded = persistence(storage).load('waves', FRAGMENT, VERTEX)!;

    expect(imagePass(loaded.project).source).toBe(FRAGMENT);
    expect(bufferPasses(loaded.project)[0].slot).toBe('A');
  });

  it('warns once, and does not throw, when storage is full', () => {
    const storage = new MemoryStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    const store = persistence(storage);
    const warning = vi.fn();
    store.onWarning = warning;

    const project = migrateLegacyProject(FRAGMENT, VERTEX);

    // A full quota must never break the app — but the user is owed the one
    // warning, because what they silently lose is their buffers on next reload.
    expect(() => store.save('waves', 'now', project)).not.toThrow();
    store.save('waves', 'now', project);

    expect(warning).toHaveBeenCalledTimes(1);
  });
});
