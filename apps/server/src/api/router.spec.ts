/**
 * REST tests for the NestJS shader API, driven against a real `ShaderLibrary`
 * and a real Better Auth instance, both backed by one in-memory SQLite
 * database. The router is mounted on a live express server and exercised over
 * HTTP, so request parsing, session cookies, status-code mapping and the error
 * envelope are all covered end-to-end without a filesystem or Postgres.
 *
 * Two users sign up here on purpose: most of the authorization claims worth
 * making are claims about what the *second* user cannot see.
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';

import { createAuth } from '../auth/auth';
import { readAuthConfig } from '../auth/auth-config';
import type { Mail, Mailer } from '../auth/mailer';
import { createNestApi, type NestApi } from './bootstrap';

const PASSWORD = 'correct horse battery staple';

let library: ShaderLibrary;
let server: Server;
let base: string;
let nestApi: NestApi;

/** Every link the server would have emailed, newest last. */
const outbox: Mail[] = [];
const mailer: Mailer = {
  send: async (mail) => {
    outbox.push(mail);
  },
};

interface TestUser {
  email: string;
  /** The `Cookie` header value for this user's session. */
  cookie: string;
}

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  const repo = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repo, LOCAL_SCOPE);
  await library.init();

  // Listen first: the port is part of the trusted origin, and Better Auth
  // rejects a cookie-authenticated POST whose Origin is not on that list.
  const app = express();
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;

  const auth = createAuth(
    repo.authDatabase(),
    readAuthConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
      BETTER_AUTH_URL: base,
      AUTH_TRUSTED_ORIGINS: base,
    }),
    mailer,
  );
  nestApi = await createNestApi(library, auth);
  app.use('/api', nestApi.handler);

  alice = await signUp('alice@example.test', 'Alice');
  bob = await signUp('bob@example.test', 'Bob');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await nestApi.app.close();
  await library.close();
});

// --- helpers ---------------------------------------------------------------

function authFetch(user: TestUser | null, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('origin', base);
  if (user) headers.set('cookie', user.cookie);
  return fetch(`${base}${path}`, { ...init, headers, redirect: 'manual' });
}

