import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  toSummary,
  type ShaderControl,
  type ShaderRecord,
  type ShaderSummary,
} from '@shader-studio/shared/model';
import { migrateLegacyProject } from '@shader-studio/shared/project';
import { ShaderApi, type UpdateShaderPatch } from '../../../api/shader-api';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../../../prefs/preferences';
import { CompilationService } from '../../compilation.service';
import { DocumentState } from '../../state/document-state';
import { RecoveryFacade } from '../recovery-facade';
import { SelectionLifecycle } from '../selection-lifecycle';

/**
 * Shared scaffolding for the lifecycle specs.
 *
 * Not a spec file itself: `SelectionLifecycle` and `RecoveryFacade` are two
 * halves of one story — selecting a shader is what looks for a recovered draft —
 * and testing either of them needs the same fake server, the same fake
 * preferences and the same stand-in for `localStorage`.
 */

export const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
export const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

const CONTROLS: ShaderControl[] = [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }];

export function makeRecord(overrides: Partial<ShaderRecord> = {}): ShaderRecord {
  return {
    id: 'waves',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: structuredClone(CONTROLS),
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    project: migrateLegacyProject(FRAGMENT, VERTEX),
    ...overrides,
  };
}

export class MemoryStorage implements Storage {
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
 * The real document with only `localStorage` swapped out — the same trick
 * `project-workspace.spec` uses, and for the same reason: enough of Angular is
 * pulled in that the document has to be a real one.
 */
export function documentWith(storage: Storage): Document {
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

/**
 * A server whose reads answer only when the test says so.
 *
 * This is the whole point of the race spec: a real `read` takes time, two of
 * them can be in the air at once, and nothing guarantees they come back in the
 * order they were asked for.
 */
export class DeferredApi implements Partial<ShaderApi> {
  readonly records = new Map<string, ShaderRecord>();
  readonly reads: string[] = [];
  readonly updates: { id: string; patch: UpdateShaderPatch }[] = [];

  /** Reads waiting for `settle`, by shader id. */
  private readonly waiting = new Map<string, (() => void)[]>();

  /** When set, `read` rejects with this instead of answering. */
  readonly failures = new Map<string, Error>();

  /** When true, `update` never settles — for testing duplicate suppression. */
  stallUpdates = false;

  /** When set, the next `update` rejects with it. */
  failNextUpdate: Error | null = null;

  constructor(...records: ShaderRecord[]) {
    for (const record of records) this.records.set(record.id, record);
  }

  list(): Promise<ShaderSummary[]> {
    return Promise.resolve([...this.records.values()].map(toSummary));
  }

  read(id: string): Promise<ShaderRecord> {
    this.reads.push(id);
    return new Promise<ShaderRecord>((resolve, reject) => {
      const queue = this.waiting.get(id) ?? [];
      queue.push(() => {
        const failure = this.failures.get(id);
        if (failure) {
          this.failures.delete(id);
          reject(failure);
          return;
        }
        const record = this.records.get(id);
        if (record) resolve(structuredClone(record));
        else reject(new Error(`No such shader ${id}`));
      });
      this.waiting.set(id, queue);
    });
  }

  update(id: string, patch: UpdateShaderPatch): Promise<ShaderRecord> {
    this.updates.push({ id, patch });
    if (this.stallUpdates) return new Promise<ShaderRecord>(() => undefined);
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = null;
      return Promise.reject(error);
    }

    const current = this.records.get(id)!;
    const updated: ShaderRecord = {
      ...current,
      ...(patch.project === undefined ? {} : { project: patch.project }),
      updatedAt: '2024-02-02T00:00:00.000Z',
    };
    this.records.set(id, updated);
    return Promise.resolve(structuredClone(updated));
  }

  /** Let every read outstanding for `id` answer. */
  settle(id: string): void {
    const queue = this.waiting.get(id) ?? [];
    this.waiting.set(id, []);
    for (const answer of queue) answer();
  }
}

export class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>(createDefaultWorkspacePreferences());

  readonly value = this.state.asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

export interface LifecycleHarness {
  selection: SelectionLifecycle;
  recovery: RecoveryFacade;
  state: DocumentState;
  compilation: CompilationService;
  api: DeferredApi;
  preferences: FakePreferences;
  storage: MemoryStorage;
}

export function setupLifecycle(
  storage: MemoryStorage,
  ...records: ShaderRecord[]
): LifecycleHarness {
  TestBed.resetTestingModule();

  const api = new DeferredApi(...records);
  const preferences = new FakePreferences();

  TestBed.configureTestingModule({
    providers: [
      { provide: ShaderApi, useValue: api },
      { provide: Preferences, useValue: preferences },
      { provide: PLATFORM_ID, useValue: 'browser' },
      { provide: DOCUMENT, useValue: documentWith(storage) },
    ],
  });

  return {
    selection: TestBed.inject(SelectionLifecycle),
    recovery: TestBed.inject(RecoveryFacade),
    state: TestBed.inject(DocumentState),
    compilation: TestBed.inject(CompilationService),
    api,
    preferences,
    storage,
  };
}

/** Let the microtask queue — and any fire-and-forget promise chain — drain. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
