import { describe, expect, it } from 'vitest';

import { isContainedPlacement } from './placement';
import { createDefaultSurface } from './sanitize';
import {
  canCreateInstance,
  closeSurface,
  dock,
  externalize,
  floatSurface,
  maximize,
  minimize,
  move,
  resetGeometry,
  resize,
  restore,
  returnToWorkspace,
  showOnStage,
} from './transitions';
import type { SurfaceRecord } from './types';

function preview(overrides: Partial<SurfaceRecord> = {}): SurfaceRecord {
  return { ...createDefaultSurface('preview'), ...overrides };
}

function editor(overrides: Partial<SurfaceRecord> = {}): SurfaceRecord {
  return { ...createDefaultSurface('editor'), ...overrides };
}

describe('transitions', () => {
  describe('capability rejections', () => {
    it('rejects preview close and dock', () => {
      const close = closeSurface(preview());
      expect(close.ok).toBe(false);
      if (!close.ok) expect(close.code).toBe('capability-denied');

      const docked = dock(preview(), 'bottom');
      expect(docked.ok).toBe(false);
      if (!docked.ok) expect(docked.code).toBe('capability-denied');
    });

    it('rejects editor on stage', () => {
      const result = showOnStage(editor());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('capability-denied');
    });

    it('rejects float for shader-browser / bottom-panel (still MVP rails)', () => {
      for (const kind of ['shader-browser', 'bottom-panel'] as const) {
        const result = floatSurface(createDefaultSurface(kind));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('capability-denied');
      }
    });

    it('allows float for inspector (phase 1) without widening its dock side', () => {
      const result = floatSurface(createDefaultSurface('inspector'));
      expect(result.ok).toBe(true);
      if (result.ok) {
        const placement = result.surface.placement;
        expect(isContainedPlacement(placement) && placement.mode).toBe('floating');
      }
    });

    it('rejects forbidden dock sides', () => {
      const result = dock(createDefaultSurface('inspector'), 'left');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('dock-side-forbidden');
    });

    it('rejects externalize when native host is unavailable', () => {
      const result = externalize(
        editor(),
        { x: 0, y: 0, width: 800, height: 600 },
        {
          allowNative: false,
        },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('externalize-unavailable');
    });
  });

  describe('maximize / minimize restore points', () => {
    it('restores floating editor after maximize → minimize → restore', () => {
      let surface = editor({
        placement: {
          host: 'contained',
          mode: 'floating',
          rect: { x: 40, y: 50, width: 700, height: 400 },
        },
      });

      const max = maximize(surface);
      expect(max.ok).toBe(true);
      if (!max.ok) return;
      surface = max.surface;
      expect(surface.placement).toMatchObject({
        mode: 'maximized',
        restore: { mode: 'floating' },
      });

      const min = minimize(surface);
      expect(min.ok).toBe(true);
      if (!min.ok) return;
      surface = min.surface;
      expect(surface.placement).toMatchObject({
        mode: 'minimized',
        restore: { mode: 'floating', rect: { x: 40, y: 50, width: 700, height: 400 } },
      });

      const restored = restore(surface);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.surface.placement).toEqual({
        host: 'contained',
        mode: 'floating',
        rect: { x: 40, y: 50, width: 700, height: 400 },
      });
    });

    it('does not overwrite restore when maximizing twice', () => {
      let surface = editor({
        placement: { host: 'contained', mode: 'docked', side: 'bottom', size: 320 },
      });
      const first = maximize(surface);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      surface = first.surface;
      const again = maximize(surface);
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.surface.placement).toMatchObject({
        mode: 'maximized',
        restore: { mode: 'docked', side: 'bottom', size: 320 },
      });
    });

    it('preserves preview stage restore across maximize then minimize', () => {
      let surface = preview({ placement: { host: 'contained', mode: 'stage' } });
      const max = maximize(surface);
      expect(max.ok).toBe(true);
      if (!max.ok) return;
      surface = max.surface;
      const min = minimize(surface);
      expect(min.ok).toBe(true);
      if (!min.ok) return;
      expect(min.surface.placement).toMatchObject({
        mode: 'minimized',
        restore: { mode: 'stage' },
      });
      const restored = restore(min.surface);
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.surface.placement).toEqual({ host: 'contained', mode: 'stage' });
    });
  });

  describe('externalize / return', () => {
    it('externalizes then returns to the prior durable placement', () => {
      const floated = floatSurface(editor(), { x: 12, y: 24, width: 640, height: 400 });
      expect(floated.ok).toBe(true);
      if (!floated.ok) return;

      const ext = externalize(
        floated.surface,
        { x: 100, y: 100, width: 900, height: 700 },
        { allowNative: true, displayId: 'display-1' },
      );
      expect(ext.ok).toBe(true);
      if (!ext.ok) return;
      expect(ext.surface.placement.host).toBe('native');
      expect(ext.surface.returnPoint).toEqual({
        mode: 'floating',
        rect: { x: 12, y: 24, width: 640, height: 400 },
      });

      const back = returnToWorkspace(ext.surface);
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.surface.placement).toEqual({
        host: 'contained',
        mode: 'floating',
        rect: { x: 12, y: 24, width: 640, height: 400 },
      });
      expect(back.surface.returnPoint).toBeUndefined();
    });

    it('returns live-preview-output with a preview placement effect', () => {
      const surface = createDefaultSurface('live-preview-output', {
        open: true,
        placement: { host: 'native', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        chrome: { kind: 'live-preview-output' },
      });
      surface.returnPoint = { mode: 'stage' };

      const result = returnToWorkspace(surface);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.surface.open).toBe(false);
      expect(result.previewPlacement).toEqual({ host: 'contained', mode: 'stage' });
    });
  });

  describe('singleton vs multi-instance', () => {
    it('rejects a second open preview', () => {
      const existing = [preview({ open: true })];
      const result = canCreateInstance('preview', existing);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('singleton-exists');
    });

    it('allows a second editor instance', () => {
      const existing = [editor({ open: true })];
      expect(canCreateInstance('editor', existing)).toEqual({ ok: true });
    });
  });

  describe('last editor group close', () => {
    it('rejects closing the last contained editor group', () => {
      const result = closeSurface(editor({ open: true }), { remainingEditorGroups: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('last-editor-group');
    });

    it('rejects closing the last external editor group (must return instead)', () => {
      const surface = editor({
        open: true,
        placement: { host: 'native', bounds: { x: 0, y: 0, width: 800, height: 600 } },
      });
      const result = closeSurface(surface, { remainingEditorGroups: 0 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('last-editor-group');
        expect(result.message).toMatch(/return to workspace/i);
      }
    });

    it('allows closing a non-last editor group without discarding open flag only', () => {
      const result = closeSurface(editor({ open: true }), { remainingEditorGroups: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.surface.open).toBe(false);
      expect(result.surface.chrome).toEqual(editor().chrome);
    });
  });

  describe('move / resize / reset', () => {
    it('moves and resizes a floating surface within a viewport', () => {
      const floated = floatSurface(
        editor(),
        { x: 10, y: 10, width: 500, height: 300 },
        { viewport: { width: 1000, height: 800 } },
      );
      expect(floated.ok).toBe(true);
      if (!floated.ok) return;

      const moved = move(
        floated.surface,
        { x: 50, y: 60 },
        {
          viewport: { width: 1000, height: 800 },
        },
      );
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.surface.placement).toMatchObject({
        mode: 'floating',
        rect: { x: 50, y: 60 },
      });

      const resized = resize(
        moved.surface,
        { rect: { x: 50, y: 60, width: 400, height: 280 } },
        { viewport: { width: 1000, height: 800 } },
      );
      expect(resized.ok).toBe(true);
      if (!resized.ok) return;
      expect(resized.surface.placement).toMatchObject({
        mode: 'floating',
        rect: { width: 400, height: 280 },
      });
    });

    it('resizes a docked rail with min enforcement', () => {
      const surface = createDefaultSurface('inspector');
      const resized = resize(surface, { size: 10 });
      expect(resized.ok).toBe(true);
      if (!resized.ok) return;
      expect(resized.surface.placement).toMatchObject({
        mode: 'docked',
        size: 260,
      });
    });

    it('resets floating preview geometry to a centred default', () => {
      const floated = floatSurface(
        preview(),
        { x: 0, y: 0, width: 300, height: 200 },
        { viewport: { width: 900, height: 600 } },
      );
      expect(floated.ok).toBe(true);
      if (!floated.ok) return;
      const reset = resetGeometry(floated.surface, { viewport: { width: 900, height: 600 } });
      expect(reset.ok).toBe(true);
      if (!reset.ok) return;
      expect(reset.surface.placement).toMatchObject({ mode: 'floating' });
    });
  });

  describe('native bounds recovery', () => {
    it('clamps native move against a smaller work area', () => {
      const surface = editor({
        placement: {
          host: 'native',
          bounds: { x: 2000, y: 2000, width: 800, height: 600 },
          displayId: 'gone',
        },
      });
      const moved = move(
        surface,
        { x: 2000, y: 2000 },
        {
          workArea: { width: 1280, height: 720 },
        },
      );
      expect(moved.ok).toBe(true);
      if (!moved.ok) return;
      expect(moved.surface.placement.host).toBe('native');
      if (moved.surface.placement.host !== 'native') return;
      expect(moved.surface.placement.bounds.x).toBeLessThanOrEqual(1280);
      expect(moved.surface.placement.bounds.y).toBeLessThanOrEqual(720);
    });
  });
});
