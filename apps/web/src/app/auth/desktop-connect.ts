/**
 * Where the desktop app sends the system browser to sign in (`/desktop/connect`).
 *
 * The page signs the user in over the running app, the same way the email links
 * do, then asks the server for a one-time code bound to the desktop's PKCE
 * challenge and hands it back through the `shader-studio://` deep link. The code
 * is useless without the verifier only the desktop holds, and it is never kept,
 * shown or logged here — it goes straight from the response into the link.
 */

import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, type CanActivateFn } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { API_BASE_URL } from '../api/api-base-url';
import { TranslatePipe } from '../i18n/translate.pipe';
import { AuthPrompt } from './auth-prompt';
import { AuthService } from './auth.service';

/** An S256 challenge: a SHA-256 digest in unpadded base64url. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** The desktop's own anti-forgery value, echoed back untouched. */
const STATE = /^[A-Za-z0-9_-]{16,128}$/;

/** Anything else never reaches the page: it goes back to the app. */
export const desktopConnectLink: CanActivateFn = (route) => {
  const state = route.queryParamMap.get('state') ?? '';
  const challenge = route.queryParamMap.get('code_challenge') ?? '';
  return (STATE.test(state) && CHALLENGE.test(challenge)) || inject(Router).parseUrl('/');
};

type Stage = 'connecting' | 'returned' | 'failed';

@Component({
  selector: 'app-desktop-connect',
  imports: [TranslatePipe],
  template: `
    <section class="card" role="status">
      <p>{{ message[stage()] | translate }}</p>
      @if (!busy()) {
        <button class="link" type="button" (click)="start()">
          {{ 'auth.desktopRetry' | translate }}
        </button>
      }
    </section>
  `,
  styles: `
    .card {
      position: fixed;
      top: 50%;
      left: 50%;
      z-index: 10;
      transform: translate(-50%, -50%);
      max-width: calc(100vw - 32px);
      padding: 20px 24px;
      border-radius: 16px;
      background: var(--mat-sys-surface-container-high);
      color: var(--mat-sys-on-surface);
      box-shadow: var(--mat-sys-level3);
      text-align: center;
    }

    .card p {
      margin: 0 0 8px;
      font: var(--mat-sys-body-large);
    }

    .link {
      border: 0;
      padding: 0;
      background: none;
      color: var(--mat-sys-primary);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }
  `,
})
export class DesktopConnect {
  private readonly auth = inject(AuthService);
  private readonly prompt = inject(AuthPrompt);
  private readonly http = inject(HttpClient);
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly query = inject(ActivatedRoute).snapshot.queryParamMap;

  protected readonly message = {
    connecting: 'auth.desktopConnecting',
    returned: 'auth.desktopReturn',
    failed: 'auth.desktopFailed',
  } as const;
  protected readonly stage = signal<Stage>('connecting');
  protected readonly busy = signal(false);

  /** Set once a code has been asked for, so a later session refresh does not ask again. */
  private attempted = false;

  constructor() {
    // Runs as the session settles, and again once the dialog signs the user in.
    effect(() => {
      this.auth.status();
      this.auth.verified();
      if (!this.attempted) untracked(() => this.start());
    });
  }

  protected start(): void {
    if (this.auth.status() === 'anonymous') {
      this.prompt.requestSignIn();
    } else if (this.auth.status() === 'authenticated') {
      if (this.auth.verified()) void this.connect();
      else this.prompt.request({ mode: 'verify-email' });
    }
  }

  private async connect(): Promise<void> {
    this.attempted = true;
    this.busy.set(true);
    this.stage.set('connecting');
    try {
      const { code } = await firstValueFrom(
        this.http.post<{ code: string }>(`${this.baseUrl}/api/desktop/handoff`, {
          codeChallenge: this.query.get('code_challenge'),
        }),
      );
      const callback = new URL('shader-studio://auth/callback');
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', this.query.get('state') ?? '');
      location.assign(callback.href);
      this.stage.set('returned');
    } catch {
      this.stage.set('failed');
    } finally {
      this.busy.set(false);
    }
  }
}
