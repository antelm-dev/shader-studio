/**
 * Everything the authentication layer reads from the environment, validated
 * once at startup rather than at the first request.
 *
 * Production refuses to start without a real secret and a real origin: a server
 * that silently falls back to a development key would issue sessions anyone
 * holding the source could forge. Development gets loud warnings and usable
 * defaults instead, because the cost of a wrong guess there is a restart.
 */

export type RegistrationMode = 'open' | 'invite-only';

export interface MailConfig {
  /** An SMTP URL, e.g. `smtp://user:pass@host:587`. Absent in development. */
  readonly url: string | undefined;
  readonly from: string;
}

export interface AuthConfig {
  readonly secret: string;
  /** Absolute origin the server is reached at, e.g. `https://shaders.example`. */
  readonly baseUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly registration: RegistrationMode;
  readonly requireEmailVerification: boolean;
  readonly mail: MailConfig;
  readonly production: boolean;
  /** Seconds a session survives without use, and its hard ceiling. */
  readonly sessionIdleSeconds: number;
  readonly sessionMaxSeconds: number;
}

/** Only ever used when NODE_ENV is not production — see `assertProductionReady`. */
const DEV_SECRET = 'shader-studio-development-secret-do-not-deploy';
const DEV_BASE_URL = 'http://localhost:4000';

export class AuthConfigError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `Refusing to start: ${missing.join(', ')} must be set in production.\n` +
        'Generate a secret with `openssl rand -base64 32` and set BETTER_AUTH_URL to the ' +
        'origin browsers reach this server at.',
    );
    this.name = 'AuthConfigError';
  }
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env['NODE_ENV'] === 'production';
  const secret = env['BETTER_AUTH_SECRET']?.trim();
  const baseUrl = env['BETTER_AUTH_URL']?.trim();
  const mailUrl = env['MAIL_SMTP_URL']?.trim() || undefined;

  const missing: string[] = [];
  if (!secret) missing.push('BETTER_AUTH_SECRET');
  if (!baseUrl) missing.push('BETTER_AUTH_URL');
  // Without a mail provider nobody can verify an address or recover an account,
  // so a production deployment that omits it is misconfigured, not minimal.
  if (!mailUrl) missing.push('MAIL_SMTP_URL');
  if (production && missing.length > 0) throw new AuthConfigError(missing);

  if (missing.length > 0) {
    console.warn(
      `[auth] ${missing.join(', ')} not set — using development defaults. ` +
        'Verification and password-reset links will be printed to this console.',
    );
  }

  const resolvedBaseUrl = baseUrl || DEV_BASE_URL;
  return {
    secret: secret || DEV_SECRET,
    baseUrl: resolvedBaseUrl,
    trustedOrigins: trustedOrigins(env, resolvedBaseUrl, production),
    registration: env['AUTH_REGISTRATION'] === 'invite-only' ? 'invite-only' : 'open',
    // Turning this off is a deliberate choice for a private deployment, not a
    // default: unverified addresses make password reset an account-takeover.
    requireEmailVerification: env['AUTH_REQUIRE_VERIFIED_EMAIL'] !== '0',
    mail: { url: mailUrl, from: env['MAIL_FROM']?.trim() || 'Shader Studio <no-reply@localhost>' },
    production,
    sessionIdleSeconds: positiveSeconds(env['AUTH_SESSION_IDLE_SECONDS'], 60 * 60 * 24 * 7),
    sessionMaxSeconds: positiveSeconds(env['AUTH_SESSION_MAX_SECONDS'], 60 * 60 * 24 * 30),
  };
}

/**
 * The origins allowed to drive a cookie-authenticated request. The deployed
 * origin is always included; development adds the Angular dev server, which
 * runs on a different port from the API.
 */
function trustedOrigins(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  production: boolean,
): readonly string[] {
  const configured = (env['AUTH_TRUSTED_ORIGINS'] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const origins = new Set([baseUrl, ...configured]);
  if (!production) {
    origins.add('http://localhost:4200');
    origins.add('http://127.0.0.1:4200');
    origins.add('http://localhost:4000');
  }
  return [...origins];
}

function positiveSeconds(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}
