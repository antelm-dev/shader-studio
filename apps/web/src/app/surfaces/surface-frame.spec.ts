import { describe, expect, it } from 'vitest';

import { createDefaultSurface } from '@shader-studio/shared/surfaces';

import {
  displayFloatingRect,
  projectSurfaceFrame,
  recoverContainedBounds,
  surfaceFrameHostClasses,
} from './surface-frame';

describe('surface-frame', () => {
  it('projects stage as null frame and floating as clamped rect', () => {
    const stage = createDefaultSurface('preview', {
      placement: { host: 'contained', mode: 'stage' },
    });
    expect(projectSurfaceFrame(stage, { width: 800, height: 600 }).frame).toBeNull();

    const floating = createDefaultSurface('preview', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 50, y: 50, width: 400, height: 300 },
      },
    });
    const projected = projectSurfaceFrame(floating, { width: 800, height: 600 });
    expect(projected.mode).toBe('floating');
    expect(projected.frame).toEqual({ x: 50, y: 50, width: 400, height: 300 });
    expect(projected.resizableFloating).toBe(true);
    expect(projected.draggable).toBe(true);
  });

  it('recovers off-screen floating bounds for display without inventing negative sizes', () => {
    const recovered = recoverContainedBounds(
      'editor',
      { x: 2000, y: 2000, width: 400, height: 300 },
      { width: 800, height: 600 },
    );
    expect(recovered.x + recovered.width).toBeLessThanOrEqual(800);
    expect(recovered.y + recovered.height).toBeLessThanOrEqual(600);
    expect(recovered.width).toBeGreaterThan(0);
    expect(recovered.height).toBeGreaterThan(0);
  });

  it('uses liveRect preview over stored floating rect', () => {
    const surface = createDefaultSurface('editor', {
      placement: {
        host: 'contained',
        mode: 'floating',
        rect: { x: 10, y: 10, width: 500, height: 400 },
      },
    });
    const projected = projectSurfaceFrame(
      surface,
      { width: 1000, height: 800 },
      {
        liveRect: { x: 40, y: 40, width: 520, height: 420 },
      },
    );
    expect(projected.frame).toEqual({ x: 40, y: 40, width: 520, height: 420 });
  });

  it('exposes dock free-edge and size for docked surfaces', () => {
    const editor = createDefaultSurface('editor', {
      placement: { host: 'contained', mode: 'docked', side: 'bottom', size: 340 },
    });
    const projected = projectSurfaceFrame(editor, { width: 1000, height: 800 });
    expect(projected.mode).toBe('docked');
    expect(projected.dockSide).toBe('bottom');
    expect(projected.dockSize).toBe(340);
    expect(projected.freeEdge).toBe('n');
    expect(projected.resizableDocked).toBe(true);
  });

  it('forces compact editor dock side to bottom for display when viewport is narrow', () => {
    const editor = createDefaultSurface('editor', {
      placement: { host: 'contained', mode: 'docked', side: 'left', size: 360 },
    });
    const projected = projectSurfaceFrame(editor, { width: 640, height: 800 });
    expect(projected.dockSide).toBe('bottom');
  });

  it('displayFloatingRect clamps without requiring DOM', () => {
    const rect = displayFloatingRect(
      'preview',
      { x: -100, y: -50, width: 400, height: 300 },
      { width: 500, height: 400 },
    );
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
  });

  it('surfaceFrameHostClasses disable animation while dragging or reduced motion', () => {
    expect(
      surfaceFrameHostClasses({ dragging: true, reducedMotion: false, mode: 'floating' })[
        'surface-frame--animating'
      ],
    ).toBe(false);
    expect(
      surfaceFrameHostClasses({ dragging: false, reducedMotion: true, mode: 'floating' })[
        'surface-frame--animating'
      ],
    ).toBe(false);
    expect(
      surfaceFrameHostClasses({ dragging: false, reducedMotion: false, mode: 'floating' })[
        'surface-frame--animating'
      ],
    ).toBe(true);
  });
});
