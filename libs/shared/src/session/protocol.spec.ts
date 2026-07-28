import { describe, expect, it } from 'vitest';

import {
  SESSION_PROTOCOL_VERSION,
  negotiateSessionProtocol,
  parseSessionCommand,
  parseSessionSnapshot,
  emptySessionSnapshot,
  asSessionId,
  SessionCommandSchemas,
} from './index';

describe('session protocol version', () => {
  it('accepts the current protocol version', () => {
    expect(negotiateSessionProtocol(SESSION_PROTOCOL_VERSION)).toEqual({
      ok: true,
      version: SESSION_PROTOCOL_VERSION,
    });
  });

  it('rejects unknown protocol versions', () => {
    expect(negotiateSessionProtocol(999)).toEqual({
      ok: false,
      reason: 'PROTOCOL_MISMATCH',
      requested: 999,
      supported: [SESSION_PROTOCOL_VERSION],
    });
  });
});

describe('session command validation', () => {
  it('accepts a well-formed editDocument command', () => {
    const result = parseSessionCommand({
      type: 'editDocument',
      documentId: 'image',
      baseRevision: 3,
      source: 'void main() {}',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects malformed patch ranges via schema', () => {
    const result = SessionCommandSchemas.patchDocument.safeParse({
      type: 'patchDocument',
      documentId: 'image',
      baseRevision: 0,
      edits: [{ start: -1, end: 2, text: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty patch edit lists', () => {
    const result = parseSessionCommand({
      type: 'patchDocument',
      documentId: 'image',
      baseRevision: 0,
      edits: [],
    });
    expect(result.ok).toBe(false);
  });

  it('parses hello with role and protocol version', () => {
    const result = parseSessionCommand({
      type: 'hello',
      protocolVersion: SESSION_PROTOCOL_VERSION,
      role: 'observer',
      label: 'preview',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ type: 'hello', role: 'observer' });
    }
  });
});

describe('session snapshot validation', () => {
  it('round-trips an empty snapshot', () => {
    const snapshot = emptySessionSnapshot(asSessionId('session:test'));
    const parsed = parseSessionSnapshot(snapshot);
    expect(parsed.ok).toBe(true);
  });

  it('rejects snapshots missing protocolVersion', () => {
    const snapshot = emptySessionSnapshot(asSessionId('session:test'));
    const { protocolVersion: _, ...rest } = snapshot;
    void _;
    expect(parseSessionSnapshot(rest).ok).toBe(false);
  });
});
