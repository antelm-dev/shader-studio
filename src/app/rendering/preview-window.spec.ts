import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { Preferences, type WorkspacePreferences } from '../core/preferences';
import {
  DEFAULT_PREVIEW_WINDOW,
  type PreviewWindowState,
} from '@shader-studio/shared/preview-prefs';
import { PreviewWindow } from './preview-window';

/**
 * The transitions, which are the part of a window model that is easy to get
 * subtly wrong: "maximize, then restore" has to land you back where you came
 * from, and a preview that ends up somewhere nobody asked for is a preview the
 * user has to go and find.
 */

/** Only the two members `PreviewWindow` actually uses. */
class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<Partial<WorkspacePreferences>>({
    previewWindow: DEFAULT_PREVIEW_WINDOW,
  });

  readonly value = this.state.asReadonly() as Preferences['value'];

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

describe('PreviewWindow', () => {
  let preview: PreviewWindow;
  let preferences: FakePreferences;

  /** A workspace with room for anything the tests ask for. */
  const workspace = { x: 0, y: 44, width: 1200, height: 800 };

  beforeEach(() => {
    preferences = new FakePreferences();
    TestBed.configureTestingModule({
      providers: [PreviewWindow, { provide: Preferences, useValue: preferences }],
    });
    preview = TestBed.inject(PreviewWindow);
    preview.setWorkspace(workspace);
  });

  const state = (): PreviewWindowState => preview.state();

  it('starts on the stage, which is what the app looks like out of the box', () => {
    expect(preview.onStage()).toBe(true);
    expect(preview.windowed()).toBe(false);
  });

  describe('modes', () => {
    it('detaches into a floating window', () => {
      preview.detach();

      expect(preview.floating()).toBe(true);
      expect(preview.windowed()).toBe(true);
      expect(state().restoreMode).toBe('floating');
    });

    it('returns to the stage', () => {
      preview.detach();
      preview.showOnStage();

      expect(preview.onStage()).toBe(true);
      expect(state().restoreMode).toBe('stage');
    });

    it('toggles between the stage and a window', () => {
      preview.toggleDetached();
      expect(preview.floating()).toBe(true);

      preview.toggleDetached();
      expect(preview.onStage()).toBe(true);
    });

    it('restores a maximized window to the floating one it came from', () => {
      preview.detach();
      preview.maximize();
      expect(preview.maximized()).toBe(true);

      preview.restore();
      expect(preview.floating()).toBe(true);
    });

    it('restores a window maximized from the stage back to the stage', () => {
      preview.maximize();
      preview.restore();

      expect(preview.onStage()).toBe(true);
    });

    it('restores a minimized window to the floating one it came from', () => {
      preview.detach();
      preview.minimize();
      expect(preview.minimized()).toBe(true);

      preview.restore();
      expect(preview.floating()).toBe(true);
    });

    /**
     * The one that is easy to get wrong. Minimizing a *maximized* window must
     * not record "maximized" as the place to go back to, or restoring lands in a
     * third state nobody chose — and it must not forget the floating window
     * underneath either.
     */
    it('keeps the original restore point across maximize then minimize', () => {
      preview.detach();
      preview.maximize();
      preview.minimize();

      expect(state().restoreMode).toBe('floating');

      preview.restore();
      expect(preview.floating()).toBe(true);
    });

    it('does not re-record the restore point when maximizing twice', () => {
      preview.detach();
      preview.maximize();
      preview.maximize();

      expect(state().restoreMode).toBe('floating');
    });

    it('toggles maximize off, back to where it came from', () => {
      preview.detach();
      preview.toggleMaximized();
      expect(preview.maximized()).toBe(true);

      preview.toggleMaximized();
      expect(preview.floating()).toBe(true);
    });

    it('toggles minimize off, back to where it came from', () => {
      preview.detach();
      preview.toggleMinimized();
      expect(preview.minimized()).toBe(true);

      preview.toggleMinimized();
      expect(preview.floating()).toBe(true);
    });
  });

  describe('geometry', () => {
    it('clamps a rect it is given to the workspace', () => {
      preview.setFloatingRect({ x: 5000, y: 5000, width: 600, height: 400 });

      expect(preview.floatingRect()).toEqual({ x: 600, y: 400, width: 600, height: 400 });
    });

    it('sanitizes a rect a broken gesture turned inside out', () => {
      preview.setFloatingRect({ x: 10, y: 10, width: -300, height: -200 });

      const rect = preview.floatingRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    });

    it('recovers a window saved against a screen that no longer exists', () => {
      // Persisted on a 4K monitor; opened on a laptop.
      preferences.patch({
        previewWindow: {
          ...DEFAULT_PREVIEW_WINDOW,
          mode: 'floating',
          floating: { x: 3200, y: 1800, width: 1600, height: 1200 },
        },
      });
      preview.setWorkspace({ x: 0, y: 44, width: 900, height: 600 });

      const rect = preview.floatingRect();
      expect(rect).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    });

    it('brings the collapsed bar back on screen when the workspace shrinks', () => {
      preview.setMinimizedPoint({ x: 1000, y: 700 });
      preview.setWorkspace({ x: 0, y: 44, width: 400, height: 300 });

      const point = preview.minimizedPoint();
      expect(point.x).toBeLessThanOrEqual(400);
      expect(point.y).toBeLessThanOrEqual(300);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
    });

    it('leaves the stored rect alone: only what is rendered is clamped', () => {
      // Rotating a tablet back, or dragging the window wider, has to give you the
      // window you had — not the one a narrow moment clamped it to.
      preferences.patch({
        previewWindow: {
          ...DEFAULT_PREVIEW_WINDOW,
          floating: { x: 100, y: 100, width: 1000, height: 700 },
        },
      });

      preview.setWorkspace({ x: 0, y: 44, width: 400, height: 300 });
      expect(preview.floatingRect()).toEqual({ x: 0, y: 0, width: 400, height: 300 });

      preview.setWorkspace(workspace);
      expect(preview.floatingRect()).toEqual({ x: 100, y: 100, width: 1000, height: 700 });
    });

    it('reports the rect unclamped before the stage has been measured', () => {
      TestBed.resetTestingModule();
      const fresh = new FakePreferences();
      TestBed.configureTestingModule({
        providers: [PreviewWindow, { provide: Preferences, useValue: fresh }],
      });
      const unmeasured = TestBed.inject(PreviewWindow);

      expect(unmeasured.floatingRect()).toEqual(DEFAULT_PREVIEW_WINDOW.floating);
    });
  });

  describe('reset', () => {
    it('centres the window in the workspace there is now', () => {
      preview.detach();
      preview.setFloatingRect({ x: 0, y: 0, width: 300, height: 220 });

      preview.resetGeometry();

      const rect = preview.floatingRect();
      expect(rect.x).toBe(Math.round((workspace.width - rect.width) / 2));
      expect(rect.y).toBe(Math.round((workspace.height - rect.height) / 2));
      expect(rect.width).toBeGreaterThan(300);
    });

    it('leaves the mode alone: resetting is about where, not what', () => {
      preview.detach();
      preview.maximize();

      preview.resetGeometry();

      expect(preview.maximized()).toBe(true);
      expect(state().restoreMode).toBe('floating');
    });

    it('brings the collapsed bar home too', () => {
      preview.setMinimizedPoint({ x: 900, y: 700 });

      preview.resetGeometry();

      expect(preview.minimizedPoint()).toEqual(DEFAULT_PREVIEW_WINDOW.minimized);
    });
  });
});
