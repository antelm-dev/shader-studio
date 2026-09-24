/**
 * Where the desktop app sends the system browser to sign in (`/desktop/connect`).
 *
 * The page signs the user in over the running app, the same way the email links
 * do, then asks the server for a one-time code bound to the desktop's PKCE
 * challenge and hands it back through the `shader-studio://` deep link. The code
 * is useless without the verifier only the desktop holds, and it is never kept,
 * shown or logged here — it goes straight from the response into the link.
 *
 * Being signed in is not enough: the page asks for the password again, and the
 * server checks it before issuing a code. A script injected into the page has
 * the session cookie but not the password, so it cannot mint a desktop token.
 * The password stays in a field until the request is sent, and no longer.
 */

import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, type CanActivateFn } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
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

/** `waiting` covers everything before the user is signed in and verified. */
type Stage = 'waiting' | 'password' | 'returned' | 'failed';

@Component({
  selector: 'app-desktop-connect',
  imports: [MatButtonModule, MatFormFieldModule, MatInputModule, TranslatePipe],
  template: `
    <section class="card" role="status">
      <p>{{ message[stage()] | translate }}</p>
      @if (stage() === 'password' || stage() === 'failed') {
        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.password' | translate }}</mat-label>
          <input
            matInput
            required
            type="password"
            autocomplete="current-password"
            [value]="password()"
            (input)="password.set(value($event))"
            (keyup.enter)="connect()"
          />
        </mat-form-field>
        <button
          matButton="filled"
          type="button"
          [disabled]="busy() || !password()"
          (click)="connect()"
        >
          {{ 'auth.desktopConnect' | translate }}
        </button>
      } @else if (!busy()) {
        <button class="link" type="button" (click)="retry()">
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
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
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
      margin: 0;
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
    waiting: 'auth.desktopConnecting',
    password: 'auth.desktopConfirm',
    returned: 'auth.desktopReturn',
    failed: 'auth.desktopFailed',
  } as const;
  protected readonly stage = signal<Stage>('waiting');
  protected readonly busy = signal(false);
  protected readonly password = signal('');

  constructor() {
    // Runs as the session settles, and again once the dialog signs the user in.
    effect(() => {
      this.auth.status();
      this.auth.verified();
      if (this.stage() === 'waiting') untracked(() => this.start());
    });
  }

  protected retry(): void {
    this.stage.set('waiting');
    // A session that could not be resolved at all is asked for again; the
    // effect carries on once it settles. Never from the effect itself, which
    // would loop for as long as the server stays unreachable.
    if (this.auth.status() === 'error') void this.auth.refresh();
    else this.start();
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  private start(): void {
    switch (this.auth.status()) {
      case 'anonymous':
        this.prompt.requestSignIn();
        return;
      case 'authenticated':
        if (this.auth.verified()) this.stage.set('password');
        else this.prompt.request({ mode: 'verify-email' });
        return;
    }
  }

  protected async connect(): Promise<void> {
    if (this.busy() || !this.password()) return;
    this.busy.set(true);
    try {
      const { code } = await firstValueFrom(
        this.http.post<{ code: string }>(`${this.baseUrl}/api/desktop/handoff`, {
          codeChallenge: this.query.get('code_challenge'),
          password: this.password(),
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
      this.password.set('');
      this.busy.set(false);
    }
  }
}
