import { describe, expect, it } from 'vitest';

import { INFORMATIONAL_CAPABILITIES, INACTIVE_STATUS, type ExplorerNode } from './contract';
import type { VisibleExplorerRow } from './explorer-expansion';
import { resolveExplorerKeyboardAction } from './explorer-keyboard';

const row = (
  id: string,
  patch: Partial<ExplorerNode> = {},
  hasChildren = false,
  expanded = false,
  parentId: string | null = null,
): VisibleExplorerRow => ({
  node: {
    id,
    kind: 'buffer-pass',
    docId: id,
    name: id,
    depth: 0,
    children: [],
    capabilities: {
      selectable: true,
      rename: false,
      duplicate: false,
      delete: false,
      reorder: false,
      toggleEnabled: false,
      ...patch.capabilities,
    },
    status: { ...INACTIVE_STATUS, ...patch.status },
    icon: 'layers',
    ...patch,
  },
  parentId,
  hasChildren,
  expanded,
});

describe('explorer keyboard', () => {
  const rows = [
    row('a'),
    row('group', { kind: 'group', capabilities: INFORMATIONAL_CAPABILITIES }, true, false),
    row('b', {}, false, false, 'group'),
  ];

  it('moves focus with arrow keys', () => {
    expect(resolveExplorerKeyboardAction({ key: 'ArrowDown' }, rows, 'a')).toEqual({
      type: 'focus',
      nodeId: 'group',
    });
    expect(resolveExplorerKeyboardAction({ key: 'ArrowUp' }, rows, 'b')).toEqual({
      type: 'focus',
      nodeId: 'group',
    });
  });

  it('jumps to ends with Home and End', () => {
    expect(resolveExplorerKeyboardAction({ key: 'Home' }, rows, 'b')).toEqual({
      type: 'focus',
      nodeId: 'a',
    });
    expect(resolveExplorerKeyboardAction({ key: 'End' }, rows, 'a')).toEqual({
      type: 'focus',
      nodeId: 'b',
    });
  });

  it('expands and collapses groups', () => {
    expect(resolveExplorerKeyboardAction({ key: 'ArrowRight' }, rows, 'group')).toEqual({
      type: 'expand',
      nodeId: 'group',
    });
    const expanded = [
      row('a'),
      row('group', { kind: 'group', capabilities: INFORMATIONAL_CAPABILITIES }, true, true),
      row('b', {}, false, false, 'group'),
    ];
    expect(resolveExplorerKeyboardAction({ key: 'ArrowLeft' }, expanded, 'group')).toEqual({
      type: 'collapse',
      nodeId: 'group',
    });
    expect(resolveExplorerKeyboardAction({ key: 'ArrowLeft' }, expanded, 'b')).toEqual({
      type: 'focus',
      nodeId: 'group',
    });
  });

  it('activates selectable rows on Enter', () => {
    expect(resolveExplorerKeyboardAction({ key: 'Enter' }, rows, 'a')).toEqual({
      type: 'activate',
      docId: 'a',
    });
  });

  it('ignores activation for informational rows', () => {
    const informational = row('info', {
      kind: 'channel',
      capabilities: INFORMATIONAL_CAPABILITIES,
      docId: undefined,
    });
    expect(resolveExplorerKeyboardAction({ key: 'Enter' }, [informational], 'info')).toBeNull();
  });

  it('opens the row menu from ContextMenu and Shift+F10', () => {
    expect(resolveExplorerKeyboardAction({ key: 'ContextMenu' }, rows, 'a')).toEqual({
      type: 'open-menu',
      nodeId: 'a',
    });
    expect(resolveExplorerKeyboardAction({ key: 'F10', shiftKey: true }, rows, 'a')).toEqual({
      type: 'open-menu',
      nodeId: 'a',
    });
    expect(resolveExplorerKeyboardAction({ key: 'F10' }, rows, 'a')).toBeNull();
  });
});
