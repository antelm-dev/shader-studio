import { describe, expect, it } from 'vitest';

import { scrubValue } from './label-scrub';

describe('scrubValue', () => {
  const control = { min: 0, max: 12, step: 0.1 };

  it('sweeps the whole range over the same distance whatever the units', () => {
    expect(scrubValue(control, 0, 240, false)).toBe(12);
    expect(scrubValue({ min: 0, max: 1 }, 0, 120, false)).toBe(0.5);
  });

  it('moves a tenth as far with the fine modifier', () => {
    expect(scrubValue(control, 6, 20, false)).toBe(7);
    expect(scrubValue(control, 6, 20, true)).toBe(6.1);
  });

  it('snaps to the step without leaving binary noise', () => {
    expect(scrubValue(control, 0.1, 4, false)).toBe(0.3);
  });

  it('stays inside the range in both directions', () => {
    expect(scrubValue(control, 1, -500, false)).toBe(0);
    expect(scrubValue(control, 11, 500, false)).toBe(12);
  });

  it('snaps from the minimum, so an offset range keeps its own grid', () => {
    expect(scrubValue({ min: 0.25, max: 2, step: 0.5 }, 0.25, 70, false)).toBe(0.75);
  });
});
