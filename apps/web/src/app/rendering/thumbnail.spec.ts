import { describe, expect, it } from 'vitest';

import { coverCrop } from './thumbnail';

/**
 * `encodeThumbnail` itself needs a canvas and an `ImageBitmap`, neither of
 * which jsdom has. The framing is the part that can actually be wrong, and it
 * is pure — so that is what is pinned down here.
 */
describe('coverCrop', () => {
  it('takes the whole canvas when it already has the target aspect', () => {
    expect(coverCrop(1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('trims the sides of a canvas that is too wide, keeping it centred', () => {
    const crop = coverCrop(2000, 1000);

    expect(crop.height).toBe(1000);
    expect(crop.width / crop.height).toBeCloseTo(16 / 9);
    expect(crop.x).toBeCloseTo((2000 - crop.width) / 2);
    expect(crop.y).toBe(0);
  });

  it('trims the top and bottom of a canvas that is too tall, keeping it centred', () => {
    const crop = coverCrop(1000, 1000);

    expect(crop.width).toBe(1000);
    expect(crop.width / crop.height).toBeCloseTo(16 / 9);
    expect(crop.y).toBeCloseTo((1000 - crop.height) / 2);
    expect(crop.x).toBe(0);
  });

  it('never crops outside the canvas', () => {
    for (const [width, height] of [
      [1920, 1080],
      [800, 2000],
      [3000, 400],
      [1, 1],
    ]) {
      const crop = coverCrop(width, height);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(height);
    }
  });

  it('gives up on a canvas with no area, rather than dividing by zero', () => {
    expect(coverCrop(0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(coverCrop(1920, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});
