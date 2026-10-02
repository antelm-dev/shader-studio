import { describe, expect, it } from 'vitest';

import { nextTabIndex } from './inspector-panel';

describe('nextTabIndex', () => {
  it('moves one tab at a time and wraps at both ends', () => {
    expect(nextTabIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextTabIndex('ArrowRight', 3, 4)).toBe(0);
    expect(nextTabIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(nextTabIndex('ArrowLeft', 2, 4)).toBe(1);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextTabIndex('Home', 2, 4)).toBe(0);
    expect(nextTabIndex('End', 1, 4)).toBe(3);
  });

  it('leaves every other key alone', () => {
    expect(nextTabIndex('ArrowDown', 1, 4)).toBeNull();
    expect(nextTabIndex('a', 1, 4)).toBeNull();
  });
});
