/**
 * The desktop handoff over HTTP, against a real Better Auth instance, with
 * throttling left on. Requests made "as the desktop" carry only
 * `Authorization: Bearer` — no cookie and no Origin, as `net.fetch` sends them.
 *
 * Each test calls from its own forwarded address, so the per-address limits
 * only ever see the requests of the test that is about them.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';

import { createNestApi, type NestApi } from '../api/bootstrap';
import type { AuditDetails, AuditEvent, Auditor } from './audit';
import { createAuth } from './auth';
import { readAuthConfig } from './auth-config';
import { DESKTOP_USER_AGENT } from './desktop-handoff';
import type { Mail, Mailer } from './mailer';

const PASSWORD = 'correct horse battery staple';

let library: ShaderLibrary;
let server: Server;
let nestApi: NestApi;
let base: string;

const outbox: Mail[] = [];
const mailer: Mailer = { send: async (mail) => void outbox.push(mail) };
const audited: { event: AuditEvent; details: AuditDetails }[] = [];
const recorder: Auditor = {
  record: (event, details = {}) => void audited.push({ event, details }),
};

/** A verified account's cookie, and one that never confirmed its address. */
let verified: string;
let unverified: string;

beforeAll(async () => {
  const repo = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repo, LOCAL_SCOPE);
  await library.init();

  const app = express();
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const auth = createAuth(
    repo.authDatabase(),
    readAuthConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
      BETTER_AUTH_URL: base,
      AUTH_TRUSTED_ORIGINS: base,
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
      // So an unverified account can hold a session at all, and be refused here.
      AUTH_REQUIRE_VERIFIED_EMAIL: '0',
      TRUST_PROXY: '1',
    }),
    mailer,
    recorder,
  );
  nestApi = await createNestApi(library, auth, recorder);
  app.use('/api', nestApi.handler);

  verified = await signUp('ada@example.test', true);
  unverified = await signUp('bob@example.test', false);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await nestApi.app.close();
  await library.close();
});

let caller = 0;
beforeEach(() => {
  caller += 1;
});

afterEach(() => {
  vi.useRealTimers();
});

