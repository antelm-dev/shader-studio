import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  accountOrigin,
  DesktopAccountSession,
  findCallbackUrl,
  type AccountSessionDeps,
} from './account-session';

const ORIGIN = 'http://localhost:3000';
const CODE = 'c'.repeat(43);
const TOKEN = 'secret-bearer-token';
const USER = { id: 'u1', name: 'Ada', email: 'ada@example.com' };

// Reversible but not plain text, so a test can tell the token was not stored as is.
const safeStorage = {
  available: true,
  isEncryptionAvailable: () => safeStorage.available,
  encryptString: (value: string) => Buffer.from(Buffer.from(value).toString('base64')),
  decryptString: (value: Buffer) => Buffer.from(value.toString(), 'base64').toString(),
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let dir: string;
let fetch: ReturnType<typeof vi.fn<AccountSessionDeps['fetch']>>;
let opened: string[];

function create(overrides: Partial<AccountSessionDeps> = {}) {
  return new DesktopAccountSession({
    accountUrl: ORIGIN,
    dataDir: dir,
    fetch,
    safeStorage,
    openExternal: async (url) => void opened.push(url),
    ...overrides,
  });
}

/** Starts a sign-in and returns the state and challenge the browser was sent. */
async function startSignIn(session: DesktopAccountSession) {
  const result = session.signIn();
  await vi.waitFor(() => expect(opened).toHaveLength(1));
  const url = new URL(opened[0]!);
  return {
    result,
    url,
    state: url.searchParams.get('state')!,
    challenge: url.searchParams.get('code_challenge')!,
  };
}

const callback = (state: string, code = CODE) =>
  `shader-studio://auth/callback?code=${code}&state=${state}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'account-session-'));
  fetch = vi.fn<AccountSessionDeps['fetch']>();
  opened = [];
  safeStorage.available = true;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DesktopAccountSession', () => {
  it('is disabled without a usable server URL', async () => {
    expect(create({ accountUrl: undefined }).state()).toEqual({ status: 'disabled' });
    expect(accountOrigin('http://example.com')).toBeUndefined();
    expect(accountOrigin('https://example.com/app/')).toBe('https://example.com');
    const session = create({ accountUrl: '' });
    expect(await session.signIn()).toBe('failed');
    expect(opened).toEqual([]);
  });

  it('signs in through the browser with PKCE and stores the token encrypted', async () => {
    const session = create();
    const { result, url, state, challenge } = await startSignIn(session);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/desktop/connect`);
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    fetch.mockResolvedValueOnce(json({ token: TOKEN, user: USER }));
    expect(await session.handleCallback(callback(state))).toBe(true);
    expect(await result).toBe('ok');
    expect(session.state()).toEqual({ status: 'signed-in', user: USER });

    const [tokenUrl, init] = fetch.mock.calls[0]!;
    expect(tokenUrl).toBe(`${ORIGIN}/api/desktop/token`);
    const { code, codeVerifier } = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(code).toBe(CODE);
    expect(createHash('sha256').update(codeVerifier!).digest('base64url')).toBe(challenge);

    const stored = await readFile(join(dir, 'account.bin'), 'utf8');
    expect(stored).not.toContain(TOKEN);
    expect(safeStorage.decryptString(Buffer.from(stored))).toContain(TOKEN);
  });

  it('rejects a wrong state or a malformed callback and keeps waiting', async () => {
    const session = create();
    const { result, state } = await startSignIn(session);
    expect(await session.handleCallback(callback('x'.repeat(43)))).toBe(false);
    expect(await session.handleCallback(callback(state, 'short'))).toBe(false);
    expect(
      await session.handleCallback(`shader-studio://bundle/callback?code=${CODE}&state=${state}`),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(json({ token: TOKEN, user: USER }));
    expect(await session.handleCallback(callback(state))).toBe(true);
    expect(await result).toBe('ok');
    // One try per sign-in.
    expect(await session.handleCallback(callback(state))).toBe(false);
  });

  it('times out, and a late callback is refused', async () => {
    const session = create({ timeoutMs: 10 });
    const { result, state } = await startSignIn(session);
    expect(await result).toBe('timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await session.handleCallback(callback(state))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to sign in without encryption', async () => {
    safeStorage.available = false;
    expect(await create().signIn()).toBe('encryption-unavailable');
    expect(opened).toEqual([]);
  });

  it('completes a sign-in when the callback starts the app', async () => {
    const { state } = await startSignIn(create());
    const relaunched = create();
    await relaunched.restore();
    fetch.mockResolvedValueOnce(json({ token: TOKEN, user: USER }));
    expect(await relaunched.handleCallback(callback(state))).toBe(true);
    expect(relaunched.state().status).toBe('signed-in');
  });

  async function signedIn() {
    const session = create();
    const { state, result } = await startSignIn(session);
    fetch.mockResolvedValueOnce(json({ token: TOKEN, user: USER }));
    await session.handleCallback(callback(state));
    await result;
    fetch.mockReset();
    return session;
  }

  it('sends the bearer token only to the account server and marks a 401 reauth-required', async () => {
    const session = await signedIn();
    const changes: string[] = [];
    session.onChange((state) => changes.push(state.status));
    await expect(session.fetch('https://evil.example/steal')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const response = await session.fetch('/api/shaders');
    expect(response.status).toBe(401);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${ORIGIN}/api/shaders`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(session.state()).toEqual({ status: 'reauth-required', user: USER });
    expect(changes).toEqual(['reauth-required']);
  });

  it('keeps the cached user when the server is unreachable at startup', async () => {
    await signedIn();
    fetch.mockRejectedValue(new TypeError('fetch failed'));
    const restarted = create();
    await restarted.restore();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(restarted.state()).toEqual({ status: 'signed-in', user: USER });
  });

  it('marks a revoked session reauth-required at startup', async () => {
    await signedIn();
    fetch.mockResolvedValueOnce(json(null));
    const restarted = create();
    await restarted.restore();
    await vi.waitFor(() => expect(restarted.state().status).toBe('reauth-required'));
  });

  it('signs out even offline: state cleared and token deleted', async () => {
    const session = await signedIn();
    fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    await session.signOut();
    expect(fetch.mock.calls[0]![0]).toBe(`${ORIGIN}/api/auth/sign-out`);
    expect(session.state()).toEqual({ status: 'signed-out' });
    expect(existsSync(join(dir, 'account.bin'))).toBe(false);
    await expect(session.fetch('/api/shaders')).rejects.toThrow();
  });

  it('joins a sign-in already in progress', async () => {
    const session = create();
    const first = session.signIn();
    const second = session.signIn();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    const state = new URL(opened[0]!).searchParams.get('state')!;
    fetch.mockResolvedValueOnce(json({ token: TOKEN, user: USER }));
    await session.handleCallback(callback(state));
    expect(await Promise.all([first, second])).toEqual(['ok', 'ok']);
    expect(opened).toHaveLength(1);
  });

  it('stays signed out when sign-out lands during the token exchange', async () => {
    const session = create();
    const { result, state } = await startSignIn(session);
    let answer!: (response: Response) => void;
    fetch.mockImplementation(async (url) =>
      url.endsWith('/api/desktop/token')
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(null, { status: 200 }),
    );
    const exchange = session.handleCallback(callback(state));
    await vi.waitFor(() => expect(answer).toBeDefined());
    await session.signOut();
    answer(json({ token: TOKEN, user: USER }));

    expect(await exchange).toBe(false);
    expect(await result).toBe('cancelled');
    expect(session.state()).toEqual({ status: 'signed-out' });
    expect(existsSync(join(dir, 'account.bin'))).toBe(false);
    // The stale session is revoked, not kept.
    const revoke = fetch.mock.calls.find(([url]) => url.endsWith('/api/auth/sign-out'));
    expect(new Headers(revoke?.[1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('stays signed out when sign-out lands during the startup check', async () => {
    await signedIn();
    let answer!: (response: Response) => void;
    fetch.mockImplementation(async (url) =>
      url.endsWith('/api/auth/get-session')
        ? new Promise<Response>((resolve) => (answer = resolve))
        : new Response(null, { status: 200 }),
    );
    const restarted = create();
    await restarted.restore();
    await vi.waitFor(() => expect(answer).toBeDefined());
    await restarted.signOut();
    answer(json({ user: { ...USER, name: 'Renamed' } }));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(restarted.state()).toEqual({ status: 'signed-out' });
    expect(existsSync(join(dir, 'account.bin'))).toBe(false);
  });

  it('finds the callback among process arguments', () => {
    expect(findCallbackUrl(['app.exe', '--flag', callback('s'.repeat(16))])).toBe(
      callback('s'.repeat(16)),
    );
    expect(findCallbackUrl(['app.exe', 'shader-studio://bundle/'])).toBeUndefined();
  });
});
