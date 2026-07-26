import { describe, expect, it } from 'vitest';

import { EditorNavigation, resolveNavigationTarget } from './editor-navigation';

describe('EditorNavigation', () => {
  it('has no request initially', () => {
    expect(new EditorNavigation().request()).toBeNull();
  });

  it('publishes docId, line and a requestId on reveal', () => {
    const navigation = new EditorNavigation();
    navigation.reveal('doc-a', 12);
    expect(navigation.request()).toEqual({ docId: 'doc-a', line: 12, requestId: 1 });
  });

  it('gives repeated navigation to the same diagnostic a new requestId', () => {
    const navigation = new EditorNavigation();
    navigation.reveal('doc-a', 12);
    const first = navigation.request();
    navigation.reveal('doc-a', 12);
    const second = navigation.request();

    expect(second).not.toBe(first);
    expect(second?.requestId).toBeGreaterThan(first?.requestId ?? -1);
    expect(second).toMatchObject({ docId: 'doc-a', line: 12 });
  });

  it('increases the requestId monotonically across different targets', () => {
    const navigation = new EditorNavigation();
    navigation.reveal('doc-a', 1);
    navigation.reveal('doc-b', 2);
    navigation.reveal('doc-a', 1);
    expect(navigation.request()?.requestId).toBe(3);
  });
});

describe('resolveNavigationTarget', () => {
  const documentIds = ['image', 'common', 'buffer-a'];

  it('navigates to a diagnostic in the active document', () => {
    const resolved = resolveNavigationTarget(
      { docId: 'image', line: 4, requestId: 1 },
      documentIds,
      'image',
    );
    expect(resolved).toEqual({ docId: 'image', line: 4, reveal: true });
  });

  it('navigates to another, currently inactive, document', () => {
    const resolved = resolveNavigationTarget(
      { docId: 'buffer-a', line: 7, requestId: 1 },
      documentIds,
      'image',
    );
    expect(resolved).toEqual({ docId: 'buffer-a', line: 7, reveal: true });
  });

  it('falls back to the active document when docId is missing', () => {
    const resolved = resolveNavigationTarget(
      { docId: '', line: 3, requestId: 1 },
      documentIds,
      'common',
    );
    expect(resolved).toEqual({ docId: 'common', line: 3, reveal: true });
  });

  it('falls back to the active document when docId names a deleted document', () => {
    const resolved = resolveNavigationTarget(
      { docId: 'buffer-z-deleted', line: 3, requestId: 1 },
      documentIds,
      'common',
    );
    expect(resolved).toEqual({ docId: 'common', line: 3, reveal: true });
  });

  it('resolves to nothing when there is no known docId and no active document', () => {
    const resolved = resolveNavigationTarget(
      { docId: '', line: 3, requestId: 1 },
      documentIds,
      null,
    );
    expect(resolved).toBeNull();
  });

  it('resolves line 0 to a target that is focused rather than revealed', () => {
    const resolved = resolveNavigationTarget(
      { docId: 'image', line: 0, requestId: 1 },
      documentIds,
      'image',
    );
    expect(resolved).toEqual({ docId: 'image', line: 0, reveal: false });
  });
});