// --- helpers ---------------------------------------------------------------

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.0.0.${caller}`,
      ...headers,
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

function asBrowser(cookie: string): Record<string, string> {
  return { cookie, origin: base };
}

function asDesktop(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function cookieOf(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

async function signIn(email: string): Promise<Response> {
  const response = await post(
    '/api/auth/sign-in/email',
    { email, password: PASSWORD },
    { origin: base },
  );
  expect(response.status).toBe(200);
  return response;
}

async function signUp(email: string, confirm: boolean): Promise<string> {
  const created = await post(
    '/api/auth/sign-up/email',
    { email, name: email.split('@')[0], password: PASSWORD },
    { origin: base },
  );
  expect(created.status).toBe(200);
  if (!confirm) return cookieOf(created);

  const link = new URL(outbox.at(-1)!.link);
  expect(
    (await fetch(`${base}${link.pathname}${link.search}`, { redirect: 'manual' })).status,
  ).toBeLessThan(400);
  return cookieOf(await signIn(email));
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

function requestCode(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return post('/api/desktop/handoff', body, asBrowser(cookie));
}

async function handoff(cookie: string, challenge: string): Promise<string> {
  const response = await requestCode(cookie, { codeChallenge: challenge, password: PASSWORD });
  expect(response.status).toBe(200);
  const { code } = (await response.json()) as { code: string };
  return code;
}

function exchange(code: string, codeVerifier: string): Promise<Response> {
  return post('/api/desktop/token', { code, codeVerifier });
}

async function desktopToken(): Promise<string> {
  const { verifier, challenge } = pkce();
  const response = await exchange(await handoff(verified, challenge), verifier);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function shaders(token: string): Promise<Response> {
  return fetch(`${base}/api/shaders`, { headers: asDesktop(token) });
}

const REFUSED = { error: { code: 'invalid', message: 'Invalid or expired code' } };

async function expectRefused(response: Response): Promise<void> {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(REFUSED);
}

// --- issuing a code ----------------------------------------------------------

describe('POST /api/desktop/handoff', () => {
  it('refuses anonymous and unverified callers', async () => {
    const { challenge } = pkce();
    const body = { codeChallenge: challenge, password: PASSWORD };
    expect((await post('/api/desktop/handoff', body)).status).toBe(401);
    expect((await requestCode(unverified, body)).status).toBe(401);
  });

  it('needs an S256 challenge', async () => {
    for (const codeChallenge of [
      undefined,
      'short',
      'x'.repeat(43) + '=',
      'plain verifier '.repeat(3),
    ]) {
      const response = await requestCode(verified, { codeChallenge, password: PASSWORD });
      expect(response.status).toBe(400);
    }
  });

  // A script running on the page has the cookie but not the password.
  it('needs the account password, not just the session', async () => {
    const { challenge } = pkce();
    const missing = await requestCode(verified, { codeChallenge: challenge });
    const wrong = await requestCode(verified, { codeChallenge: challenge, password: 'guess' });
    expect(missing.status).toBe(400);
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual(await missing.json());

    const right = await requestCode(verified, { codeChallenge: challenge, password: PASSWORD });
    expect(right.status).toBe(200);
    expect(right.headers.get('cache-control')).toBe('no-store');
  });
});

// --- exchanging it -----------------------------------------------------------

describe('POST /api/desktop/token', () => {
  it('issues a listed desktop session that authenticates the API', async () => {
    const { verifier, challenge } = pkce();
    const code = await handoff(verified, challenge);

    const response = await exchange(code, verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { token: string; user: Record<string, unknown> };
    expect(body.user).toEqual({ id: expect.any(String), name: 'ada', email: 'ada@example.test' });

    expect((await shaders(body.token)).status).toBe(200);

    const sessions = (await (
      await fetch(`${base}/api/auth/list-sessions`, { headers: asBrowser(verified) })
    ).json()) as { userAgent: string }[];
    expect(sessions.map((session) => session.userAgent)).toContain(DESKTOP_USER_AGENT);

    const issued = audited.filter((entry) => entry.event === 'desktop.signed-in');
    expect(issued.at(-1)?.details.userId).toBe(body.user['id']);
    // Neither credential ever reaches the audit trail.
    expect(JSON.stringify(audited)).not.toContain(code);
    expect(JSON.stringify(audited)).not.toContain(body.token);
  });

  it('accepts a code only once', async () => {
    const { verifier, challenge } = pkce();
    const code = await handoff(verified, challenge);
    expect((await exchange(code, verifier)).status).toBe(200);
    await expectRefused(await exchange(code, verifier));
  });

  it('burns the code on a wrong verifier', async () => {
    const { verifier, challenge } = pkce();
    const code = await handoff(verified, challenge);
    await expectRefused(await exchange(code, pkce().verifier));
    await expectRefused(await exchange(code, verifier));
  });

  it('refuses a code after 60 seconds', async () => {
    const { verifier, challenge } = pkce();
    const code = await handoff(verified, challenge);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    await expectRefused(await exchange(code, verifier));
  });

  it('answers malformed input with the same refusal', async () => {
    await expectRefused(await post('/api/desktop/token', {}));
    await expectRefused(await exchange('a'.repeat(43), pkce().verifier));
  });
});

// --- the bearer session afterwards ----------------------------------------------

describe('desktop bearer session', () => {
  it('stops working once revoked from the web', async () => {
    const token = await desktopToken();
    // Revoking needs a fresh sign-in, which the browser has just done.
    const fresh = cookieOf(await signIn('ada@example.test'));
    const revoked = await post('/api/auth/revoke-session', { token }, asBrowser(fresh));
    expect(revoked.status).toBe(200);
    expect((await shaders(token)).status).toBe(401);
    verified = fresh;
  });

  it('cannot hand off to another desktop', async () => {
    const response = await post(
      '/api/desktop/handoff',
      { codeChallenge: pkce().challenge, password: PASSWORD },
      asDesktop(await desktopToken()),
    );
    expect(response.status).toBe(401);
  });

  it('signs out with only the bearer header, and no origin', async () => {
    const token = await desktopToken();
    const signedOut = await post('/api/auth/sign-out', {}, asDesktop(token));
    expect(signedOut.status).toBe(200);
    expect((await shaders(token)).status).toBe(401);
  });

  it('leaves the browser session cookie-only and origin-checked', async () => {
    const response = await signIn('ada@example.test');
    // A readable copy of the token would undo the point of an HttpOnly cookie.
    expect(response.headers.get('set-auth-token')).toBeNull();
    verified = cookieOf(response);

    const forged = await post(
      '/api/auth/sign-out',
      {},
      { cookie: verified, origin: 'https://evil.example' },
    );
    expect(forged.status).toBe(403);
  });
});

describe('rate limit', () => {
  it('counts failed password guesses against the handoff budget', async () => {
    const { challenge } = pkce();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      statuses.push(
        (await requestCode(verified, { codeChallenge: challenge, password: 'guess' })).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Even the right password waits out the window once the guesses spent it.
    const right = await requestCode(verified, { codeChallenge: challenge, password: PASSWORD });
    expect(right.status).toBe(429);
  });

  it('throttles guessing at codes', async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 15; attempt += 1) {
      statuses.push((await exchange('a'.repeat(43), pkce().verifier)).status);
    }
    expect(statuses).toContain(429);
  });
});
