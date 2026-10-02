/**
 * A one-slot request for the sign-in dialog.
 *
 * The interceptor cannot open a dialog itself without dragging Material into
 * the HTTP layer and risking a stack of dialogs from a burst of parallel `401`s.
 * It sets a signal instead; the shell opens at most one dialog and clears it.
 */

import { Injectable, signal } from '@angular/core';

export type AuthPromptMode = 'sign-in' | 'sign-up' | 'reset-password' | 'verify-email';

export interface AuthPromptRequest {
  mode: AuthPromptMode;
  /** The token from a reset or verification link, when the prompt came from one. */
  token?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthPrompt {
  private readonly pendingSignal = signal<AuthPromptRequest | null>(null);
  readonly pending = this.pendingSignal.asReadonly();

  /** Ignored while a prompt is already outstanding, so parallel 401s open one dialog. */
  requestSignIn(): void {
    if (this.pendingSignal()) return;
    this.pendingSignal.set({ mode: 'sign-in' });
  }

  request(request: AuthPromptRequest): void {
    this.pendingSignal.set(request);
  }

  clear(): void {
    this.pendingSignal.set(null);
  }
}
