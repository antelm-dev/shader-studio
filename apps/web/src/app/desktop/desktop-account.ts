import { Injectable, computed, signal } from '@angular/core';

import type { AccountState, SignInResult } from '@shader-studio/desktop-api/contracts';

/**
 * The desktop's account, as the main process reports it. The session itself
 * (and its token) never leaves the main process. Separate from `AuthService`,
 * which is the web's cookie session and stays inert on the desktop.
 */
@Injectable({ providedIn: 'root' })
export class DesktopAccount {
  /** `disabled` on the web and in desktop builds without an account server. */
  readonly state = signal<AccountState>({ status: 'disabled' });
  private readonly attempts = signal(0);
  /** True while a browser sign-in is in progress; a new one replaces the last. */
  readonly signingIn = computed(() => this.attempts() > 0);
  private readonly available = typeof window !== 'undefined' && 'electron' in window;

  constructor() {
    if (!this.available) return;
    void window.electron.bridge.account.state().then((state) => this.state.set(state));
    window.electron.bridge.account.onAccountChanged((state) => this.state.set(state));
  }

  async signIn(): Promise<SignInResult> {
    if (!this.available) return 'failed';
    this.attempts.update((count) => count + 1);
    try {
      return await window.electron.bridge.account.signIn();
    } finally {
      this.attempts.update((count) => count - 1);
    }
  }

  async signOut(): Promise<void> {
    if (this.available) await window.electron.bridge.account.signOut();
  }

  openAccountPage(): void {
    if (this.available) window.electron.bridge.account.openAccountPage();
  }
}
