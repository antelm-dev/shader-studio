/**
 * The Better Auth instance, built over the same database the shaders live in.
 *
 * Sessions are opaque rows in that database, delivered in an `HttpOnly`
 * cookie — the browser never holds a token it could leak to a script, and a
 * revoked session stops working immediately rather than when a JWT happens to
 * expire. Nothing here ever returns a password hash, a reset token or a session
 * id to a caller, and nothing logs one.
 */

import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { haveIBeenPwned } from 'better-auth/plugins';

import type { AuthDatabase } from '@shader-studio/backend/persistence';

import { consoleAuditor, eventForPath, requestContext, type Auditor } from './audit';
import { type AuthConfig } from './auth-config';
import { createMailer, type Mailer } from './mailer';

/** What a request is allowed to act as, once a session has been resolved. */
export interface Principal {
  readonly userId: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

// Inferred rather than `ReturnType<typeof betterAuth>`: Better Auth threads the
// concrete options through its own types, and the unparameterised alias loses
// them (and then disagrees with itself about `secret`).
export type Auth = ReturnType<typeof createAuth>;

export function createAuth(
  database: AuthDatabase,
  config: AuthConfig,
  mailer?: Mailer,
  auditor: Auditor = consoleAuditor,
) {
  const mail: Mailer = mailer ?? createMailer(config.mail);

  return betterAuth({
    secret: config.secret,
    baseURL: config.baseUrl,
    // The path as a *browser* sees it. Better Auth routes on the full request
    // URL and builds email links from it, so it has to be the public path, not
    // the one left after Express strips the `/api` mount — which is why the
    // mount in `bootstrap.ts` restores `req.originalUrl` before handing over.
    basePath: '/api/auth',
    // Only these origins may drive a cookie-authenticated mutation. Better Auth
    // checks Origin against this list, which is what stops a third-party page
    // from riding along on the session cookie.
    trustedOrigins: [...config.trustedOrigins],

    database: drizzleAdapter(database.db, {
      provider: database.provider,
      // Our tables are `users`/`sessions`/…, not Better Auth's singular default.
      usePlural: true,
      // The SQLite development driver is a proxy over one synchronous
      // connection and cannot nest a transaction inside the one a shader write
      // may already hold.
      transaction: database.provider === 'pg',
    }),

    emailAndPassword: {
      enabled: true,
      // A private deployment closes the door without turning off sign-in.
      disableSignUp: config.registration === 'invite-only',
      requireEmailVerification: config.requireEmailVerification,
      // OWASP's floor. There is no maximum below 128 and no character-class
      // rule: both push people towards worse passwords and break password
      // managers, which is the opposite of what they are for.
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 15,
      // A reset is a privilege change: whoever prompted it may be the reason
      // the account needed recovering, so every other session goes with it.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mail.send({
          to: user.email,
          subject: 'Reset your Shader Studio password',
          text:
            `Open this link within 15 minutes to choose a new password:\n\n${url}\n\n` +
            'If you did not ask for this, nothing has changed and you can ignore this email.',
          link: url,
        });
      },
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await mail.send({
          to: user.email,
          subject: 'Confirm your Shader Studio address',
          text: `Confirm this address to finish setting up your library:\n\n${url}`,
          link: url,
        });
      },
    },

    // Better Auth has no idle timeout or absolute lifetime of its own: it only
    // pushes `expiresAt` to now + `expiresIn` once `updateAge` has passed since
    // the last push. So `expiresIn` *is* the idle window, `updateAge` stays well
    // inside it so activity keeps sliding it (at `updateAge === expiresIn` the
    // refresh would only fall due once the session had already expired), and
    // the hard ceiling is enforced by
    // the `databaseHooks` below, which never let a refresh reach past
    // `createdAt + sessionMaxSeconds`.
    session: {
      expiresIn: Math.min(config.sessionIdleSeconds, config.sessionMaxSeconds),
      updateAge: refreshAge(config.sessionIdleSeconds),
      // No cookie cache: a revoked session must stop working on the next
      // request, not when a cached copy happens to expire.
      cookieCache: { enabled: false },
      // Better Auth itself only checks this on `/list-sessions` and
      // `/unlink-account`. The revocation routes are held to it by the `before`
      // hook below; changing a password needs the current one anyway.
      freshAge: FRESH_SECONDS,
    },

    databaseHooks: {
      session: {
        update: {
          // The only write that moves `expiresAt` is the refresh in
          // `getSession`, which has already put the session on the context.
          before: async (data, ctx) => {
            const createdAt = ctx?.context.session?.session.createdAt;
            if (!data.expiresAt || !createdAt) return;
            return {
              data: {
                ...data,
                expiresAt: capExpiry(data.expiresAt, createdAt, config.sessionMaxSeconds),
              },
            };
          },
        },
      },
    },

    advanced: {
      useSecureCookies: config.production,
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      // Both default to *off* when NODE_ENV is "test", which would quietly mean
      // the origin and CSRF checks are the one part of authentication the test
      // suite never exercises. Stated explicitly so every environment — and
      // every assertion about them — sees the same behaviour.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // `x-forwarded-*` is only believed when the deployment says it sits behind
      // a proxy it controls. Otherwise any caller could forge the address that
      // per-IP throttling and the audit log both key on.
      trustedProxyHeaders: config.trustProxy,
    },

    // Enabled in development too, so a limit that is wrong is found before it
    // reaches production. The defaults are loose; the credential endpoints are
    // not, because those are the ones worth guessing at.
    rateLimit: {
      enabled: config.rateLimits,
      window: 60,
      max: 120,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60 * 60, max: 5 },
        '/request-password-reset': { window: 60 * 60, max: 5 },
        '/reset-password': { window: 60 * 60, max: 10 },
        '/send-verification-email': { window: 60 * 60, max: 5 },
      },
    },

    logger: {
      // Better Auth logs request paths and errors; its own output never
      // includes token values, and we do not add any.
      level: config.production ? 'warn' : 'info',
    },

    // Rejects a password already known to have leaked. Only the first five
    // characters of its SHA-1 hash leave this process, so the service never
    // learns the password or which account it belongs to.
    //
    // It fails closed: an unreachable service refuses the sign-up rather than
    // waving a possibly-breached password through. See `checkCompromisedPasswords`.
    plugins: [
      haveIBeenPwned({
        enabled: config.checkCompromisedPasswords,
        customPasswordCompromisedMessage:
          'That password appears in a known breach. Please choose a different one.',
      }),
    ],

    // The audit half of the `after` hook is observation only — it never
    // changes an outcome, so a bug in the audit trail cannot become a bug in
    // authentication.
    hooks: {
      // Revoking sessions needs a recent sign-in, so an old session left on a
      // borrowed device cannot sign the owner out of everything else. The
      // client answers SESSION_NOT_FRESH by asking for the password again.
      before: createAuthMiddleware(async (ctx) => {
        if (!FRESH_ONLY.has(ctx.path)) return;
        const session = await getSessionFromCtx(ctx);
        if (session && !isFresh(session.session.createdAt)) {
          throw new APIError('FORBIDDEN', {
            code: 'SESSION_NOT_FRESH',
            message: 'Confirm your password to continue.',
          });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const returned = ctx.context.returned;

        // Signing in over an existing session (re-confirming a password, or
        // just signing in again) replaces the cookie; the session it named
        // would otherwise linger as a phantom device until its idle expiry.
        if (ctx.path === '/sign-in/email' && !(returned instanceof APIError)) {
          const previous = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          const current = ctx.context.newSession?.session.token;
          if (previous && current && previous !== current) {
            await ctx.context.internalAdapter.deleteSession(previous);
          }
        }

        const event = eventForPath(ctx.path, !(returned instanceof APIError));
        if (!event) return;

        auditor.record(event, {
          // On sign-in the session is only established by this very request, so
          // the id comes from what the endpoint returned rather than from the
          // (still anonymous) incoming context.
          ...userIdOf(ctx.context.session?.user.id ?? actorFrom(returned)),
          // Only on failure, and only because there is no user id to name: an
          // operator looking at a password-spraying run has nothing else to
          // correlate attempts on.
          ...(event === 'sign-in.failure' ? emailOf(emailFrom(ctx.body)) : {}),
          ...requestContext(ctx.request?.headers ?? new Headers(), {
            trustProxy: config.trustProxy,
          }),
        });
      }),
    },
  });
}

