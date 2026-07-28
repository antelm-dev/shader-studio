import { describe, expect, it } from 'vitest';

import {
  FILES_GROUP_IDS,
  PIPELINE_GROUP_IDS,
  assertSelectableNodeId,
  channelBindingId,
  filesGroupId,
  isExplorerScopedId,
  passChannelId,
  passChannelsGroupId,
  pipelineGroupId,
} from './node-id';
import { isExplorerViewMode } from './contract';

describe('explorer node ids', () => {
  it('exposes stable files-view group ids', () => {
    expect(filesGroupId('passes')).toBe('explorer:files:group:passes');
    expect(filesGroupId('includes')).toBe('explorer:files:group:includes');
    expect(filesGroupId('project')).toBe('explorer:files:group:project');
    expect(FILES_GROUP_IDS.passes).toBe(filesGroupId('passes'));
  });

  it('exposes stable pipeline-view group ids', () => {
    expect(pipelineGroupId('execution')).toBe('explorer:pipeline:group:execution');
    expect(pipelineGroupId('disabled')).toBe('explorer:pipeline:group:disabled');
    expect(PIPELINE_GROUP_IDS.common).toBe(pipelineGroupId('common'));
  });

  it('builds deterministic pass channel ids from pass id and channel index', () => {
    const passId = 'pass-buffer-a';
    expect(passChannelsGroupId(passId)).toBe('explorer:pipeline:pass:pass-buffer-a:channels');
    expect(passChannelId(passId, 2)).toBe('explorer:pipeline:pass:pass-buffer-a:channel:2');
  });

  it('builds stable binding ids for each channel binding kind', () => {
    const passId = 'image-1';
    expect(channelBindingId(passId, 0, { kind: 'none' })).toBe(
      'explorer:pipeline:pass:image-1:channel:0:binding:none',
    );
    expect(channelBindingId(passId, 1, { kind: 'texture', textureSlot: 3 })).toBe(
      'explorer:pipeline:pass:image-1:channel:1:binding:texture:3',
    );
    expect(channelBindingId(passId, 2, { kind: 'buffer', targetId: 'buf-b' })).toBe(
      'explorer:pipeline:pass:image-1:channel:2:binding:buffer:buf-b',
    );
    expect(channelBindingId(passId, 3, { kind: 'feedback', targetId: 'buf-b' })).toBe(
      'explorer:pipeline:pass:image-1:channel:3:binding:feedback:buf-b',
    );
  });

  it('produces identical ids across repeated calls', () => {
    const first = channelBindingId('p1', 0, { kind: 'buffer', targetId: 'p2' });
    const second = channelBindingId('p1', 0, { kind: 'buffer', targetId: 'p2' });
    expect(first).toBe(second);
  });

  it('distinguishes explorer-scoped ids from document ids', () => {
    expect(isExplorerScopedId('explorer:files:group:passes')).toBe(true);
    expect(isExplorerScopedId('@vertex')).toBe(false);
    expect(isExplorerScopedId('pass-abc')).toBe(false);
  });

  it('rejects explorer-scoped ids as selectable document targets', () => {
    expect(() => assertSelectableNodeId('@config')).not.toThrow();
    expect(() => assertSelectableNodeId('explorer:files:group:passes')).toThrow();
  });
});

describe('isExplorerViewMode', () => {
  it.each(['files', 'pipeline'] as const)('accepts %s', (mode) => {
    expect(isExplorerViewMode(mode)).toBe(true);
  });

  it.each(['', 'tree', null, 1])('rejects %s', (value) => {
    expect(isExplorerViewMode(value)).toBe(false);
  });
});
