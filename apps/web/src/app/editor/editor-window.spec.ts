import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_WINDOW, type EditorWindowState } from '@shader-studio/shared/editor-prefs';
import { Preferences, type WorkspacePreferences } from '../prefs/preferences';
import { EditorWindow, FLOATING_MIN_VIEWPORT } from './editor-window';

/**
 * Characterization of the editor placement machine at the native-surfaces
 * start commit. Agents must preserve these restore, compact, geometry, and
 * open/close rules when migrating to the shared surface domain.
 */

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<Partial<WorkspacePreferences>>({
    editorOpen: true,
    editorWindow: DEFAULT_EDITOR_WINDOW,
  });

  readonly value = this.state.asReadonly() as Preferences['value'];

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

describe('EditorWindow', () => {
  let editor: EditorWindow;
  let preferences: FakePreferences;

  const viewport = { width: 1200, height: 800 };

  beforeEach(() => {
    preferences = new FakePreferences();
    TestBed.configureTestingModule({
      providers: [EditorWindow, { provide: Preferences, useValue: preferences }],
    });
    editor = TestBed.inject(EditorWindow);
    editor.setViewport(viewport);
  });

  const state = (): EditorWindowState => editor.state();

  it('starts docked and open by default in this fixture', () => {
    expect(editor.docked()).toBe(true);
    expect(editor.open()).toBe(true);
  });

  describe('modes', () => {
    it('detaches into a floating window (contained float, not native)', () => {
      editor.detach();

      expect(editor.floating()).toBe(true);
      expect(state().restoreMode).toBe('floating');
    });

    it('docks to a chosen side and records docked as the restore point', () => {
      editor.detach();
      editor.dock('left');

      expect(editor.docked()).toBe(true);
      expect(state().dockSide).toBe('left');
      expect(state().restoreMode).toBe('docked');
    });

    it('restores a maximized floating editor back to floating', () => {
      editor.detach();
      editor.maximize();
      expect(editor.maximized()).toBe(true);

      editor.restore();
      expect(editor.floating()).toBe(true);
    });

    it('restores a window maximized from docked back to docked', () => {
      editor.dock('bottom');
      editor.maximize();
      editor.restore();

      expect(editor.docked()).toBe(true);
      expect(state().restoreMode).toBe('docked');
    });

    it('keeps the original restore point across maximize then minimize', () => {
      editor.detach();
      editor.maximize();
      editor.minimize();

      expect(state().restoreMode).toBe('floating');

      editor.restore();
      expect(editor.floating()).toBe(true);
    });

    it('does not re-record the restore point when maximizing twice', () => {
      editor.detach();
      editor.maximize();
      editor.maximize();

      expect(state().restoreMode).toBe('floating');
    });

    it('toggles maximize and minimize back to where they came from', () => {
      editor.detach();
      editor.toggleMaximized();
      expect(editor.maximized()).toBe(true);
      editor.toggleMaximized();
      expect(editor.floating()).toBe(true);

      editor.toggleMinimized();
      expect(editor.minimized()).toBe(true);
      editor.toggleMinimized();
      expect(editor.floating()).toBe(true);
    });
  });

  describe('compact viewport', () => {
    it('renders floating as docked without rewriting the stored mode', () => {
      editor.detach();
      expect(state().mode).toBe('floating');

      editor.setViewport({ width: FLOATING_MIN_VIEWPORT - 1, height: 800 });

      expect(editor.compact()).toBe(true);
      expect(editor.mode()).toBe('docked');
      expect(editor.dockSide()).toBe('bottom');
      expect(state().mode).toBe('floating');
      expect(state().dockSide).toBe('bottom');
    });

    it('returns to the stored floating mode when the viewport widens again', () => {
      editor.detach();
      editor.setViewport({ width: FLOATING_MIN_VIEWPORT - 1, height: 800 });
      expect(editor.mode()).toBe('docked');

      editor.setViewport(viewport);
      expect(editor.mode()).toBe('floating');
    });

    it('falls back a stored left dock to bottom while compact, keeping the side', () => {
      editor.dock('left');
      editor.setViewport({ width: FLOATING_MIN_VIEWPORT - 1, height: 800 });

      expect(editor.dockSide()).toBe('bottom');
      expect(state().dockSide).toBe('left');
    });
  });

  describe('geometry', () => {
    it('clamps a floating rect to the workspace', () => {
      editor.setFloatingRect({ x: 5000, y: 5000, width: 600, height: 400 });

      expect(editor.floatingRect()).toEqual({ x: 600, y: 400, width: 600, height: 400 });
    });

    it('recovers a window saved against a screen that no longer exists', () => {
      preferences.patch({
        editorWindow: {
          ...DEFAULT_EDITOR_WINDOW,
          mode: 'floating',
          restoreMode: 'floating',
          floating: { x: 3200, y: 1800, width: 1600, height: 1200 },
        },
      });
      editor.setViewport({ width: 900, height: 600 });

      expect(editor.floatingRect()).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    it('leaves the stored floating rect alone when only the rendered rect is clamped', () => {
      preferences.patch({
        editorWindow: {
          ...DEFAULT_EDITOR_WINDOW,
          mode: 'floating',
          restoreMode: 'floating',
          floating: { x: 100, y: 100, width: 1000, height: 700 },
        },
      });

      editor.setViewport({ width: 400, height: 300 });
      expect(editor.floatingRect()).toEqual({ x: 0, y: 0, width: 400, height: 300 });

      editor.setViewport(viewport);
      expect(editor.floatingRect()).toEqual({ x: 100, y: 100, width: 1000, height: 700 });
    });

    it('caps docked height and width to three quarters of the viewport', () => {
      editor.setDockedHeight(10_000);
      editor.setDockedWidth(10_000);

      expect(editor.dockedHeight()).toBe(Math.round(viewport.height * 0.75));
      expect(editor.dockedWidth()).toBe(Math.round(viewport.width * 0.75));
    });

    it('resets geometry without changing mode', () => {
      editor.detach();
      editor.maximize();
      editor.setFloatingRect({ x: 0, y: 0, width: 400, height: 240 });

      editor.resetGeometry();

      expect(editor.maximized()).toBe(true);
      expect(state().floating).toEqual(
        expect.objectContaining({
          width: DEFAULT_EDITOR_WINDOW.floating.width,
          height: DEFAULT_EDITOR_WINDOW.floating.height,
        }),
      );
    });
  });

  describe('open and close', () => {
    it('closes by flipping editorOpen without rewriting window placement', () => {
      editor.detach();
      const before = structuredClone(state());

      editor.close();

      expect(editor.open()).toBe(false);
      expect(preferences.value().editorOpen).toBe(false);
      expect(state()).toEqual(before);
    });

    it('openEditor restores from minimized so the editor is visible', () => {
      editor.detach();
      editor.minimize();
      editor.close();

      editor.openEditor();

      expect(editor.open()).toBe(true);
      expect(editor.floating()).toBe(true);
      expect(editor.minimized()).toBe(false);
    });

    it('toggleOpen only toggles visibility', () => {
      editor.toggleOpen();
      expect(editor.open()).toBe(false);
      editor.toggleOpen();
      expect(editor.open()).toBe(true);
    });
  });
});
