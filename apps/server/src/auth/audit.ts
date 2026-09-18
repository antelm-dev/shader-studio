/**
 * A one-line-per-event record of the things worth being able to reconstruct
 * after the fact: who signed in, who failed to, who reset a password, who
 * revoked a session, and who deleted a shader.
 *
 * What is deliberately *not* here is as much the point as what is. An audit
 * line never carries a cookie, a password, a reset or verification token, or a
 * session id — those are the credentials the log would otherwise turn into a
 * second place to steal them from. A user id identifies the actor without being
 * usable to become them; an email address appears only on sign-in failure,
 * where there may be no user id to name and an operator investigating a
 * password-spraying run has nothing else to correlate on.
 *
 * Output goes to stdout as JSON so a log shipper can index it. It is not a
 * tamper-evident audit trail: a deployment that needs one should ship these
 * lines somewhere append-only.
 */

export type AuditEvent =
  | 'sign-in.success'
  | 'sign-in.failure'
  | 'sign-up'
  | 'sign-out'
  | 'password-reset.requested'
  | 'password-reset.completed'
  | 'session.revoked'
  | 'sessions.revoked-all'
  | 'shader.deleted';

export interface AuditDetails {
  /** The acting account, when one is known. */
  userId?: string;
  /** Only on sign-in failure, where there may be no user id to name. */
  email?: string;
  /** The resource acted on — a shader id, never a session id. */
  subject?: string;
  ip?: string;
  userAgent?: string;
}

export interface Auditor {
  record(event: AuditEvent, details?: AuditDetails): void;
}

export const consoleAuditor: Auditor = {
  record(event, details = {}) {
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        channel: 'audit',
        event,
        ...details,
      }),
    );
  },
};

/** Drops everything. Used by tests, which assert on their own recorder. */
export const silentAuditor: Auditor = { record: () => undefined };

/**
 * The request attributes worth attaching to an event.
 *
 * The client IP is read from `x-forwarded-for` only when the deployment says it
 * is behind a proxy it controls. Trusting that header unconditionally would let
 * any caller forge the address that per-IP throttling and this log both key on.
 */
export function requestContext(
  headers: Headers,
  options: { trustProxy: boolean },
): Pick<AuditDetails, 'ip' | 'userAgent'> {
  const forwarded = options.trustProxy ? headers.get('x-forwarded-for') : null;
  const ip = forwarded?.split(',')[0]?.trim();
  const userAgent = headers.get('user-agent');
  return {
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}),
  };
}

/** Maps a Better Auth endpoint path to the event it represents, if any. */
export function eventForPath(path: string, ok: boolean): AuditEvent | null {
  switch (path) {
    case '/sign-in/email':
      return ok ? 'sign-in.success' : 'sign-in.failure';
    case '/sign-up/email':
      return ok ? 'sign-up' : null;
    case '/sign-out':
      return ok ? 'sign-out' : null;
    case '/request-password-reset':
      // Recorded whatever the outcome: the endpoint answers identically for a
      // known and an unknown address, and so does this line.
      return 'password-reset.requested';
    case '/reset-password':
      return ok ? 'password-reset.completed' : null;
    case '/revoke-session':
      return ok ? 'session.revoked' : null;
    case '/revoke-sessions':
    case '/revoke-other-sessions':
      return ok ? 'sessions.revoked-all' : null;
    default:
      return null;
  }
}
