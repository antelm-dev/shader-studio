import { describe, expect, it } from 'vitest';

import { searchPalette, type PaletteItem } from './palette-search';

const item = (label: string): PaletteItem => ({
  id: label,
  icon: 'code',
  label,
  group: 'View',
  run: () => undefined,
});

const ITEMS = [
  item('Hide inspector'),
  item('Show editor'),
  item('Export shader…'),
  item('Rename shader…'),
  item('Aurora Veil'),
  item('Préréglages'),
];

const labels = (query: string) => searchPalette(ITEMS, query).map((found) => found.label);

describe('searchPalette', () => {
  it('keeps everything, in order, for an empty query', () => {
    expect(labels('  ')).toEqual(ITEMS.map((entry) => entry.label));
  });

  it('matches every word of the query, in any order and any case', () => {
    expect(labels('SHADER export')).toEqual(['Export shader…']);
    expect(labels('shader')).toEqual(['Export shader…', 'Rename shader…']);
  });

  it('ranks a label prefix above a word prefix above a match inside a word', () => {
    // "e" starts "Export shader…", starts a word of "Show editor", and only
    // sits inside the rest, which keep their original order.
    expect(labels('e')).toEqual([
      'Export shader…',
      'Show editor',
      'Hide inspector',
      'Rename shader…',
      'Aurora Veil',
      'Préréglages',
    ]);
  });

  it('ignores accents on both sides', () => {
    expect(labels('prereglages')).toEqual(['Préréglages']);
  });

  it('returns nothing when a word is missing', () => {
    expect(labels('shader zzz')).toEqual([]);
  });
});
