import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DOC, VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import {
  addBuffer,
  addFile,
  bufferPasses,
  imagePass,
  migrateLegacyProject,
  type ShaderProject,
} from '@shader-studio/shared/project';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { EditorGroupSession } from './editor-group-session';
import { EditorGroups } from './editor-groups';
import { OpenDocuments } from './open-documents';
import { openIdsFor } from './open-documents-state';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function toDocuments(project: ShaderProject): EditorDocument[] {
  return [
    ...project.passes.map(
      (pass): EditorDocument => ({
        id: pass.id,
        kind: 'pass',
        name: pass.name,
        language: 'glsl',
        source: pass.source,
        passKind: pass.kind,
        slot: pass.slot,
        enabled: pass.enabled,
      }),
    ),
    ...project.files.map(
      (file): EditorDocument => ({
        id: file.id,
        kind: 'file',
        name: file.name,
        language: 'glsl',
        source: file.source,
      }),
    ),
    { id: VERTEX_DOC, kind: 'vertex', name: 'Vertex', language: 'glsl', source: project.vertex },
    { id: CONFIG_DOC, kind: 'config', name: 'Config', language: 'json', source: '{}' },
  ];
}

/**
 * Lightweight store stand-in: open-tab sync only needs selectedId, documents,
 * activeDoc, and selectDoc.
 */
class TabStore {
  private readonly initial = migrateLegacyProject(FRAGMENT, VERTEX);

  readonly selectedId = signal<string | null>('waves');
  readonly documentsState = signal<readonly EditorDocument[]>(toDocuments(this.initial));
  readonly activeId = signal<string | null>(imagePass(this.initial).id);

  readonly documents = this.documentsState.asReadonly();
  readonly activeDoc = computed(
    () =>
      this.documentsState().find((doc) => doc.id === this.activeId()) ??
      this.documentsState()[0] ??
      null,
  );

  asShaderStore(): ShaderStore {
    return {
      selectedId: this.selectedId.asReadonly(),
      documents: this.documents,
      activeDoc: this.activeDoc,
      selectDoc: (id: string) => this.activeId.set(id),
    } as unknown as ShaderStore;
  }

  setProject(project: ShaderProject): void {
    this.documentsState.set(toDocuments(project));
    const active = this.activeId();
    if (!this.documentsState().some((doc) => doc.id === active)) {
      this.activeId.set(imagePass(project).id);
    }
  }

  switchShader(shaderId: string, project: ShaderProject): void {
    this.selectedId.set(shaderId);
    this.documentsState.set(toDocuments(project));
    this.activeId.set(imagePass(project).id);
  }
}

