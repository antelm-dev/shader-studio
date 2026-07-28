import { describe, expect, it } from 'vitest';

import { type ExplorerNode, type ExplorerNodeCapabilities } from './contract';
import { buildReorderIntent, canDropReorder } from './explorer-reorder';

const caps = (patch: Partial<ExplorerNodeCapabilities>): ExplorerNodeCapabilities => ({
  selectable: true,
  rename: false,
  duplicate: false,
  delete: false,
  reorder: false,
  toggleEnabled: false,
  ...patch,
});

const node = (patch: Partial<ExplorerNode> & Pick<ExplorerNode, 'id' | 'kind'>): ExplorerNode => ({
  depth: 0,
  children: [],
  capabilities: caps(patch.capabilities ?? {}),
  status: {
    active: false,
    disabled: false,
    dirty: false,
    compiling: false,
    errorCount: 0,
    ...patch.status,
  },
  icon: 'layers',
  docId: patch.docId ?? patch.id,
  ...patch,
});

describe('explorer reorder', () => {
  it('allows buffer-to-buffer and file-to-file drops only', () => {
    const bufferA = node({
      id: 'buf-a',
      kind: 'buffer-pass',
      capabilities: caps({ reorder: true }),
    });
    const bufferB = node({
      id: 'buf-b',
      kind: 'buffer-pass',
      capabilities: caps({ reorder: true }),
    });
    const file = node({
      id: 'file-a',
      kind: 'source-file',
      capabilities: caps({ reorder: true }),
    });

    expect(canDropReorder(bufferA, bufferB)).toBe(true);
    expect(canDropReorder(bufferA, file)).toBe(false);
    expect(canDropReorder(file, bufferA)).toBe(false);
  });

  it('builds reorder intents for compatible siblings', () => {
    const source = node({
      id: 'buf-a',
      kind: 'buffer-pass',
      docId: 'buf-a',
      capabilities: caps({ reorder: true }),
    });
    const target = node({
      id: 'buf-b',
      kind: 'buffer-pass',
      docId: 'buf-b',
      capabilities: caps({ reorder: true }),
    });

    expect(buildReorderIntent(source, target)).toEqual({
      sourceDocId: 'buf-a',
      targetDocId: 'buf-b',
      list: 'buffer',
    });
  });
});
