import { afterEach, describe, expect, it } from 'vitest';

import { resetBridgeTokenForTests, resolveBridgeToken, tokensMatch } from './token';

describe('token', () => {
  afterEach(() => resetBridgeTokenForTests());

  it('generates a token when SHADER_STUDIO_MCP_TOKEN is unset', () => {
    const token = resolveBridgeToken({});
    expect(token.source).toBe('generated');
    expect(token.value).toMatch(/^[0-9a-f]{48}$/);
  });

  it('uses SHADER_STUDIO_MCP_TOKEN verbatim when set', () => {
    const token = resolveBridgeToken({ SHADER_STUDIO_MCP_TOKEN: 'pinned-token' });
    expect(token).toEqual({ value: 'pinned-token', source: 'env' });
  });

  it('caches the resolved token across calls within a process', () => {
    const first = resolveBridgeToken({});
    const second = resolveBridgeToken({ SHADER_STUDIO_MCP_TOKEN: 'ignored-because-cached' });
    expect(second).toEqual(first);
  });

  describe('tokensMatch', () => {
    it('accepts the correct token', () => {
      expect(tokensMatch('correct-token', 'correct-token')).toBe(true);
    });

    it('rejects an incorrect token of the same length', () => {
      expect(tokensMatch('wrong-tokennn', 'correct-token')).toBe(false);
    });

    it('rejects a token of a different length without throwing', () => {
      expect(tokensMatch('short', 'a-much-longer-token')).toBe(false);
    });

    it('rejects an empty candidate against a real token', () => {
      expect(tokensMatch('', 'correct-token')).toBe(false);
    });
  });
});
