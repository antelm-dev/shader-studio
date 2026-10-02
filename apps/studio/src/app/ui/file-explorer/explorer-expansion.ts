import type { ExplorerNode } from './contract';

/** Session-local expansion map keyed by explorer node id. */
export type ExplorerExpansionState = ReadonlyMap<string, boolean>;

export interface VisibleExplorerRow {
  node: ExplorerNode;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

/** Seed expansion from tree defaults; preserve prior toggles when ids overlap. */
export function mergeExpansionState(
  nodes: readonly ExplorerNode[],
  previous: ExplorerExpansionState,
): ExplorerExpansionState {
  const next = new Map<string, boolean>();

  const walk = (list: readonly ExplorerNode[]): void => {
    for (const node of list) {
      if (node.children.length > 0) {
        const prior = previous.get(node.id);
        next.set(node.id, prior ?? node.defaultExpanded ?? true);
        walk(node.children);
      }
    }
  };

  walk(nodes);
  return next;
}

export function isExpanded(state: ExplorerExpansionState, nodeId: string): boolean {
  return state.get(nodeId) ?? true;
}

export function toggleExpanded(
  state: ExplorerExpansionState,
  nodeId: string,
): ExplorerExpansionState {
  const next = new Map(state);
  next.set(nodeId, !isExpanded(state, nodeId));
  return next;
}

export function setExpanded(
  state: ExplorerExpansionState,
  nodeId: string,
  expanded: boolean,
): ExplorerExpansionState {
  const next = new Map(state);
  next.set(nodeId, expanded);
  return next;
}

/** Depth-first visible rows respecting local expansion. */
export function visibleExplorerRows(
  nodes: readonly ExplorerNode[],
  expansion: ExplorerExpansionState,
  parentId: string | null = null,
): VisibleExplorerRow[] {
  const rows: VisibleExplorerRow[] = [];

  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren ? isExpanded(expansion, node.id) : false;
    rows.push({ node, parentId, hasChildren, expanded });

    if (hasChildren && expanded) {
      rows.push(...visibleExplorerRows(node.children, expansion, node.id));
    }
  }

  return rows;
}
