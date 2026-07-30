import { describe, expect, it } from 'vitest';

import { keyboardResizeDocked, keyboardResizeFloating } from './surface-keyboard';
import { SurfaceGeometryGesture } from './surface-gesture';

describe('surface-keyboard', () => {
  it('nudges floating south edge with ArrowDown', () => {
    const rect = keyboardResizeFloating(
      'editor',
      { x: 10, y: 10, width: 400, height: 300 },
      's',
      { key: 'ArrowDown', shiftKey: false },
      { width: 1200, height: 800 },
    );
    expect(rect?.height).toBe(316);
  });

  it('uses Shift for a larger floating nudge', () => {
    const rect = keyboardResizeFloating(
      'editor',
      { x: 10, y: 10, width: 400, height: 300 },
      'e',
      { key: 'ArrowRight', shiftKey: true },
      { width: 1200, height: 800 },
    );
    expect(rect?.width).toBe(464);
  });

  it('resizes docked bottom with ArrowUp', () => {
    const size = keyboardResizeDocked(
      'editor',
      'bottom',
      320,
      { key: 'ArrowUp', shiftKey: false },
      { width: 1000, height: 800 },
    );
    expect(size).toBe(336);
  });

  it('resizes the inspector docked-right free edge with ArrowLeft', () => {
    const size = keyboardResizeDocked(
      'inspector',
      'right',
      300,
      { key: 'ArrowLeft', shiftKey: false },
      { width: 1200, height: 800 },
    );
    expect(size).toBe(316);
  });

  it('resizes a floating inspector edge with the arrow keys', () => {
    const rect = keyboardResizeFloating(
      'inspector',
      { x: 40, y: 40, width: 360, height: 300 },
      'e',
      { key: 'ArrowRight', shiftKey: false },
      { width: 1200, height: 800 },
    );
    expect(rect?.width).toBe(376);
  });

  it('returns null for non-arrow keys', () => {
    expect(
      keyboardResizeFloating('preview', { x: 0, y: 0, width: 400, height: 300 }, 'n', {
        key: 'Enter',
        shiftKey: false,
      }),
    ).toBeNull();
  });
});

describe('SurfaceGeometryGesture', () => {
  it('starts with empty live preview signals', () => {
    const gesture = new SurfaceGeometryGesture();
    expect(gesture.dragging()).toBe(false);
    expect(gesture.liveRect()).toBeNull();
    expect(gesture.liveDockSize()).toBeNull();
    expect(gesture.livePoint()).toBeNull();
  });

  it('cancel clears live preview without requiring a pointer', () => {
    const gesture = new SurfaceGeometryGesture();
    gesture.cancel();
    expect(gesture.liveRect()).toBeNull();
  });
});