/** How often an active session's idle window is slid forward, at most. */
const SESSION_REFRESH_SECONDS = 60 * 60;

/** How long after signing in a session may still revoke others. */
const FRESH_SECONDS = 60 * 15;
const FRESH_ONLY = new Set(['/revoke-session', '/revoke-sessions', '/revoke-other-sessions']);

/**
 * Half the idle window, capped at an hour: any request in the second half of
 * the window slides it, so a user who keeps working is never signed out.
 */
export function refreshAge(idleSeconds: number): number {
  return Math.max(1, Math.min(Math.floor(idleSeconds / 2), SESSION_REFRESH_SECONDS));
}

function isFresh(createdAt: Date): boolean {
  return Date.now() - new Date(createdAt).getTime() < FRESH_SECONDS * 1000;
}

/** `expiresAt`, pulled back so it never passes the session's absolute lifetime. */
export function capExpiry(expiresAt: Date, createdAt: Date, maxSeconds: number): Date {
  const ceiling = new Date(createdAt).getTime() + maxSeconds * 1000;
  return new Date(Math.min(new Date(expiresAt).getTime(), ceiling));
}

/**
 * The session behind a request, or `null`. Headers are passed through as-is so
 * Better Auth reads the cookie itself — the raw session id is never copied into
 * a variable of ours, let alone a log line.
 */
/** The address a sign-in was attempted for, when the body carried one. */
function emailFrom(body: unknown): string | undefined {
  const email = (body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' ? email : undefined;
}

/** The account an endpoint just acted on, from whatever it handed back. */
function actorFrom(returned: unknown): string | undefined {
  const id = (returned as { user?: { id?: unknown } } | undefined)?.user?.id;
  return typeof id === 'string' ? id : undefined;
}

// Two shims so the audit call can spread conditionally without `exactOptional`
// complaints about an explicit `undefined`.
function userIdOf(userId: string | undefined): { userId?: string } {
  return userId ? { userId } : {};
}

function emailOf(email: string | undefined): { email?: string } {
  return email ? { email } : {};
}

export async function resolvePrincipal(auth: Auth, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  };
}
