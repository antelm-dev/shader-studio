import { describe, expect, it } from 'vitest';

import {
  RESIZE_NUDGE,
  RESIZE_NUDGE_FAST,
  arrowKeyDelta,
  containRect,
  resizeRect,
  type Rect,
  type Size,
} from './geometry';

/**
 * Shared keyboard and resize arithmetic used by editor and preview shells.
 * Characterization for the native-surfaces contract: nudge sizes and edge
 * minima must stay stable when shells share a contained-window runtime.
 */

describe('arrowKeyDelta', () => {
  it('returns null for unrelated keys', () => {
    expect(arrowKeyDelta({ key: 'Enter', shiftKey: false })).toBeNull();
    expect(arrowKeyDelta({ key: 'a', shiftKey: true })).toBeNull();
  });

  it('nudges sixteen pixels with arrow keys', () => {
    expect(arrowKeyDelta({ key: 'ArrowLeft', shiftKey: false })).toEqual([-RESIZE_NUDGE, 0]);
    expect(arrowKeyDelta({ key: 'ArrowRight', shiftKey: false })).toEqual([RESIZE_NUDGE, 0]);
    expect(arrowKeyDelta({ key: 'ArrowUp', shiftKey: false })).toEqual([0, -RESIZE_NUDGE]);
    expect(arrowKeyDelta({ key: 'ArrowDown', shiftKey: false })).toEqual([0, RESIZE_NUDGE]);
  });

  it('nudges sixty-four pixels when Shift is held', () => {
    expect(arrowKeyDelta({ key: 'ArrowLeft', shiftKey: true })).toEqual([-RESIZE_NUDGE_FAST, 0]);
    expect(arrowKeyDelta({ key: 'ArrowDown', shiftKey: true })).toEqual([0, RESIZE_NUDGE_FAST]);
  });
});

describe('resizeRect', () => {
  const min: Size = { width: 100, height: 80 };
  const rect: Rect = { x: 40, y: 30, width: 200, height: 160 };

  it('grows the east and south edges by the pointer delta', () => {
    expect(resizeRect(rect, 'e', 20, 0, min)).toEqual({ ...rect, width: 220 });
    expect(resizeRect(rect, 's', 0, 10, min)).toEqual({ ...rect, height: 170 });
    expect(resizeRect(rect, 'se', 20, 10, min)).toEqual({
      x: 40,
      y: 30,
      width: 220,
      height: 170,
    });
  });

  it('moves the origin when resizing from west or north', () => {
    expect(resizeRect(rect, 'w', 20, 0, min)).toEqual({
      x: 60,
      y: 30,
      width: 180,
      height: 160,
    });
    expect(resizeRect(rect, 'n', 0, 20, min)).toEqual({
      x: 40,
      y: 50,
      width: 200,
      height: 140,
    });
  });

  it('stops at the minimum size instead of inverting the rect', () => {
    expect(resizeRect(rect, 'w', 500, 0, min)).toEqual({
      x: 140,
      y: 30,
      width: 100,
      height: 160,
    });
    expect(resizeRect(rect, 'n', 0, 500, min)).toEqual({
      x: 40,
      y: 110,
      width: 200,
      height: 80,
    });
  });
});

describe('containRect', () => {
  const min: Size = { width: 100, height: 80 };

  it('passes the rect through when the viewport has not been measured', () => {
    const rect = { x: 10, y: 20, width: 300, height: 200 };
    expect(containRect(rect, { width: 0, height: 0 }, min)).toEqual(rect);
  });

  it('pulls an off-screen rect fully inside the viewport', () => {
    expect(
      containRect({ x: 5000, y: 5000, width: 200, height: 150 }, { width: 400, height: 300 }, min),
    ).toEqual({ x: 200, y: 150, width: 200, height: 150 });
  });

  it('shrinks a rect that is larger than the viewport before moving it', () => {
    expect(
      containRect({ x: 10, y: 10, width: 800, height: 600 }, { width: 400, height: 300 }, min),
    ).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});
