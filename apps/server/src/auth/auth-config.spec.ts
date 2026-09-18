/**
 * The environment contract. These assertions are about *defaults*: every one of
 * them describes something that would be a security bug if it silently flipped,
 * and most of them are the kind of thing nobody notices until the day it
 * matters.
 */

import { describe, expect, it } from 'vitest';

import { AuthConfigError, readAuthConfig } from './auth-config';

const PRODUCTION = {
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: 'a-real-secret-from-openssl-rand',
  BETTER_AUTH_URL: 'https://shaders.example',
  MAIL_SMTP_URL: 'smtp://user:pass@mail.example:587',
};

describe('readAuthConfig', () => {
  it('refuses to start production without a secret, an origin or a mailer', () => {
    for (const missing of ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'MAIL_SMTP_URL']) {
      const env = { ...PRODUCTION, [missing]: '' };
      expect(() => readAuthConfig(env)).toThrow(AuthConfigError);
      // The message names what to set, because the person reading it is
      // deploying at the time.
      expect(() => readAuthConfig(env)).toThrow(missing);
    }
  });

  it('never falls back to the development secret in production', () => {
    const config = readAuthConfig(PRODUCTION);
    expect(config.secret).toBe(PRODUCTION.BETTER_AUTH_SECRET);
    expect(config.production).toBe(true);
  });

  it('starts in development with warnings instead of secrets', () => {
    const config = readAuthConfig({ NODE_ENV: 'development' });
    expect(config.production).toBe(false);
    expect(config.secret).toBeTruthy();
    // No mail provider means links go to the console, which is only ever
    // acceptable because this is not production.
    expect(config.mail.url).toBeUndefined();
  });

  it('requires a verified address and open registration by default', () => {
    const config = readAuthConfig(PRODUCTION);
    expect(config.requireEmailVerification).toBe(true);
    expect(config.registration).toBe('open');

    expect(readAuthConfig({ ...PRODUCTION, AUTH_REGISTRATION: 'invite-only' }).registration).toBe(
      'invite-only',
    );
  });

  it('checks passwords against known breaches unless told not to', () => {
    expect(readAuthConfig(PRODUCTION).checkCompromisedPasswords).toBe(true);
    expect(
      readAuthConfig({ ...PRODUCTION, AUTH_CHECK_COMPROMISED_PASSWORDS: '0' })
        .checkCompromisedPasswords,
    ).toBe(false);
  });

  it('distrusts proxy headers unless the deployment opts in', () => {
    // The default matters: a forged `x-forwarded-for` would otherwise let a
    // caller choose which bucket per-IP throttling counts them in.
    expect(readAuthConfig(PRODUCTION).trustProxy).toBe(false);
    expect(readAuthConfig({ ...PRODUCTION, TRUST_PROXY: '1' }).trustProxy).toBe(true);
  });

  it('trusts only the deployed origin in production', () => {
    const config = readAuthConfig(PRODUCTION);
    expect(config.trustedOrigins).toEqual(['https://shaders.example']);
    // The dev-server origins are a development convenience and must not leak
    // into a deployment's allowlist.
    expect(config.trustedOrigins).not.toContain('http://localhost:4200');
  });

  it('adds the Angular dev server only outside production', () => {
    const config = readAuthConfig({ NODE_ENV: 'development' });
    expect(config.trustedOrigins).toContain('http://localhost:4200');
  });

  it('bounds a session by both an idle window and a hard ceiling', () => {
    const config = readAuthConfig(PRODUCTION);
    expect(config.sessionIdleSeconds).toBeGreaterThan(0);
    expect(config.sessionMaxSeconds).toBeGreaterThan(config.sessionIdleSeconds);

    // A nonsensical override falls back rather than producing a session that
    // expires immediately — or never.
    const nonsense = readAuthConfig({ ...PRODUCTION, AUTH_SESSION_MAX_SECONDS: '-1' });
    expect(nonsense.sessionMaxSeconds).toBe(config.sessionMaxSeconds);
  });
});
