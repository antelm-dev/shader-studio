import { describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_GROUP_ID } from '@shader-studio/shared/surfaces';
import { toViewTransfer } from '@shader-studio/shared/editor-groups';
import { EditorGroupSession } from './editor-group-session';

describe('EditorGroupSession', () => {
  it('records and consumes view transfer metadata', () => {
    const session = new EditorGroupSession();
    const transfer = toViewTransfer('image', { scrollTop: 8 }, 'simple');
    session.recordViewTransfer(transfer);
    expect(session.viewTransfer('image')).toEqual(transfer);
    expect(session.consumeViewTransfer('image')).toEqual(transfer);
    expect(session.viewTransfer('image')).toBeNull();
  });

  it('builds session commands for group ownership moves', () => {
    const session = new EditorGroupSession();
    expect(session.claimForGroup(DEFAULT_EDITOR_GROUP_ID, 'image').type).toBe('claimOwnership');
    expect(session.moveToGroup('image', DEFAULT_EDITOR_GROUP_ID, { scrollTop: 1 }).type).toBe(
      'moveDocument',
    );
  });
});
