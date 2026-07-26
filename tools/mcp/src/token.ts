import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The shared secret the browser tab must present in its handshake.
 *
 * `127.0.0.1` is not an authentication boundary — any local process (or, on a
 * shared machine, another local user) can open a socket to it.
 * `SHADER_STUDIO_MCP_TOKEN` lets a developer pin a token across the two
 * independently-started processes (the MCP server and the app); left unset,
 * one is generated per server process. Its `source` tells the logger whether
 * printing it is safe: a generated token must be shown once so it can be
 * paired; a token the user configured is a secret they already hold and
 * should never be echoed back in normal logs.
 *
 * Cached at module scope: the bridge and its tests must keep seeing the same
 * value for the lifetime of the process, not a fresh one per call.
 */
export type TokenSource = 'env' | 'generated';

export interface ResolvedToken {
  value: string;
  source: TokenSource;
}

let cachedToken: ResolvedToken | null = null;

export function resolveBridgeToken(env: NodeJS.ProcessEnv = process.env): ResolvedToken {
  if (cachedToken) return cachedToken;

  const fromEnv = env['SHADER_STUDIO_MCP_TOKEN'];
  cachedToken =
    fromEnv && fromEnv.length > 0
      ? { value: fromEnv, source: 'env' }
      : { value: randomBytes(24).toString('hex'), source: 'generated' };
  return cachedToken;
}

/** For tests that want a fresh token instead of whatever a prior test cached. */
export function resetBridgeTokenForTests(token?: string, source: TokenSource = 'env'): void {
  cachedToken = token ? { value: token, source } : null;
}

export function generateSessionId(): string {
  return randomUUID();
}

/**
 * Constant-time token comparison. A naive `===` leaks how many leading bytes
 * matched through response timing; `timingSafeEqual` does not, but it throws
 * if the two buffers differ in length, so a length mismatch is checked (and
 * rejected) explicitly first rather than being allowed to throw.
 */
export function tokensMatch(candidate: string, expected: string): boolean {
  const candidateBuf = Buffer.from(candidate, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}
