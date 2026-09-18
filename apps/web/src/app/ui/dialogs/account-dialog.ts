/**
 * Profile and active sessions — the two things a signed-in user needs that are
 * not editing a shader.
 *
 * "Sign out everywhere" is the useful half of this dialog: it is what someone
 * reaches for after losing a laptop, and it has to work without knowing which
 * row that laptop is.
 */

import { Component, inject, signal, type OnInit } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { AuthService, type AuthSession } from '../../auth/auth.service';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';

@Component({
  selector: 'app-account-dialog',
  imports: [
    DatePipe,
    MatButtonModule,
    MatDialogModule,
    MatIconModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'auth.accountTitle' | translate }}</h2>

    @if (busy()) {
      <mat-progress-bar mode="indeterminate" [attr.aria-label]="'auth.working' | translate" />
    }

    <mat-dialog-content>
      <section class="profile" [attr.aria-label]="'auth.profile' | translate">
        <span class="mark" aria-hidden="true"><mat-icon>person</mat-icon></span>
        <div>
          <p class="name">{{ auth.displayName() }}</p>
          <p class="email">{{ auth.user()?.email }}</p>
        </div>
      </section>

      @if (auth.user(); as user) {
        @if (!user.emailVerified) {
          <p class="notice" role="status">{{ 'auth.unverifiedNotice' | translate }}</p>
        }
      }

      <h3>{{ 'auth.sessionsTitle' | translate }}</h3>
      <p class="hint">{{ 'auth.sessionsSubtitle' | translate }}</p>

      @if (message(); as text) {
        <p class="notice" role="status" aria-live="polite">{{ text }}</p>
      }

      <ul class="sessions">
        @for (session of sessions(); track session.id) {
          <li>
            <mat-icon aria-hidden="true">devices</mat-icon>
            <div>
              <p class="device">{{ session.userAgent || ('auth.unknownDevice' | translate) }}</p>
              <p class="dates">
                {{ 'auth.sessionStarted' | translate }} {{ session.createdAt | date: 'medium' }} ·
                {{ 'auth.sessionExpires' | translate }} {{ session.expiresAt | date: 'medium' }}
              </p>
            </div>
          </li>
        } @empty {
          <li class="dates">{{ 'auth.noSessions' | translate }}</li>
        }
      </ul>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
      <button matButton type="button" [disabled]="busy()" (click)="signOutEverywhere()">
        {{ 'auth.signOutEverywhere' | translate }}
      </button>
      <button matButton="filled" type="button" [disabled]="busy()" (click)="signOut()">
        {{ 'auth.signOut' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(460px, 80vw);
    }

    .profile {
      display: flex;
      align-items: center;
      gap: 14px;
      margin-bottom: 20px;
    }

    .mark {
      display: grid;
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      place-items: center;
      border-radius: 50%;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }

    .name {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }

    .email,
    .hint,
    .dates {
      margin: 2px 0 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    h3 {
      margin: 0;
      font: var(--mat-sys-title-small);
    }

    .notice {
      margin: 12px 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-body-small);
    }

    .sessions {
      margin: 12px 0 0;
      padding: 0;
      list-style: none;
    }

    .sessions li {
      display: flex;
      gap: 10px;
      padding: 8px 0;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }

    .device {
      margin: 0;
      overflow-wrap: anywhere;
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class AccountDialog implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly i18n = inject(I18n);
  private readonly ref = inject(MatDialogRef<AccountDialog>);

  protected readonly sessions = signal<AuthSession[]>([]);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.busy.set(true);
    this.sessions.set(await this.auth.listSessions());
    this.busy.set(false);
  }

  protected async signOut(): Promise<void> {
    this.busy.set(true);
    await this.auth.signOut();
    this.ref.close();
  }

  protected async signOutEverywhere(): Promise<void> {
    this.busy.set(true);
    // Revoking the others first, then this one, so a failure part-way through
    // leaves the user signed out of the devices they were worried about.
    await this.auth.revokeOtherSessions();
    await this.auth.signOut();
    this.message.set(this.i18n.t('auth.signedOutEverywhere'));
    this.busy.set(false);
    this.ref.close();
  }
}
