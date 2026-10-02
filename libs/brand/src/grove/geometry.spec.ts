import { describe, expect, it } from 'vitest';

import { crownColor, groveCrowns, groveSvg, groveSvgCircles } from './geometry';
import { GROVE_PALETTES } from './palettes';

const grove = GROVE_PALETTES.grove;

describe('grove geometry', () => {
  it('samples a 5 × 5 square and a 3 × 3 small mark', () => {
    expect(groveCrowns(5)).toHaveLength(25);
    expect(groveCrowns(3)).toHaveLength(9);
  });

  // Reference values come from the approved HTML mock's static fallback (600 viewBox) and
  // favicon (36 viewBox), which were drawn from the same shader math.
  it('matches the canonical still of the mock', () => {
    const square = groveSvgCircles({ palette: grove, size: 600 });
    expect(square[0]).toEqual({ cx: 98.4, cy: 501.6, r: 26.62, fill: 'rgb(53,220,196)' });
    expect(square[12]).toEqual({ cx: 300, cy: 300, r: 47.38, fill: 'rgb(53,220,196)' });
    expect(square[24]).toEqual({ cx: 501.6, cy: 98.4, r: 26.62, fill: 'rgb(53,220,196)' });

    const small = groveSvgCircles({ palette: grove, size: 36, samples: 3 });
    expect(small[0]).toEqual({ cx: 7.92, cy: 28.08, r: 3.86, fill: 'rgb(53,220,196)' });
    expect(small[4]).toEqual({ cx: 18, cy: 18, r: 4.74, fill: 'rgb(53,220,196)' });
  });

  it('mixes the palette along the diagonal, or uses one ink in mono', () => {
    const expectColor = (actual: readonly number[], expected: readonly number[]) =>
      expected.forEach((channel, index) => expect(actual[index]).toBeCloseTo(channel, 10));
    expectColor(crownColor(grove, 0), [0x9d / 255, 1, 0x3e / 255]);
    expectColor(crownColor(grove, 0.5), [0x35 / 255, 0xdc / 255, 0xc4 / 255]);
    expectColor(crownColor(grove, 1), [0x81 / 255, 0x43 / 255, 0xf4 / 255]);
    expect(crownColor(grove, 0.3, true)).toEqual([0.95, 0.95, 0.93]);
  });

  it('writes a standalone SVG with one circle per crown', () => {
    const svg = groveSvg({ palette: grove, size: 36, samples: 3 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">')).toBe(
      true,
    );
    expect(svg.match(/<circle /g)).toHaveLength(9);
  });
});
