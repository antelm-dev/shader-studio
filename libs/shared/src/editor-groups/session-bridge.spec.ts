import { describe, expect, it } from 'vitest';

import { DEFAULT_EDITOR_GROUP_ID } from '../surfaces/types';
import {
  buildClaimOwnershipCommand,
  buildMoveDocumentCommand,
  buildReleaseOwnershipCommand,
  editorGroupClientId,
  serializeEditorGroupsForSession,
  sessionClientToEditorGroupId,
  toViewTransfer,
} from './session-bridge';

describe('editor-groups session bridge', () => {
  it('maps editor group ids to stable session client ids', () => {
    const clientId = editorGroupClientId(DEFAULT_EDITOR_GROUP_ID);
    expect(sessionClientToEditorGroupId(clientId)).toBe(DEFAULT_EDITOR_GROUP_ID);
  });

  it('builds ownership and movement commands', () => {
    expect(buildClaimOwnershipCommand('image')).toEqual({
      type: 'claimOwnership',
      documentId: 'image',
    });
    expect(buildReleaseOwnershipCommand('image')).toEqual({
      type: 'releaseOwnership',
      documentId: 'image',
    });
    expect(buildMoveDocumentCommand('image', DEFAULT_EDITOR_GROUP_ID, { scrollTop: 4 })).toEqual({
      type: 'moveDocument',
      documentId: 'image',
      targetClientId: editorGroupClientId(DEFAULT_EDITOR_GROUP_ID),
      viewState: { scrollTop: 4 },
    });
  });

  it('serializes groups for session snapshots', () => {
    const snapshot = serializeEditorGroupsForSession([
      {
        id: DEFAULT_EDITOR_GROUP_ID,
        documentIds: ['image', 'vertex'],
        activeDocumentId: 'vertex',
        presentation: 'full',
      },
    ]);
    expect(snapshot).toEqual([
      {
        groupId: DEFAULT_EDITOR_GROUP_ID,
        openDocumentIds: ['image', 'vertex'],
        activeDocumentId: 'vertex',
        presentation: 'full',
        ownerClientId: editorGroupClientId(DEFAULT_EDITOR_GROUP_ID),
      },
    ]);
  });

  it('packages view transfer metadata', () => {
    expect(toViewTransfer('image', { scrollTop: 1 }, 'simple')).toEqual({
      documentId: 'image',
      viewState: { scrollTop: 1 },
      presentation: 'simple',
    });
  });
});
