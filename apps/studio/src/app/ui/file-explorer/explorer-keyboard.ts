import type { VisibleExplorerRow } from './explorer-expansion';

export type ExplorerKeyboardAction =
  | { type: 'focus'; nodeId: string }
  | { type: 'expand'; nodeId: string }
  | { type: 'collapse'; nodeId: string }
  | { type: 'activate'; docId: string }
  | { type: 'open-menu'; nodeId: string };

export function resolveExplorerKeyboardAction(
  event: Pick<KeyboardEvent, 'key'> & Partial<Pick<KeyboardEvent, 'shiftKey'>>,
  rows: readonly VisibleExplorerRow[],
  focusedId: string | null,
): ExplorerKeyboardAction | null {
  if (rows.length === 0) return null;

  const index = focusedId ? rows.findIndex((row) => row.node.id === focusedId) : -1;
  const current = index >= 0 ? rows[index] : null;

  switch (event.key) {
    case 'Home':
      return { type: 'focus', nodeId: rows[0].node.id };
    case 'End':
      return { type: 'focus', nodeId: rows[rows.length - 1].node.id };
    case 'ArrowDown': {
      const next = rows[Math.min(index < 0 ? 0 : index + 1, rows.length - 1)];
      return next ? { type: 'focus', nodeId: next.node.id } : null;
    }
    case 'ArrowUp': {
      const next = rows[Math.max(index <= 0 ? 0 : index - 1, 0)];
      return next ? { type: 'focus', nodeId: next.node.id } : null;
    }
    case 'ArrowRight':
      if (!current) return { type: 'focus', nodeId: rows[0].node.id };
      if (current.hasChildren && !current.expanded) {
        return { type: 'expand', nodeId: current.node.id };
      }
      return null;
    case 'ArrowLeft':
      if (!current) return null;
      if (current.hasChildren && current.expanded) {
        return { type: 'collapse', nodeId: current.node.id };
      }
      if (current.parentId) {
        return { type: 'focus', nodeId: current.parentId };
      }
      return null;
    case 'Enter':
    case ' ': {
      if (!current?.node.capabilities.selectable || !current.node.docId) return null;
      return { type: 'activate', docId: current.node.docId };
    }
    case 'ContextMenu':
      if (!current) return null;
      return { type: 'open-menu', nodeId: current.node.id };
    case 'F10':
      // Shift+F10 is the Windows context-menu shortcut; plain F10 is ignored.
      // MatContextMenuTrigger also handles the native `contextmenu` event.
      if (!event.shiftKey || !current) return null;
      return { type: 'open-menu', nodeId: current.node.id };
    default:
      return null;
  }
}
