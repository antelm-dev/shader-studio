import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PREVIEW_WINDOW,
  PREVIEW_LIMITS,
  PREVIEW_MINIMIZED_SIZE,
  PREVIEW_MIN_FLOATING,
  clampMinimizedPoint,
  clampPreviewRect,
  defaultFloatingRect,
  sanitizePreviewWindow,
} from './preview';

/**
 * `localStorage` is user-writable and outlives any given build of this app, so
 * this is the only thing standing between a hand-edited preference and the CSS
 * that positions a live WebGL surface. What is worth pinning down is that nothing
 * gets through: not a string, not a NaN, not a window remembered against a
 * monitor that is no longer plugged in.
 */

describe('sanitizePreviewWindow', () => {
  it('keeps a state that is already valid', () => {
    const state = {
      mode: 'floating',
      restoreMode: 'stage',
      floating: { x: 10, y: 20, width: 640, height: 400 },
      minimized: { x: 5, y: 6 },
    };

    expect(sanitizePreviewWindow(state)).toEqual(state);
  });

  it.each([['not an object'], [null], [undefined], [42], [[]]])(
    'falls back to the whole default for %s',
    (value) => {
      expect(sanitizePreviewWindow(value)).toEqual(DEFAULT_PREVIEW_WINDOW);
    },
  );

  it('falls back to the stage for a mode this build does not have', () => {
    // 'docked' is the *editor's* vocabulary. The preview never had it, and a
    // shared storage key is exactly how it would arrive here.
    expect(sanitizePreviewWindow({ mode: 'docked' }).mode).toBe('stage');
  });

  it.each([['maximized'], ['minimized'], ['nonsense'], [7]])(
    'falls back to a real restore point for a restoreMode of %s',
    (restoreMode) => {
      // Restoring has to land somewhere you can live. A restoreMode of
      // "maximized" would make the restore button a no-op.
      const state = sanitizePreviewWindow({ restoreMode });
      expect(state.restoreMode).toBe(DEFAULT_PREVIEW_WINDOW.restoreMode);
    },
  );

  it('keeps each legal mode', () => {
    for (const mode of ['stage', 'floating', 'maximized', 'minimized'] as const) {
      expect(sanitizePreviewWindow({ mode }).mode).toBe(mode);
    }
  });

  it.each([
    ['a string', { width: '640' }],
    ['NaN', { width: Number.NaN }],
    ['Infinity', { width: Number.POSITIVE_INFINITY }],
    ['null', { width: null }],
  ])('falls back to the default width for %s', (_label, floating) => {
    expect(sanitizePreviewWindow({ floating }).floating.width).toBe(
      DEFAULT_PREVIEW_WINDOW.floating.width,
    );
  });

  it('clamps a window that has been collapsed to nothing', () => {
    const { floating } = sanitizePreviewWindow({ floating: { width: 0, height: -100 } });

    expect(floating.width).toBe(PREVIEW_LIMITS.floatingWidth.min);
    expect(floating.height).toBe(PREVIEW_LIMITS.floatingHeight.min);
  });

  it('clamps a window remembered from a very much larger screen', () => {
    const { floating } = sanitizePreviewWindow({
      floating: { x: 0, y: 0, width: 99_999, height: 99_999 },
    });

    expect(floating.width).toBe(PREVIEW_LIMITS.floatingWidth.max);
    expect(floating.height).toBe(PREVIEW_LIMITS.floatingHeight.max);
  });

  it('rounds every length to a whole pixel', () => {
    const { floating, minimized } = sanitizePreviewWindow({
      floating: { x: 10.4, y: 10.6, width: 640.5, height: 400.4 },
      minimized: { x: 3.7, y: 4.2 },
    });

    expect(floating).toEqual({ x: 10, y: 11, width: 641, height: 400 });
    expect(minimized).toEqual({ x: 4, y: 4 });
  });

  it('leaves a negative position alone, which only a viewport can judge', () => {
    // Off-screen is not invalid — it is unclamped. Storage has no idea how big
    // the workspace is; `clampPreviewRect` does that once the stage is measured.
    expect(sanitizePreviewWindow({ floating: { x: -200, y: -80 } }).floating).toMatchObject({
      x: -200,
      y: -80,
    });
  });

  it('repairs a partial state field by field rather than discarding it', () => {
    const state = sanitizePreviewWindow({ mode: 'minimized', floating: { width: 800 } });

    expect(state.mode).toBe('minimized');
    expect(state.floating.width).toBe(800);
    expect(state.floating.height).toBe(DEFAULT_PREVIEW_WINDOW.floating.height);
  });
});

