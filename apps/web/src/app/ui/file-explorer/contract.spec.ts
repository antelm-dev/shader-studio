import { describe, expect, it } from 'vitest';

import {
  EXPLORER_VIEW_MODES,
  INFORMATIONAL_CAPABILITIES,
  INACTIVE_STATUS,
  isSelectableKind,
  type ExplorerNodeKind,
} from './contract';

describe('explorer contract helpers', () => {
  it('fixes the view mode union', () => {
    expect(EXPLORER_VIEW_MODES).toEqual(['files', 'pipeline']);
  });

  it('marks only document kinds as selectable', () => {
    const selectable: ExplorerNodeKind[] = [
      'image-pass',
      'common-pass',
      'buffer-pass',
      'source-file',
      'vertex',
      'config',
    ];
    const informational: ExplorerNodeKind[] = [
      'group',
      'channel',
      'channel-none',
      'channel-texture',
      'channel-buffer',
      'channel-feedback',
    ];

    for (const kind of selectable) {
      expect(isSelectableKind(kind)).toBe(true);
    }
    for (const kind of informational) {
      expect(isSelectableKind(kind)).toBe(false);
    }
  });

  it('exposes frozen defaults for informational rows', () => {
    expect(INFORMATIONAL_CAPABILITIES.selectable).toBe(false);
    expect(INACTIVE_STATUS.errorCount).toBe(0);
  });
});
