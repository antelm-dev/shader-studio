import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { VERTEX_DOC } from '@shader-studio/shared/diagnostic';
import { openIdsForGroup } from '@shader-studio/shared/editor-groups';
import { imagePass, migrateLegacyProject } from '@shader-studio/shared/project';
import { DEFAULT_EDITOR_GROUP_ID } from '@shader-studio/shared/surfaces';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { EditorGroupSession } from './editor-group-session';
import { EditorGroups } from './editor-groups';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

class TabStore {
  private readonly initial = migrateLegacyProject(FRAGMENT, VERTEX);

  readonly selectedId = signal<string | null>('waves');
  readonly documentsState = signal<readonly EditorDocument[]>(
    this.initial.passes
      .filter((pass) => pass.kind === 'image')
      .map((pass) => ({
        id: pass.id,
        kind: 'pass' as const,
        name: pass.name,
        language: 'glsl' as const,
        source: pass.source,
        passKind: pass.kind,
        slot: pass.slot,
        enabled: pass.enabled,
      })),
  );
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
}

describe('EditorGroups service', () => {
  let tabs: TabStore;
  let groups: EditorGroups;

  beforeEach(() => {
    tabs = new TabStore();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: tabs.asShaderStore() },
        EditorGroupSession,
        EditorGroups,
      ],
    });
    groups = TestBed.inject(EditorGroups);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('creates a secondary group and moves a tab into it', () => {
    const imageId = tabs.activeId()!;
    groups.activate(VERTEX_DOC);
    TestBed.tick();

    const groupB = groups.createGroup({ activate: true });
    expect(groupB).toBeTruthy();
    expect(groups.moveDocument(VERTEX_DOC, groupB!, { sourceGroupId: DEFAULT_EDITOR_GROUP_ID })).toBe(
      true,
    );
    TestBed.tick();

    expect(groups.openIds(DEFAULT_EDITOR_GROUP_ID)).toEqual([imageId]);
    expect(groups.openIds(groupB!)).toEqual([VERTEX_DOC]);
    expect(groups.ownerGroupId(VERTEX_DOC)).toBe(groupB);
  });

  it('merges a closed group back into the primary group', () => {
    const groupB = groups.createGroup();
    expect(groupB).toBeTruthy();
    groups.activate(VERTEX_DOC);
    groups.moveDocument(VERTEX_DOC, groupB!, { sourceGroupId: DEFAULT_EDITOR_GROUP_ID });
    TestBed.tick();

    expect(groups.closeGroup(groupB!)).toBe(true);
    TestBed.tick();
    expect(groups.groupIds()).toEqual([DEFAULT_EDITOR_GROUP_ID]);
    expect(openIdsForGroup(groups.peekState(), 'waves', DEFAULT_EDITOR_GROUP_ID)).toContain(VERTEX_DOC);
  });

  it('rejects closing the sole editor group', () => {
    expect(groups.closeGroup(DEFAULT_EDITOR_GROUP_ID)).toBe(false);
  });
});