describe('OpenDocuments service', () => {
  let tabs: TabStore;
  let openDocs: OpenDocuments;

  beforeEach(() => {
    tabs = new TabStore();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: tabs.asShaderStore() },
        EditorGroupSession,
        EditorGroups,
        OpenDocuments,
      ],
    });
    openDocs = TestBed.inject(OpenDocuments);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('opens only the active document when a project is first shown', () => {
    expect(openDocs.openIds()).toEqual([tabs.activeId()]);
    expect(openDocs.openDocs()).toHaveLength(1);
    expect(openDocs.openDocs()[0]?.passKind).toBe('image');
  });

  it('opens and activates a selection without duplicating', () => {
    const imageId = tabs.activeId()!;
    openDocs.activate(VERTEX_DOC);
    TestBed.tick();
    expect(tabs.activeId()).toBe(VERTEX_DOC);
    expect(openDocs.openIds()).toEqual([imageId, VERTEX_DOC]);

    openDocs.activate(VERTEX_DOC);
    TestBed.tick();
    expect(openDocs.openIds()).toEqual([imageId, VERTEX_DOC]);
  });

  it('closes inactive and active tabs with a deterministic neighbor', () => {
    const imageId = tabs.activeId()!;
    openDocs.activate(VERTEX_DOC);
    openDocs.activate(CONFIG_DOC);
    TestBed.tick();

    expect(openDocs.close(VERTEX_DOC)).toBe(true);
    expect(openDocs.openIds()).toEqual([imageId, CONFIG_DOC]);
    expect(tabs.activeId()).toBe(CONFIG_DOC);

    expect(openDocs.close(CONFIG_DOC)).toBe(true);
    expect(openDocs.openIds()).toEqual([imageId]);
    expect(tabs.activeId()).toBe(imageId);
  });

  it('refuses to close the last tab', () => {
    const imageId = tabs.activeId()!;
    expect(openDocs.canClose()).toBe(false);
    expect(openDocs.close(imageId)).toBe(false);
    expect(openDocs.openIds()).toEqual([imageId]);
  });

  it('isolates open sets when switching shaders', () => {
    openDocs.activate(VERTEX_DOC);
    TestBed.tick();

    const projectB = migrateLegacyProject(FRAGMENT, VERTEX);
    tabs.switchShader('plasma', projectB);
    TestBed.tick();

    const imageB = imagePass(projectB).id;
    expect(openDocs.openIds()).toEqual([imageB]);
    expect(openIdsFor(openDocs.peekState(), 'waves')).toContain(VERTEX_DOC);
    expect(openIdsFor(openDocs.peekState(), 'plasma')).toEqual([imageB]);
  });

  it('removes stale tabs when a buffer is deleted', () => {
    let project = migrateLegacyProject(FRAGMENT, VERTEX);
    project = addBuffer(project);
    const bufferId = bufferPasses(project)[0]!.id;
    tabs.setProject(project);
    openDocs.activate(bufferId);
    TestBed.tick();
    expect(openDocs.openIds()).toContain(bufferId);

    tabs.setProject(migrateLegacyProject(FRAGMENT, VERTEX));
    TestBed.tick();
    expect(openDocs.openIds()).not.toContain(bufferId);
  });

  it('keeps the same tab id after rename so the label updates in place', () => {
    let project = migrateLegacyProject(FRAGMENT, VERTEX);
    project = addFile(project, 'noise.glsl');
    const fileId = project.files[0]!.id;
    tabs.setProject(project);
    openDocs.activate(fileId);
    TestBed.tick();

    tabs.setProject({
      ...project,
      files: project.files.map((file) =>
        file.id === fileId ? { ...file, name: 'util.glsl' } : file,
      ),
    });
    TestBed.tick();

    expect(openDocs.openIds()).toContain(fileId);
    expect(openDocs.openDocs().find((doc) => doc.id === fileId)?.name).toBe('util.glsl');
  });

  it('reorders open tabs only', () => {
    const imageId = tabs.activeId()!;
    openDocs.activate(VERTEX_DOC);
    openDocs.activate(CONFIG_DOC);
    TestBed.tick();

    openDocs.reorder(CONFIG_DOC, imageId);
    expect(openDocs.openIds()).toEqual([CONFIG_DOC, imageId, VERTEX_DOC]);
  });

  it('closeOthers leaves a single tab and activates it', () => {
    openDocs.activate(VERTEX_DOC);
    openDocs.activate(CONFIG_DOC);
    TestBed.tick();

    openDocs.closeOthers(VERTEX_DOC);
    TestBed.tick();
    expect(openDocs.openIds()).toEqual([VERTEX_DOC]);
    expect(tabs.activeId()).toBe(VERTEX_DOC);
  });

  it('cycles among open tabs only', () => {
    const imageId = tabs.activeId()!;
    openDocs.activate(VERTEX_DOC);
    TestBed.tick();
    expect(tabs.activeId()).toBe(VERTEX_DOC);

    openDocs.cycle(1);
    expect(tabs.activeId()).toBe(imageId);
    openDocs.cycle(1);
    expect(tabs.activeId()).toBe(VERTEX_DOC);
    openDocs.cycle(-1);
    expect(tabs.activeId()).toBe(imageId);
  });

  it('treats navigation-style activation like explorer selection', () => {
    const imageId = tabs.activeId()!;
    // Same path Problems / EditorNavigation use once the panel resolves a target.
    openDocs.activate(CONFIG_DOC);
    TestBed.tick();
    expect(openDocs.openIds()).toEqual([imageId, CONFIG_DOC]);
    expect(tabs.activeId()).toBe(CONFIG_DOC);
  });
});
