/**
 * Workspace session wire protocol version.
 *
 * Bump on breaking envelope / command / event changes. Negotiation rejects
 * incompatible peers with `PROTOCOL_MISMATCH` rather than silently degrading.
 */
export const SESSION_PROTOCOL_VERSION = 1 as const;

export type SessionProtocolVersion = typeof SESSION_PROTOCOL_VERSION;

/** Versions this process can speak. */
export const SUPPORTED_SESSION_PROTOCOL_VERSIONS: readonly SessionProtocolVersion[] = [
  SESSION_PROTOCOL_VERSION,
];

export type ProtocolNegotiationResult =
  | { ok: true; version: SessionProtocolVersion }
  | { ok: false; reason: 'PROTOCOL_MISMATCH'; requested: number; supported: readonly number[] };

export function negotiateSessionProtocol(requested: number): ProtocolNegotiationResult {
  if (
    Number.isInteger(requested) &&
    (SUPPORTED_SESSION_PROTOCOL_VERSIONS as readonly number[]).includes(requested)
  ) {
    return { ok: true, version: requested as SessionProtocolVersion };
  }
  return {
    ok: false,
    reason: 'PROTOCOL_MISMATCH',
    requested,
    supported: SUPPORTED_SESSION_PROTOCOL_VERSIONS,
  };
}
