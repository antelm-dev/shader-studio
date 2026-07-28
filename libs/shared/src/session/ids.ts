/**
 * Branded session identities. Never Electron BrowserWindow / webContents ids.
 */

/** One authoritative workspace draft session. */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** One connected renderer (or in-process surface host). */
export type SessionClientId = string & { readonly __brand: 'SessionClientId' };

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asSessionClientId(value: string): SessionClientId {
  return value as SessionClientId;
}

let sessionSeq = 0;
let clientSeq = 0;

/** Allocate a fresh session id (tests / in-process brokers). */
export function createSessionId(prefix = 'session'): SessionId {
  sessionSeq += 1;
  return asSessionId(`${prefix}:${sessionSeq}:${Date.now().toString(36)}`);
}

/** Allocate a fresh client id before hello negotiation completes. */
export function createSessionClientId(prefix = 'client'): SessionClientId {
  clientSeq += 1;
  return asSessionClientId(`${prefix}:${clientSeq}:${Date.now().toString(36)}`);
}

/** Test-only: reset id counters for deterministic suites. */
export function resetSessionIdCounters(): void {
  sessionSeq = 0;
  clientSeq = 0;
}
