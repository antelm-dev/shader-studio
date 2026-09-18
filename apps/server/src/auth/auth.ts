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
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import type { AuthDatabase } from '@shader-studio/backend/persistence';

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

export function createAuth(database: AuthDatabase, config: AuthConfig, mailer?: Mailer) {
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

    session: {
      expiresIn: config.sessionMaxSeconds,
      // Sliding idle window: an active session is extended, an abandoned one
      // reaches `expiresIn` and dies.
      updateAge: config.sessionIdleSeconds,
      // No cookie cache: a revoked session must stop working on the next
      // request, not when a cached copy happens to expire.
      cookieCache: { enabled: false },
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
    },

    // Enabled in development too, so a limit that is wrong is found before it
    // reaches production. The defaults are loose; the credential endpoints are
    // not, because those are the ones worth guessing at.
    rateLimit: {
      enabled: true,
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
  });
}

/**
 * The session behind a request, or `null`. Headers are passed through as-is so
 * Better Auth reads the cookie itself — the raw session id is never copied into
 * a variable of ours, let alone a log line.
 */
export async function resolvePrincipal(auth: Auth, headers: Headers): Promise<Principal | null> {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) return null;
  return {
    userId: session.user.id,
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  };
}
