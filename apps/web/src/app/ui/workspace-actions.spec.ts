import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type ShaderRecord,
} from '@shader-studio/shared/model';
import { migrateLegacyProject } from '@shader-studio/shared/project';
import { ShaderApi } from '../api/shader-api';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { DesktopUpdater } from '../desktop/desktop-updater';
import { I18n } from '../i18n/i18n';
import { Preferences, createDefaultWorkspacePreferences, type WorkspacePreferences } from '../prefs/preferences';
import { ShaderStore } from '../workspace/shader-store';
import { OpenDocuments } from './editor/open-documents';
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
  private readonly state = signal<WorkspacePreferences>(createDefaultWorkspacePreferences());

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
          provide: DesktopUpdater,
          useValue: {
            check: vi.fn(),
            state: signal({ status: 'unavailable', currentVersion: '' }),
          },
        },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: {
            open: () => ({ afterClosed: () => of(undefined) }),
            getDialogById: () => undefined,
          },
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

describe('WorkspaceActions Help flows', () => {
  const check = vi.fn(async () => undefined);
  const open = vi.fn();
  const getDialogById = vi.fn((_id?: string) => undefined as { id: string } | undefined);
  let actions: WorkspaceActions;

  beforeEach(() => {
    TestBed.resetTestingModule();
    check.mockReset();
    open.mockReset();
    getDialogById.mockReset();
    getDialogById.mockReturnValue(undefined);

    TestBed.configureTestingModule({
      providers: [
        WorkspaceActions,
        { provide: ShaderStore, useValue: {} },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: true } },
        {
          provide: DesktopUpdater,
          useValue: { check, state: signal({ status: 'idle', currentVersion: '1.0.0' }) },
        },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: { open, getDialogById },
        },
        { provide: ShaderApi, useValue: new FakeApi() },
        { provide: OpenDocuments, useValue: { openIds: () => [], activate: () => undefined } },
      ],
    });

    actions = TestBed.inject(WorkspaceActions);
  });

  it('openKeyboardShortcuts dynamically opens the shortcuts dialog once', async () => {
    await actions.openKeyboardShortcuts();
    expect(open).toHaveBeenCalledOnce();
    const [component, config] = open.mock.calls[0]!;
    expect(String(component.name)).toContain('KeyboardShortcutsDialog');
    expect(config).toMatchObject({ id: 'keyboard-shortcuts', width: '520px' });

    getDialogById.mockReturnValue({ id: 'keyboard-shortcuts' });
    await actions.openKeyboardShortcuts();
    expect(open).toHaveBeenCalledOnce();
  });

  it('openAboutShaderStudio opens About without checking for updates', async () => {
    await actions.openAboutShaderStudio();
    expect(check).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    const [component, config] = open.mock.calls[0]!;
    expect(String(component.name)).toMatch(/DesktopVersionDialog|AboutShaderStudioDialog/);
    expect(config).toMatchObject({ id: 'about-shader-studio', width: '480px' });
  });

  it('checkForUpdates forces a check then opens About without stacking', async () => {
    await actions.checkForUpdates();
    expect(check).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();

    getDialogById.mockImplementation((id?: string) =>
      id === 'about-shader-studio' ? { id } : undefined,
    );
    await actions.checkForUpdates();
    expect(check).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
  });

  it('checkForUpdates propagates updater errors without opening a dialog', async () => {
    check.mockRejectedValueOnce(new Error('network down'));
    await expect(actions.checkForUpdates()).rejects.toThrow('network down');
    expect(open).not.toHaveBeenCalled();
  });

  it('openDesktopVersion aliases About without a forced check', async () => {
    await actions.openDesktopVersion();
    expect(check).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
  });
});