function postJson(
  user: TestUser | null,
  path: string,
  body: unknown,
  method = 'POST',
): Promise<Response> {
  return authFetch(user, path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Signs up, completes verification from the captured email, and signs in. */
async function signUp(email: string, name: string): Promise<TestUser> {
  const created = await postJson(null, '/api/auth/sign-up/email', {
    email,
    name,
    password: PASSWORD,
  });
  expect(created.status).toBe(200);

  const verification = outbox.at(-1);
  expect(verification?.to).toBe(email);
  const verified = await authFetch(null, pathOf(verification!.link));
  expect(verified.status).toBeLessThan(400);

  const signedIn = await postJson(null, '/api/auth/sign-in/email', { email, password: PASSWORD });
  expect(signedIn.status).toBe(200);
  return { email, cookie: cookieHeader(signedIn) };
}

/** The path + query of an absolute link, so it can be replayed against `base`. */
function pathOf(link: string): string {
  const url = new URL(link);
  return `${url.pathname}${url.search}`;
}

/** The reset token, wherever Better Auth put it — query parameter or last path segment. */
function resetTokenFrom(link: string): string {
  const url = new URL(link);
  const token = url.searchParams.get('token') ?? url.pathname.split('/').at(-1);
  expect(token).toBeTruthy();
  return token!;
}

function cookieHeader(response: Response): string {
  const cookies = response.headers.getSetCookie();
  expect(cookies.length).toBeGreaterThan(0);
  return cookies.map((cookie) => cookie.split(';')[0]).join('; ');
}

async function createShader(user: TestUser, name: string): Promise<string> {
  const response = await postJson(user, '/api/shaders', { name });
  expect(response.status).toBe(201);
  const { shader } = (await response.json()) as { shader: { id: string } };
  return shader.id;
}

async function reset(): Promise<void> {
  for (const user of [alice, bob]) {
    const list = (await (await authFetch(user, '/api/shaders')).json()) as {
      shaders: { id: string }[];
    };
    for (const shader of list.shaders) {
      await authFetch(user, `/api/shaders/${shader.id}`, { method: 'DELETE' });
    }
  }
}

beforeEach(reset);

// --- the original API surface, now behind a session -------------------------

describe('shader REST API', () => {
  it('lists, creates and reads shaders', async () => {
    expect(await (await authFetch(alice, '/api/shaders')).json()).toEqual({ shaders: [] });

    const created = await postJson(alice, '/api/shaders', { name: 'Rest Demo' });
    expect(created.status).toBe(201);
    const { shader } = (await created.json()) as { shader: { id: string; revision: number } };
    expect(shader.id).toBe('rest-demo');
    expect(shader.revision).toBe(1);

    expect((await authFetch(alice, `/api/shaders/${shader.id}`)).status).toBe(200);
  });

  it('bumps the revision on update and rejects a stale expectedRevision with 409', async () => {
    const id = await createShader(alice, 'Contended');

    const first = await postJson(
      alice,
      `/api/shaders/${id}`,
      { name: 'Once', expectedRevision: 1 },
      'PUT',
    );
    expect(first.status).toBe(200);

    const stale = await postJson(
      alice,
      `/api/shaders/${id}`,
      { name: 'Twice', expectedRevision: 1 },
      'PUT',
    );
    expect(stale.status).toBe(409);
  });

  it('404s an unknown shader and 400s an invalid body', async () => {
    expect((await authFetch(alice, '/api/shaders/nope')).status).toBe(404);

    const malformed = await authFetch(alice, '/api/shaders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    expect(malformed.status).toBe(400);
  });

  it('serves translations without a session', async () => {
    expect((await fetch(`${base}/api/i18n/en`)).status).toBe(200);
  });
});

// --- authentication ---------------------------------------------------------

describe('authentication', () => {
  const PROTECTED: readonly [string, string][] = [
    ['GET', '/api/shaders'],
    ['POST', '/api/shaders'],
    ['GET', '/api/shaders/anything'],
    ['PUT', '/api/shaders/anything'],
    ['DELETE', '/api/shaders/anything'],
    ['POST', '/api/shaders/anything/duplicate'],
    ['GET', '/api/shaders/anything/presets'],
    ['POST', '/api/shaders/anything/presets'],
    ['DELETE', '/api/shaders/anything/presets/p'],
    ['GET', '/api/shaders/anything/textures/0'],
    ['PUT', '/api/shaders/anything/textures/0'],
    ['DELETE', '/api/shaders/anything/textures/0'],
    ['GET', '/api/shaders/anything/thumbnail'],
    ['PUT', '/api/shaders/anything/thumbnail'],
    ['GET', '/api/shaders/anything/export'],
    ['GET', '/api/export'],
    ['POST', '/api/import'],
    ['POST', '/api/import/shadertoy'],
  ];

  it('rejects every protected endpoint without a session', async () => {
    for (const [method, path] of PROTECTED) {
      const response = await authFetch(null, path, { method });
      // Formatted into the assertion so a failure names the offending route.
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 401`);
    }
  });

  it('stops accepting a session after sign-out', async () => {
    const throwaway = await signUp('gone@example.test', 'Gone');
    expect((await authFetch(throwaway, '/api/shaders')).status).toBe(200);

    expect((await authFetch(throwaway, '/api/auth/sign-out', { method: 'POST' })).status).toBe(200);

    // The cookie value is still in hand; the session row behind it is not.
    expect((await authFetch(throwaway, '/api/shaders')).status).toBe(401);
  });

  it('rejects a forged session token', async () => {
    const forged: TestUser = { email: 'x', cookie: alice.cookie.replace(/=[^;]*/, '=forged') };
    expect((await authFetch(forged, '/api/shaders')).status).toBe(401);
  });

  it('sets HttpOnly, SameSite session cookies', async () => {
    const response = await postJson(null, '/api/auth/sign-in/email', {
      email: alice.email,
      password: PASSWORD,
    });
    const cookie = response.headers.getSetCookie().join('; ').toLowerCase();
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('samesite=lax');
    expect(cookie).toContain('path=/');
  });

  it('never caches a session response', async () => {
    const response = await authFetch(alice, '/api/auth/get-session');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a cookie-authenticated mutation from an untrusted origin', async () => {
    const response = await fetch(`${base}/api/auth/sign-out`, {
      method: 'POST',
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
      redirect: 'manual',
    });
    expect(response.status).toBeGreaterThanOrEqual(400);

    // …and the session it tried to destroy still works.
    expect((await authFetch(alice, '/api/shaders')).status).toBe(200);
  });

  it('grants no session from an unverified sign-up', async () => {
    const created = await postJson(null, '/api/auth/sign-up/email', {
      email: 'unverified@example.test',
      name: 'Unverified',
      password: PASSWORD,
    });
    expect(created.status).toBe(200);
    // No Set-Cookie: signing up does not sign you in while verification is
    // required, so an address someone else owns cannot be used to get a session.
    expect(created.headers.getSetCookie()).toEqual([]);
  });

  it('burns a password-reset token after one use', async () => {
    await postJson(null, '/api/auth/request-password-reset', {
      email: bob.email,
      redirectTo: `${base}/reset-password`,
    });
    const token = resetTokenFrom(outbox.at(-1)!.link);

    const first = await postJson(null, '/api/auth/reset-password', {
      token,
      newPassword: 'a different correct horse',
    });
    expect(first.status).toBe(200);

    const replayed = await postJson(null, '/api/auth/reset-password', {
      token,
      newPassword: 'a third correct horse',
    });
    expect(replayed.status).toBeGreaterThanOrEqual(400);

    // Bob's cookie survives the suite: re-establish it on the new password.
    const signedIn = await postJson(null, '/api/auth/sign-in/email', {
      email: bob.email,
      password: 'a different correct horse',
    });
    expect(signedIn.status).toBe(200);
    bob = { email: bob.email, cookie: cookieHeader(signedIn) };
  });

  it('answers a password reset for an unknown address exactly as for a known one', async () => {
    const known = await postJson(null, '/api/auth/request-password-reset', {
      email: alice.email,
      redirectTo: `${base}/reset-password`,
    });
    const unknown = await postJson(null, '/api/auth/request-password-reset', {
      email: 'nobody@example.test',
      redirectTo: `${base}/reset-password`,
    });

    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });
});

// --- authorization ----------------------------------------------------------

describe('authorization', () => {
  it('shows each user only their own library', async () => {
    await createShader(alice, 'Alice Shader');
    await createShader(bob, 'Bob Shader');

    const mine = (await (await authFetch(alice, '/api/shaders')).json()) as {
      shaders: { name: string }[];
    };
    expect(mine.shaders.map((entry) => entry.name)).toEqual(['Alice Shader']);
  });

  it('404s another user’s shader on every verb and nested resource', async () => {
    const id = await createShader(alice, 'Private');
    // Bodies are valid on purpose: a request rejected as malformed would prove
    // nothing about ownership, because it never reaches the ownership check.
    const targets: readonly [string, string, unknown?][] = [
      ['GET', `/api/shaders/${id}`],
      ['PUT', `/api/shaders/${id}`, { name: 'Stolen' }],
      ['DELETE', `/api/shaders/${id}`],
      ['POST', `/api/shaders/${id}/duplicate`, {}],
      ['GET', `/api/shaders/${id}/presets`],
      ['POST', `/api/shaders/${id}/presets`, { name: 'Nope', values: {} }],
      ['DELETE', `/api/shaders/${id}/presets/anything`],
      ['GET', `/api/shaders/${id}/textures/0`],
      ['DELETE', `/api/shaders/${id}/textures/0`],
      ['GET', `/api/shaders/${id}/thumbnail`],
      ['GET', `/api/shaders/${id}/export`],
    ];

    for (const [method, path, body] of targets) {
      const response =
        body === undefined
          ? await authFetch(bob, path, { method })
          : await postJson(bob, path, body, method);
      expect(`${method} ${path} → ${response.status}`).toBe(`${method} ${path} → 404`);
    }

    // Alice's shader came through all of that unchanged.
    expect((await authFetch(alice, `/api/shaders/${id}`)).status).toBe(200);
  });

  it('keeps exportAll inside one library', async () => {
    await createShader(alice, 'Alice Shader');
    await createShader(bob, 'Bob Shader');

    const bundle = (await (await authFetch(bob, '/api/export')).json()) as {
      shaders: { name: string }[];
    };
    expect(bundle.shaders.map((entry) => entry.name)).toEqual(['Bob Shader']);
  });

  it('assigns the signed-in user as owner whatever the body claims', async () => {
    const response = await postJson(alice, '/api/shaders', {
      name: 'Claimed',
      ownerUserId: 'bob',
      owner: 'bob',
    });
    expect(response.status).toBe(201);
    const { shader } = (await response.json()) as { shader: { id: string } };

    expect((await authFetch(bob, `/api/shaders/${shader.id}`)).status).toBe(404);
    expect((await authFetch(alice, `/api/shaders/${shader.id}`)).status).toBe(200);
  });

  it('marks an authenticated shader asset as privately cacheable', async () => {
    const id = await createShader(alice, 'Textured');
    await authFetch(alice, `/api/shaders/${id}/thumbnail`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    const response = await authFetch(alice, `/api/shaders/${id}/thumbnail`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
  });
});
