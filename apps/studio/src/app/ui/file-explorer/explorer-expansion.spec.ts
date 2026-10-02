import { describe, expect, it } from 'vitest';

import { INFORMATIONAL_CAPABILITIES, INACTIVE_STATUS, type ExplorerNode } from './contract';
import { mergeExpansionState, toggleExpanded, visibleExplorerRows } from './explorer-expansion';

const group = (id: string, children: ExplorerNode[], defaultExpanded = true): ExplorerNode => ({
  id,
  kind: 'group',
  labelKey: 'explorer.group.passes',
  depth: 0,
  children,
  capabilities: INFORMATIONAL_CAPABILITIES,
  status: INACTIVE_STATUS,
  icon: 'folder',
  defaultExpanded,
});

const doc = (id: string, depth = 1): ExplorerNode => ({
  id,
  kind: 'buffer-pass',
  docId: id,
  name: id,
  depth,
  children: [],
  capabilities: {
    selectable: true,
    rename: true,
    duplicate: true,
    delete: true,
    reorder: true,
    toggleEnabled: true,
  },
  status: { ...INACTIVE_STATUS },
  icon: 'layers',
});

describe('explorer expansion', () => {
  const tree = [group('g1', [doc('a'), group('g2', [doc('b')], false)], true), doc('root-doc', 0)];

  it('seeds expansion from defaults and preserves prior toggles', () => {
    const prior = new Map([
      ['g1', false],
      ['g2', true],
    ]);
    const merged = mergeExpansionState(tree, prior);
    expect(merged.get('g1')).toBe(false);
    expect(merged.get('g2')).toBe(true);
  });

  it('flattens visible rows respecting expansion', () => {
    const expansion = new Map([
      ['g1', true],
      ['g2', false],
    ]);
    const rows = visibleExplorerRows(tree, expansion);
    expect(rows.map((row) => row.node.id)).toEqual(['g1', 'a', 'g2', 'root-doc']);
  });

  it('hides collapsed group children', () => {
    const expansion = new Map([
      ['g1', false],
      ['g2', true],
    ]);
    const rows = visibleExplorerRows(tree, expansion);
    expect(rows.map((row) => row.node.id)).toEqual(['g1', 'root-doc']);
  });

  it('toggles expansion immutably', () => {
    const state = new Map([['g1', true]]);
    const next = toggleExpanded(state, 'g1');
    expect(state.get('g1')).toBe(true);
    expect(next.get('g1')).toBe(false);
  });
});
