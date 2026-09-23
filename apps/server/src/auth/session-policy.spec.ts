/**
 * The session policy against a real Better Auth instance, with a sub-hour idle
 * window so the refresh arithmetic is exercised where it is easiest to get
 * wrong. Only `Date` is faked: the clock moves, nothing else about the process
 * does.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_SCOPE, ShaderLibrary } from '@shader-studio/backend/library';
import { SqliteRepository } from '@shader-studio/backend/persistence/sqlite';

import { createAuth, resolvePrincipal, type Auth } from './auth';
import { readAuthConfig } from './auth-config';

const IDLE = 600;
const MAX = 1500;
const PASSWORD = 'correct horse battery staple';

let library: ShaderLibrary;
let auth: Auth;
let accounts = 0;

beforeAll(async () => {
  const repo = new SqliteRepository({ location: ':memory:' });
  library = new ShaderLibrary(repo, LOCAL_SCOPE);
  await library.init();
  auth = createAuth(
    repo.authDatabase(),
    readAuthConfig({
      NODE_ENV: 'test',
      BETTER_AUTH_SECRET: 'test-secret-not-used-anywhere-real',
      BETTER_AUTH_URL: 'http://localhost:4000',
      AUTH_REQUIRE_VERIFIED_EMAIL: '0',
      AUTH_CHECK_COMPROMISED_PASSWORDS: '0',
      AUTH_RATE_LIMIT: '0',
      AUTH_SESSION_IDLE_SECONDS: String(IDLE),
      AUTH_SESSION_MAX_SECONDS: String(MAX),
    }),
    { send: async () => undefined },
    { record: () => undefined },
  );
});

afterAll(() => library.close());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(seconds: number): void {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

function cookieOf(response: Response): Headers {
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  return new Headers({ cookie });
}

async function signUp(): Promise<{ email: string; headers: Headers }> {
  const email = `user-${++accounts}@example.test`;
  const response = await auth.api.signUpEmail({
    body: { email, name: 'User', password: PASSWORD },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  return { email, headers: cookieOf(response) };
}

async function signIn(email: string): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  return cookieOf(response);
}

async function alive(headers: Headers): Promise<boolean> {
  return (await resolvePrincipal(auth, headers)) !== null;
}

describe('session lifetime', () => {
  it('ends a session left idle for the idle window', async () => {
    const { headers } = await signUp();
    advance(IDLE + 1);
    expect(await alive(headers)).toBe(false);
  });

  it('keeps sliding a session in use past the idle window', async () => {
    const { headers } = await signUp();
    for (let elapsed = 0; elapsed < 2 * IDLE; elapsed += IDLE * 0.6) {
      advance(IDLE * 0.6);
      expect(await alive(headers)).toBe(true);
    }
  });

  it('ends even a session in use at the absolute ceiling', async () => {
    const { headers } = await signUp();
    let elapsed = 0;
    while (elapsed + IDLE * 0.6 < MAX) {
      advance(IDLE * 0.6);
      elapsed += IDLE * 0.6;
      expect(await alive(headers)).toBe(true);
    }
    advance(MAX - elapsed + 1);
    expect(await alive(headers)).toBe(false);
  });
});

describe('revoking sessions', () => {
  it('needs a recent sign-in', async () => {
    const { email, headers } = await signUp();
    const elsewhere = await signIn(email);

    // Kept alive past the fifteen-minute freshness window.
    for (let step = 0; step < 3; step++) {
      advance(IDLE * 0.6);
      expect(await alive(headers)).toBe(true);
      expect(await alive(elsewhere)).toBe(true);
    }
    await expect(auth.api.revokeOtherSessions({ headers })).rejects.toMatchObject({
      statusCode: 403,
      body: { code: 'SESSION_NOT_FRESH' },
    });
    expect(await alive(elsewhere)).toBe(true);

    // Confirming the password yields a fresh session that may.
    const fresh = await signIn(email);
    const revoked = await auth.api.revokeOtherSessions({ headers: fresh, asResponse: true });
    expect(revoked.status).toBe(200);
    expect(await alive(elsewhere)).toBe(false);
    expect(await alive(fresh)).toBe(true);
  });
});