describe('clampPreviewRect', () => {
  const viewport = { width: 1000, height: 800 };

  it('keeps a window that already fits', () => {
    const rect = { x: 100, y: 50, width: 600, height: 400 };
    expect(clampPreviewRect(rect, viewport)).toEqual(rect);
  });

  it('pulls an off-screen window back into the workspace', () => {
    const rect = clampPreviewRect({ x: 4000, y: 3000, width: 600, height: 400 }, viewport);

    expect(rect).toEqual({ x: 400, y: 400, width: 600, height: 400 });
  });

  it('pulls a window back from a negative corner', () => {
    expect(clampPreviewRect({ x: -300, y: -200, width: 600, height: 400 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 600,
      height: 400,
    });
  });

  it('shrinks a window too big for the workspace before it moves it', () => {
    // Fully visible, not merely reachable: a title bar peeking in from the edge
    // is not a recovered window.
    const rect = clampPreviewRect({ x: 500, y: 500, width: 4000, height: 4000 }, viewport);

    expect(rect).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });

  it('gives up the minimum size rather than overflow a tiny workspace', () => {
    const rect = clampPreviewRect(
      { x: 0, y: 0, width: 600, height: 400 },
      { width: 120, height: 90 },
    );

    expect(rect).toEqual({ x: 0, y: 0, width: 120, height: 90 });
  });

  it('leaves the rect alone when nothing has been measured yet', () => {
    // The server, and the first frame. Clamping against a zero viewport would
    // throw away the persisted window instead of restoring it.
    const rect = { x: 48, y: 48, width: 720, height: 480 };
    expect(clampPreviewRect(rect, { width: 0, height: 0 })).toEqual(rect);
  });

  it('never returns a window smaller than the minimum in a workspace with room', () => {
    const rect = clampPreviewRect({ x: 0, y: 0, width: 1, height: 1 }, viewport);

    expect(rect.width).toBe(PREVIEW_MIN_FLOATING.width);
    expect(rect.height).toBe(PREVIEW_MIN_FLOATING.height);
  });
});

describe('clampMinimizedPoint', () => {
  const viewport = { width: 1000, height: 800 };

  it('holds the collapsed bar fully inside the workspace', () => {
    const point = clampMinimizedPoint({ x: 5000, y: 5000 }, viewport);

    expect(point).toEqual({
      x: viewport.width - PREVIEW_MINIMIZED_SIZE.width,
      y: viewport.height - PREVIEW_MINIMIZED_SIZE.height,
    });
  });

  it('keeps a bar that already fits', () => {
    expect(clampMinimizedPoint({ x: 24, y: 24 }, viewport)).toEqual({ x: 24, y: 24 });
  });
});

describe('defaultFloatingRect', () => {
  it('centres the window in the workspace it is given', () => {
    const rect = defaultFloatingRect({ width: 1200, height: 900 });

    expect(rect.width).toBe(792);
    expect(rect.height).toBe(594);
    // Centred: the margin left of it is the margin right of it.
    expect(rect.x).toBe(Math.round((1200 - rect.width) / 2));
    expect(rect.y).toBe(Math.round((900 - rect.height) / 2));
  });

  it('stays inside a workspace far too small to be two-thirds of anything', () => {
    const viewport = { width: 200, height: 150 };
    const rect = defaultFloatingRect(viewport);

    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
  });

  it('falls back to the stored default before anything has been measured', () => {
    expect(defaultFloatingRect({ width: 0, height: 0 })).toEqual(DEFAULT_PREVIEW_WINDOW.floating);
  });
});
