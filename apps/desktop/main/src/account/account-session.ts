/**
 * The desktop's account session (contract C4). It signs in through the system
 * browser with PKCE (RFC 8252, see `apps/server/src/auth/desktop-handoff.ts`)
 * and keeps the bearer token here, in the main process, encrypted at rest with
 * `safeStorage`. Nothing else ever sees the token: the rest of the app goes
 * through `fetch()`, and the renderer only receives `AccountState`.
 *
 * The sign-in in flight (state + verifier) is also kept encrypted, so a
 * callback that starts the app, after it was closed mid-sign-in, still lands.
 * Neither the token, the code nor the verifier is ever logged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AccountState, AccountUser, SignInResult } from '@shader-studio/desktop-api/contracts';

export type { AccountState } from '@shader-studio/desktop-api/contracts';

export interface AccountSession {
  state(): AccountState;
  onChange(listener: (state: AccountState) => void): () => void;
  /** net.fetch against the configured server with the bearer token; marks `reauth-required` on 401. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface AccountSessionDeps {
  /** `SHADER_STUDIO_ACCOUNT_URL`; empty or invalid disables accounts. */
  accountUrl: string | undefined;
  /** Where the encrypted session is kept (`userData`). */
  dataDir: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  safeStorage: Pick<
    Electron.SafeStorage,
    'isEncryptionAvailable' | 'encryptString' | 'decryptString'
  >;
  openExternal: (url: string) => Promise<void>;
  timeoutMs?: number;
}

export const CALLBACK_PREFIX = 'shader-studio://auth/callback';

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const SIGN_OUT_TIMEOUT_MS = 5_000;
// What the server issues and what `/desktop/connect` accepts.
const CODE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

interface Stored {
  token: string;
  user: AccountUser;
}

interface Pending {
  state: string;
  verifier: string;
  expiresAt: number;
}

interface Waiting {
  pending: Pending;
  resolve: (result: SignInResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The server origin, or `undefined` to disable accounts. Plain `http` only for
 * a loopback server: the token must never cross a network in clear text.
 */
export function accountOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.origin;
  } catch {
    // Invalid: disabled below.
  }
  return undefined;
}

/** The sign-in callback among a process's arguments, if any. */
export function findCallbackUrl(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.toLowerCase().startsWith(CALLBACK_PREFIX));
}

