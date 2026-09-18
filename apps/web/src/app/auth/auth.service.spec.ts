/**
 * The four states the rest of the app branches on, and the two promises the
 * service makes about them: a network failure is not the same as being signed
 * out, and nothing about a session is ever written to browser storage.
 *
 * The Better Auth client is driven through a stubbed `fetch`, so these assert
 * this service's own behaviour rather than the library's.
 */

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { API_BASE_URL } from '../api/api-base-url';
import { AuthService } from './auth.service';

const USER = {
  id: 'user-1',
  name: 'Ada',
  email: 'ada@example.test',
  emailVerified: true,
  image: null,
};

const realFetch = globalThis.fetch;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeService(handler: (url: string) => Response | Promise<Response>): AuthService {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(handler(String(input instanceof Request ? input.url : input))),
  ) as typeof fetch;

  TestBed.configureTestingModule({
    providers: [AuthService, { provide: API_BASE_URL, useValue: '' }],
  });
  return TestBed.inject(AuthService);
}

beforeEach(() => {
  TestBed.resetTestingModule();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('AuthService', () => {
  it('starts in the loading state before anything is known', () => {
    const auth = makeService(() => respond(null));
    expect(auth.status()).toBe('loading');
    expect(auth.user()).toBeNull();
  });

  it('settles on anonymous when there is no session', async () => {
    const auth = makeService(() => respond(null));
    await auth.refresh();

    expect(auth.status()).toBe('anonymous');
    expect(auth.authenticated()).toBe(false);
  });

  it('settles on authenticated and exposes a display name', async () => {
    const auth = makeService(() => respond({ user: USER, session: { id: 's1' } }));
    await auth.refresh();

    expect(auth.status()).toBe('authenticated');
    expect(auth.authenticated()).toBe(true);
    expect(auth.displayName()).toBe('Ada');
    expect(auth.verified()).toBe(true);
  });

  it('falls back to the local part of the address when there is no name', async () => {
    const auth = makeService(() => respond({ user: { ...USER, name: '  ' }, session: {} }));
    await auth.refresh();

    expect(auth.displayName()).toBe('ada');
  });

  it('reports a transport failure as an error, not as signed out', async () => {
    const auth = makeService(() => {
      throw new TypeError('network down');
    });
    await auth.refresh();

    // The difference matters: treating an unreachable server as "anonymous"
    // would silently drop the user out of their library over a flaky network.
    expect(auth.status()).toBe('error');
    expect(auth.authenticated()).toBe(false);
    expect(auth.error()).toBeTruthy();
  });

  it('returns the server message on a failed sign-in without becoming authenticated', async () => {
    const auth = makeService(() => respond({ message: 'Invalid email or password' }, 401));
    const result = await auth.signIn('ada@example.test', 'wrong-password-here');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Invalid');
    expect(auth.authenticated()).toBe(false);
  });

  it('does not sign anyone in on sign-up, because the address is unconfirmed', async () => {
    const auth = makeService(() => respond({ user: USER, token: null }));
    const result = await auth.signUp('Ada', 'ada@example.test', 'correct horse battery');

    expect(result.ok).toBe(true);
    expect(auth.authenticated()).toBe(false);
  });

  it('clears the in-memory session on sign-out', async () => {
    const auth = makeService((url) =>
      url.includes('sign-out') ? respond({ success: true }) : respond({ user: USER, session: {} }),
    );
    await auth.refresh();
    expect(auth.authenticated()).toBe(true);

    await auth.signOut();
    expect(auth.status()).toBe('anonymous');
    expect(auth.user()).toBeNull();
  });

  it('keeps no credential in browser storage', async () => {
    const auth = makeService(() => respond({ user: USER, session: { id: 's1', token: 'secret' } }));
    await auth.refresh();

    // The session is an HttpOnly cookie. Anything this service wrote to storage
    // would be a copy that outlives sign-out and is readable by any script.
    const stored = [
      ...Object.values({ ...localStorage }),
      ...Object.values({ ...sessionStorage }),
    ].join(' ');
    expect(stored).not.toContain('secret');
    expect(stored).not.toContain(USER.email);
  });
});
