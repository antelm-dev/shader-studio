import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import {
  DEFAULT_CAPTURE,
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderRecord,
} from '@shader-studio/shared/model';
import { migrateLegacyProject } from '@shader-studio/shared/project';
import { ShaderApi } from '../api/shader-api';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_WINDOW,
} from '@shader-studio/shared/editor-prefs';
import {
  DEFAULT_FILE_EXPLORER_OPEN,
  DEFAULT_FILE_EXPLORER_VIEW,
  DEFAULT_FILE_EXPLORER_WIDTH,
  DEFAULT_PANEL_WIDTHS,
} from '@shader-studio/shared/panel-prefs';
import { DEFAULT_PREVIEW_WINDOW } from '@shader-studio/shared/preview-prefs';
import { ShaderStore } from '../workspace/shader-store';
import { WorkspaceActions } from './workspace-actions';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function makeRecord(): ShaderRecord {
  return {
    id: 'waves',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }],
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    project: migrateLegacyProject(FRAGMENT, VERTEX),
  };
}

class FakeApi implements Partial<ShaderApi> {
  private readonly record = makeRecord();

  list = () =>
    Promise.resolve([
      {
        id: this.record.id,
        name: this.record.name,
        description: this.record.description,
        controlCount: this.record.controls.length,
        presetCount: 0,
        thumbnail: null,
        updatedAt: this.record.updatedAt,
      },
    ]);

  read = () => Promise.resolve(structuredClone(this.record));
}

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>({
    language: 'en',
    lastShaderId: null,
    shadertoyApiKey: null,
    browserOpen: true,
    editorOpen: false,
    guiVisible: true,
    browserWidth: DEFAULT_PANEL_WIDTHS.browser,
    inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
    inspectorTab: 'controls',
    bottomPanelOpen: false,
    bottomPanelHeight: 220,
    bottomPanelTab: 'problems',
    fileExplorerOpen: DEFAULT_FILE_EXPLORER_OPEN,
    fileExplorerView: DEFAULT_FILE_EXPLORER_VIEW,
    fileExplorerWidth: DEFAULT_FILE_EXPLORER_WIDTH,
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

describe('WorkspaceActions explorer adapters', () => {
  let actions: WorkspaceActions;
  let store: ShaderStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        WorkspaceActions,
        ShaderStore,
        { provide: ShaderApi, useValue: new FakeApi() },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: { open: () => ({ afterClosed: () => of(undefined) }) },
        },
      ],
    });

    store = TestBed.inject(ShaderStore);
    actions = TestBed.inject(WorkspaceActions);
    await store.initialize();
  });

  it('selectDocument activates a document tab', () => {
    actions.selectDocument('@vertex');
    expect(store.activeDoc()?.id).toBe('@vertex');
  });

  it('reorderExplorer moves a source file within the file list', () => {
    store.addSourceFile('a.glsl');
    store.addSourceFile('b.glsl');
    const files = store.project()!.files;
    actions.reorderExplorer({
      sourceDocId: files[1].id,
      targetDocId: files[0].id,
      list: 'file',
    });
    expect(store.project()!.files.map((file) => file.name)).toEqual(['b.glsl', 'a.glsl']);
  });

  it('reorderExplorer moves a buffer within the buffer list', async () => {
    store.addBufferPass();
    store.addBufferPass();
    const buffers = store.buffers();
    actions.reorderExplorer({
      sourceDocId: buffers[1].id,
      targetDocId: buffers[0].id,
      list: 'buffer',
    });
    expect(store.buffers().map((pass) => pass.id)).toEqual([buffers[1].id, buffers[0].id]);
  });

  it('duplicateDocument copies a source file', () => {
    store.addSourceFile('lib.glsl');
    const file = store.documents().find((doc) => doc.kind === 'file');
    expect(file).toBeDefined();
    actions.duplicateDocument(file!);
    expect(store.project()!.files.length).toBe(2);
  });
});