export class DesktopAccountSession implements AccountSession {
  private readonly origin: string | undefined;
  private readonly sessionPath: string;
  private readonly pendingPath: string;
  private readonly listeners = new Set<(state: AccountState) => void>();
  private current: AccountState;
  private token: string | null = null;
  private waiting: Waiting | null = null;
  private restoring: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AccountSessionDeps) {
    this.origin = accountOrigin(deps.accountUrl);
    this.current = { status: this.origin ? 'signed-out' : 'disabled' };
    this.sessionPath = join(deps.dataDir, 'account.bin');
    this.pendingPath = join(deps.dataDir, 'account-pending.bin');
  }

  state(): AccountState {
    return this.current;
  }

  onChange(listener: (state: AccountState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Loads the stored session, then checks it with the server in the background.
   * Unreachable is not signed out: the cached user stays signed in.
   */
  restore(): Promise<void> {
    this.restoring = this.load();
    return this.restoring;
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.origin ? new URL(path, this.origin) : null;
    // The token only ever goes to the account server.
    if (!url || url.origin !== this.origin) throw new Error('Not an account server path');
    const token = this.token;
    if (!token) throw new Error('Not signed in');
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    const response = await this.deps.fetch(url.toString(), { ...init, headers, redirect: 'error' });
    if (response.status === 401 && this.token === token) {
      this.set({ status: 'reauth-required', user: this.current.user });
    }
    return response;
  }

  /** Opens the browser and waits for the callback, at most five minutes. */
  async signIn(): Promise<SignInResult> {
    if (!this.origin) return 'failed';
    if (!this.deps.safeStorage.isEncryptionAvailable()) return 'encryption-unavailable';
    this.finish('cancelled');

    const timeoutMs = this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    const verifier = randomBytes(32).toString('base64url');
    const pending: Pending = {
      state: randomBytes(32).toString('base64url'),
      verifier,
      expiresAt: Date.now() + timeoutMs,
    };
    try {
      await this.writeEncrypted(this.pendingPath, pending);
    } catch {
      return 'failed';
    }
    const url = new URL('/desktop/connect', this.origin);
    url.searchParams.set('state', pending.state);
    url.searchParams.set('code_challenge', challengeOf(verifier));

    return new Promise((resolve) => {
      // An expired pending file is inert; the next sign-in overwrites it.
      const timer = setTimeout(() => this.finish('timeout'), timeoutMs);
      this.waiting = { pending, resolve, timer };
      this.deps.openExternal(url.toString()).catch(() => this.finish('failed'));
    });
  }

  /** Completes a sign-in from its deep link. Anything unexpected is ignored. */
  async handleCallback(raw: string): Promise<boolean> {
    if (!this.origin) return false;
    const params = callbackParams(raw);
    if (!params) return false;
    await this.restoring;
    const waiting = this.waiting;
    const pending = waiting?.pending ?? (await this.readPending());
    // A wrong state leaves the real sign-in waiting.
    if (!pending || pending.expiresAt < Date.now() || !sameString(params.state, pending.state)) {
      return false;
    }

    // One try per sign-in, whatever the outcome.
    if (waiting) {
      clearTimeout(waiting.timer);
      this.waiting = null;
    }
    await rm(this.pendingPath, { force: true });

    let result: SignInResult = 'failed';
    try {
      const response = await this.deps.fetch(
        new URL('/api/desktop/token', this.origin).toString(),
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: params.code, codeVerifier: pending.verifier }),
          redirect: 'error',
        },
      );
      const body = response.ok ? ((await response.json()) as Partial<Stored> | null) : null;
      const user = userOf(body?.user);
      if (typeof body?.token === 'string' && body.token && user) {
        await this.writeEncrypted(this.sessionPath, { token: body.token, user });
        this.token = body.token;
        this.set({ status: 'signed-in', user });
        result = 'ok';
      }
    } catch {
      // Network, server or storage failure: the sign-in fails, nothing is kept.
    }
    waiting?.resolve(result);
    return result === 'ok';
  }

  /** Revokes the server session if it can, and forgets it locally regardless. */
  async signOut(): Promise<void> {
    this.finish('cancelled');
    if (this.token) {
      try {
        await this.fetch('/api/auth/sign-out', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(SIGN_OUT_TIMEOUT_MS),
        });
      } catch {
        // Offline: the session stays revocable from the web account.
      }
    }
    this.token = null;
    await Promise.all([
      rm(this.sessionPath, { force: true }),
      rm(this.pendingPath, { force: true }),
    ]);
    if (this.origin) this.set({ status: 'signed-out' });
  }

  /** The web app, where the account and its sessions are managed. */
  openAccountPage(): void {
    if (this.origin) void this.deps.openExternal(`${this.origin}/`).catch(() => undefined);
  }

  private async load(): Promise<void> {
    if (!this.origin) return;
    const stored = await this.readEncrypted(this.sessionPath);
    const user = userOf(stored?.['user']);
    const token = stored?.['token'];
    if (typeof token !== 'string' || !token || !user) return;
    this.token = token;
    this.set({ status: 'signed-in', user });
    void this.verify(token);
  }

  private async verify(token: string): Promise<void> {
    let body: unknown;
    try {
      const response = await this.fetch('/api/auth/get-session');
      if (!response.ok) return;
      body = await response.json();
    } catch {
      return;
    }
    if (this.token !== token) return;
    // Better Auth answers a dead session with 200 `null`.
    if (body === null) {
      this.set({ status: 'reauth-required', user: this.current.user });
      return;
    }
    const user = userOf((body as { user?: unknown } | undefined)?.user);
    if (!user) return;
    try {
      await this.writeEncrypted(this.sessionPath, { token, user });
    } catch {
      // The cached user is only a display name; keep the old one on disk.
    }
    this.set({ status: 'signed-in', user });
  }

  private finish(result: SignInResult): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    waiting.resolve(result);
  }

  private set(state: AccountState): void {
    this.current = state;
    for (const listener of this.listeners) listener(state);
  }

  private async readPending(): Promise<Pending | null> {
    const value = await this.readEncrypted(this.pendingPath);
    return typeof value?.['state'] === 'string' &&
      typeof value['verifier'] === 'string' &&
      typeof value['expiresAt'] === 'number'
      ? (value as unknown as Pending)
      : null;
  }

  private async readEncrypted(path: string): Promise<Record<string, unknown> | null> {
    const { safeStorage } = this.deps;
    try {
      if (!safeStorage.isEncryptionAvailable()) return null;
      const value: unknown = JSON.parse(safeStorage.decryptString(await readFile(path)));
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Never falls back to plain text. */
  private async writeEncrypted(path: string, value: Stored | Pending): Promise<void> {
    const { safeStorage } = this.deps;
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Encryption is unavailable');
    await writeFile(path, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
  }
}

function callbackParams(raw: string): { code: string; state: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'shader-studio:' ||
    url.host !== 'auth' ||
    url.pathname !== '/callback' ||
    url.username ||
    url.password
  ) {
    return null;
  }
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  return CODE.test(code) && STATE.test(state) ? { code, state } : null;
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function userOf(value: unknown): AccountUser | null {
  const user = value as Partial<AccountUser> | null | undefined;
  return typeof user?.id === 'string' &&
    typeof user.name === 'string' &&
    typeof user.email === 'string'
    ? { id: user.id, name: user.name, email: user.email }
    : null;
}
