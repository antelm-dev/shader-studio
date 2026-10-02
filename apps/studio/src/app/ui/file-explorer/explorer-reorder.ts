import type { ExplorerNode, ExplorerReorderIntent } from './contract';

export type ExplorerReorderList = ExplorerReorderIntent['list'];

export function reorderListForNode(node: ExplorerNode): ExplorerReorderList | null {
  if (node.kind === 'buffer-pass') return 'buffer';
  if (node.kind === 'source-file') return 'file';
  return null;
}

export function canDropReorder(source: ExplorerNode, target: ExplorerNode): boolean {
  if (!source.capabilities.reorder || !target.capabilities.reorder) return false;
  const sourceList = reorderListForNode(source);
  const targetList = reorderListForNode(target);
  return sourceList !== null && sourceList === targetList && source.id !== target.id;
}

export function buildReorderIntent(
  source: ExplorerNode,
  target: ExplorerNode,
): ExplorerReorderIntent | null {
  const list = reorderListForNode(source);
  if (!list || !canDropReorder(source, target) || !source.docId || !target.docId) {
    return null;
  }
  return { sourceDocId: source.docId, targetDocId: target.docId, list };
}
