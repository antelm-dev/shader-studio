import { describe, expect, it } from 'vitest';

import {
  BOTTOM_PANEL_HEIGHT_LIMITS,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_PANEL_WIDTHS,
  PANEL_LIMITS,
  clampBottomPanelHeight,
  clampPanelWidth,
  sanitizeBottomPanelTab,
  sanitizeInspectorTab,
} from './panel';

/**
 * `localStorage` is user-writable and outlives any given build of this app, so
 * these two are the only thing standing between a hand-edited preference and a
 * CSS length. What is worth pinning down is that nothing gets through: not a
 * string, not a NaN, not a width from a monitor twice this wide.
 */

describe('clampPanelWidth', () => {
  const limits = PANEL_LIMITS.inspectorWidth;
  const fallback = DEFAULT_PANEL_WIDTHS.inspector;

  it('keeps a width that is already in range', () => {
    expect(clampPanelWidth(320, limits, fallback)).toBe(320);
  });

  it('clamps a width remembered from a wider window', () => {
    expect(clampPanelWidth(4000, limits, fallback)).toBe(limits.max);
  });

  it('clamps a width that would collapse the panel', () => {
    expect(clampPanelWidth(12, limits, fallback)).toBe(limits.min);
  });

  it('rounds to whole pixels', () => {
    expect(clampPanelWidth(300.6, limits, fallback)).toBe(301);
  });

  it.each([
    ['a string', '320'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('falls back to the default for %s', (_label, value) => {
    expect(clampPanelWidth(value, limits, fallback)).toBe(fallback);
  });

  /**
   * The default layout is the one nobody chose, so it is the one that has to be
   * right: the preview keeps more than half of the narrowest window this app is
   * designed for, with both rails open. Dragging them wider is a choice; landing
   * in a cramped preview without making one is a bug.
   */
  it('leaves the preview more than half of a 1280px window by default', () => {
    const panels = DEFAULT_PANEL_WIDTHS.browser + DEFAULT_PANEL_WIDTHS.inspector;
    expect(1280 - panels).toBeGreaterThan(1280 / 2);
  });
});

describe('sanitizeInspectorTab', () => {
  it('keeps a known tab', () => {
    expect(sanitizeInspectorTab('textures')).toBe('textures');
  });

  it.each([['presets-old'], [''], [null], [3]])('falls back to controls for %s', (value) => {
    expect(sanitizeInspectorTab(value)).toBe('controls');
  });
});

describe('sanitizeBottomPanelTab', () => {
  it('keeps a known tab', () => {
    expect(sanitizeBottomPanelTab('output')).toBe('output');
    expect(sanitizeBottomPanelTab('problems')).toBe('problems');
  });

  it.each([['diagnostics'], [''], [null], [undefined], [1]])(
    'falls back to problems for %s',
    (value) => {
      expect(sanitizeBottomPanelTab(value)).toBe('problems');
    },
  );
});

describe('clampBottomPanelHeight', () => {
  it('keeps a height that is already in range', () => {
    expect(clampBottomPanelHeight(300)).toBe(300);
  });

  it('clamps a height below the minimum', () => {
    expect(clampBottomPanelHeight(10)).toBe(BOTTOM_PANEL_HEIGHT_LIMITS.min);
  });

  it('clamps a height above the maximum', () => {
    expect(clampBottomPanelHeight(50_000)).toBe(BOTTOM_PANEL_HEIGHT_LIMITS.max);
  });

  it('rounds to whole pixels', () => {
    expect(clampBottomPanelHeight(220.4)).toBe(220);
  });

  it.each([
    ['a string', '220'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('falls back to the default height for %s', (_label, value) => {
    expect(clampBottomPanelHeight(value)).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  });

  it('falls back to a caller-supplied default', () => {
    expect(clampBottomPanelHeight('nonsense', 340)).toBe(340);
  });
});
