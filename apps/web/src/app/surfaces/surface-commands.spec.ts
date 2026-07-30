import { describe, expect, it } from 'vitest';

import { createDefaultSurface } from '@shader-studio/shared/surfaces';

import { availableSurfaceCommands, describeSurfaceCommands } from './surface-commands';

describe('surface-commands', () => {
  it('filters commands by capability — preview has no close', () => {
    const preview = createDefaultSurface('preview');
    const ids = describeSurfaceCommands(preview).map((c) => c.id);
    expect(ids).not.toContain('close');
    expect(ids).toContain('showOnStage');
    expect(ids).toContain('float');
    expect(ids).not.toContain('dock');
  });

  it('lists dock sides for editor and marks the active side', () => {
    const editor = createDefaultSurface('editor', {
      placement: { host: 'contained', mode: 'docked', side: 'left', size: 360 },
    });
    const docks = describeSurfaceCommands(editor).filter((c) => c.id === 'dock');
    expect(docks.map((d) => d.dockSide)).toEqual(['bottom', 'left', 'right']);
    expect(docks.find((d) => d.dockSide === 'left')?.active).toBe(true);
  });

  it('keeps float and externalize distinct; externalize needs allowNative', () => {
    const editor = createDefaultSurface('editor', {
      placement: { host: 'contained', mode: 'docked', side: 'bottom', size: 300 },
    });

    const web = describeSurfaceCommands(editor, { allowNative: false });
    expect(web.find((c) => c.id === 'float')?.available).toBe(true);
    expect(web.find((c) => c.id === 'externalize')?.available).toBe(false);

    const desktop = describeSurfaceCommands(editor, { allowNative: true });
    expect(desktop.find((c) => c.id === 'externalize')?.available).toBe(true);
  });

  it('lists inspector float (phase 1) alongside its single dock side', () => {
    const inspector = createDefaultSurface('inspector');
    const commands = describeSurfaceCommands(inspector);
    const ids = commands.map((c) => c.id);
    expect(ids).toContain('float');
    expect(ids).toContain('dock');

    const docks = commands.filter((c) => c.id === 'dock');
    expect(docks.map((d) => d.dockSide)).toEqual(['right']);
  });

  it('availableSurfaceCommands drops inactive restore when not maximized', () => {
    const editor = createDefaultSurface('editor');
    const available = availableSurfaceCommands(editor).map((c) => c.id);
    expect(available).not.toContain('restore');
  });

  it('rejects close of last editor via remainingEditorGroups', () => {
    const editor = createDefaultSurface('editor');
    const last = describeSurfaceCommands(editor, { remainingEditorGroups: 0 });
    expect(last.find((c) => c.id === 'close')?.available).toBe(false);

    const ok = describeSurfaceCommands(editor, { remainingEditorGroups: 1 });
    expect(ok.find((c) => c.id === 'close')?.available).toBe(true);
  });
});
