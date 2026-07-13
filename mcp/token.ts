import { randomBytes, randomUUID } from 'node:crypto';

/**
 * The shared secret the browser tab must present in its handshake.
 *
 * `127.0.0.1` is not an authentication boundary — any local process (or, on a
 * shared machine, another local user) can open a socket to it. `SHADER_STUDIO_MCP_TOKEN`
 * lets a developer pin a token across the two independently-started processes
 * (the MCP server and `ng serve`); left unset, one is generated per bridge
 * process and printed once so it can be copied into the browser.
 *
 * Cached at module scope: the bridge and its tests must keep seeing the same
 * value for the lifetime of the process, not a fresh one per call.
 */
let cachedToken: string | null = null;

export function resolveBridgeToken(): string {
  if (cachedToken) return cachedToken;

  const fromEnv = process.env['SHADER_STUDIO_MCP_TOKEN'];
  cachedToken = fromEnv && fromEnv.length > 0 ? fromEnv : randomBytes(24).toString('hex');
  return cachedToken;
}

/** For tests that want a fresh token instead of whatever a prior test cached. */
export function resetBridgeTokenForTests(token?: string): void {
  cachedToken = token ?? null;
}

export function generateSessionId(): string {
  return randomUUID();
}
