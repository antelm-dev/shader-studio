/**
 * The browser's view of who is signed in.
 *
 * Nothing about the session is stored here beyond what the server already told
 * us: the session itself lives in an `HttpOnly` cookie this code cannot read,
 * and deliberately never reaches `localStorage`, `sessionStorage` or the URL.
 * Signing out or losing a session therefore only has to clear the in-memory
 * copy — there is no second place a stale credential could survive.
 *
 * Every call reports failure the same way the server does, which for the
 * credential endpoints means a message that does not reveal whether an address
 * is registered.
 */

import { Injectable, computed, inject, signal } from '@angular/core';
import { createAuthClient } from 'better-auth/client';

import { API_BASE_URL } from '../api/api-base-url';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
}

/** A row in the "where you are signed in" list. */
export interface AuthSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  /** True for the session making this request — the one you would sign out of. */
  current: boolean;
}

export type AuthStatus = 'loading' | 'anonymous' | 'authenticated' | 'error';

export interface AuthResult {
  ok: boolean;
  /** A message safe to show; already generic where the server keeps it generic. */
  message?: string;
  /** The server's error code — `SESSION_NOT_FRESH` means "confirm your password". */
  code?: string;
}

/** The server refuses session management on a sign-in older than a few minutes. */
export const SESSION_NOT_FRESH = 'SESSION_NOT_FRESH';

const OK: AuthResult = { ok: true };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly baseUrl = inject(API_BASE_URL);

  private readonly client = createAuthClient({
    baseURL: authEndpoint(this.baseUrl),
    fetchOptions: { credentials: 'include' },
  });

  private readonly statusSignal = signal<AuthStatus>('loading');
  private readonly userSignal = signal<AuthUser | null>(null);
  private readonly errorSignal = signal<string | null>(null);

  readonly status = this.statusSignal.asReadonly();
  readonly user = this.userSignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();

  readonly authenticated = computed(() => this.statusSignal() === 'authenticated');
  readonly verified = computed(() => this.userSignal()?.emailVerified === true);
  /** What to put on the account button: a display name, or the address before the @. */
  readonly displayName = computed(() => {
    const user = this.userSignal();
    if (!user) return '';
    return user.name.trim() || user.email.split('@')[0];
  });

  /**
   * Resolves the current session. Called once at startup and again after any
   * `401`, so a session that expired or was revoked elsewhere is noticed rather
   * than assumed away.
   */
  async refresh(): Promise<void> {
    this.statusSignal.set('loading');
    try {
      const { data, error } = await this.client.getSession();
      if (error) {
        // A transport failure is not "signed out": saying so would throw away
        // the user's session over a flaky network.
        this.errorSignal.set(error.message ?? 'Cannot reach the server');
        this.statusSignal.set('error');
        return;
      }
      this.apply(data?.user ?? null);
    } catch (cause) {
      this.errorSignal.set(messageOf(cause));
      this.statusSignal.set('error');
    }
  }

  async signIn(email: string, password: string): Promise<AuthResult> {
    const { data, error } = await this.client.signIn.email({ email, password });
    if (error) return this.fail(error.message);
    this.apply(data?.user ?? null);
    return OK;
  }

  async signUp(name: string, email: string, password: string): Promise<AuthResult> {
    const { error } = await this.client.signUp.email({ name, email, password });
    if (error) return this.fail(error.message);
    // No session yet on purpose: the address has to be confirmed first, so the
    // caller shows "check your email" rather than an empty library.
    return OK;
  }

  /**
   * Only reports success once the server has invalidated the session. On
   * failure the local state is left alone: showing "signed out" while the
   * cookie still works would be a lie the user might act on.
   */
  async signOut(): Promise<AuthResult> {
    const { error } = await this.client
      .signOut()
      .catch((cause: unknown) => ({ error: { message: messageOf(cause) } }));
    if (error) return this.fail(error.message);
    this.apply(null);
    return OK;
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<AuthResult> {
    const { error } = await this.client.requestPasswordReset({ email, redirectTo });
    // The server answers identically for a known and an unknown address; this
    // keeps that true in the UI by not branching on the result.
    return error ? this.fail(error.message) : OK;
  }

  async resetPassword(token: string, newPassword: string): Promise<AuthResult> {
    const { error } = await this.client.resetPassword({ token, newPassword });
    return error ? this.fail(error.message) : OK;
  }

  async resendVerification(email: string, callbackURL: string): Promise<AuthResult> {
    const { error } = await this.client.sendVerificationEmail({ email, callbackURL });
    return error ? this.fail(error.message) : OK;
  }

  /**
   * Proves it is still the owner at the keyboard: a fresh sign-in, which is
   * what listing and revoking sessions require. The server retires the session
   * this browser held, so no duplicate device appears.
   */
  async reauthenticate(password: string): Promise<AuthResult> {
    const email = this.userSignal()?.email;
    if (!email) return this.fail(undefined);
    return this.signIn(email, password);
  }

  /** Fails rather than answering `[]`, so "no sessions" is never a guess. */
  async listSessions(): Promise<AuthResult & { sessions: AuthSession[] }> {
    const { data, error } = await this.client.listSessions();
    if (error || !data) return { ...this.fail(error?.message, error?.code), sessions: [] };
    const sessions = data.map((session) => ({
      id: session.id,
      createdAt: String(session.createdAt),
      expiresAt: String(session.expiresAt),
      userAgent: session.userAgent ?? null,
      // The token is never compared here — the server marks nothing, so the
      // list is informational and revoking the current one signs you out.
      current: false,
    }));
    return { ...OK, sessions };
  }

  async revokeSession(token: string): Promise<AuthResult> {
    const { error } = await this.client.revokeSession({ token });
    return error ? this.fail(error.message, error.code) : OK;
  }

  /** Signs out everywhere, including here. */
  async revokeOtherSessions(): Promise<AuthResult> {
    const { error } = await this.client.revokeOtherSessions();
    return error ? this.fail(error.message, error.code) : OK;
  }

  /** Accepts the client's own user shape, where `image` may simply be absent. */
  private apply(
    user: (Omit<AuthUser, 'image'> & { image?: string | null }) | null | undefined,
  ): void {
    this.errorSignal.set(null);
    if (!user) {
      this.userSignal.set(null);
      this.statusSignal.set('anonymous');
      return;
    }
    this.userSignal.set({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image ?? null,
    });
    this.statusSignal.set('authenticated');
  }

  private fail(message: string | undefined, code?: string): AuthResult {
    return {
      ok: false,
      message: message ?? 'Something went wrong. Try again.',
      ...(code ? { code } : {}),
    };
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Cannot reach the server';
}

/**
 * The Better Auth client insists on an absolute URL. `API_BASE_URL` is empty in
 * the browser, where every call is relative and therefore same-origin, so the
 * origin is filled in here — and under SSR or a test, where there is no
 * `window`, a placeholder keeps construction from throwing. Nothing is actually
 * fetched in either case: the service only resolves a session in the browser.
 */
function authEndpoint(baseUrl: string): string {
  if (baseUrl) return `${baseUrl}/api/auth`;
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return `${origin}/api/auth`;
}
