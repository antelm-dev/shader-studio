/**
 * Sign in, sign up, recover an account, and finish a reset or verification
 * link — one dialog with five states rather than five routed pages.
 *
 * A dialog, specifically: signing in is something you do *while* editing a
 * shader, and navigating away from the editor to a login page would throw away
 * unsaved work. The email links land on `/reset-password` and `/verify-email`,
 * which open this dialog over the app rather than replacing it.
 */

import { Component, computed, inject, signal, type OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { AuthService } from '../../auth/auth.service';
import type { AuthPromptMode } from '../../auth/auth-prompt';
import { I18n } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';

/** Matches the server's `minPasswordLength`; the server is still the authority. */
const MIN_PASSWORD = 12;

export interface AuthDialogData {
  mode: AuthPromptMode;
  token?: string;
}

type Stage = AuthPromptMode | 'forgot-password';

@Component({
  selector: 'app-auth-dialog',
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    TranslatePipe,
  ],
  template: `
    <div class="heading">
      <span class="mark" aria-hidden="true"><mat-icon>person</mat-icon></span>
      <div>
        <h2 mat-dialog-title>{{ title() | translate }}</h2>
        <p>{{ subtitle() | translate }}</p>
      </div>
    </div>

    @if (busy()) {
      <mat-progress-bar mode="indeterminate" [attr.aria-label]="'auth.working' | translate" />
    }

    <mat-dialog-content>
      @if (stage() === 'sign-in' || stage() === 'sign-up') {
        <div class="mode" role="tablist" [attr.aria-label]="'auth.mode' | translate">
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="stage() === 'sign-in'"
            [class.active]="stage() === 'sign-in'"
            (click)="go('sign-in')"
          >
            {{ 'auth.login' | translate }}
          </button>
          <button
            type="button"
            role="tab"
            [attr.aria-selected]="stage() === 'sign-up'"
            [class.active]="stage() === 'sign-up'"
            (click)="go('sign-up')"
          >
            {{ 'auth.createAccount' | translate }}
          </button>
        </div>
      }

      <!-- Both the error and the confirmation are announced: a screen-reader
           user otherwise has no way to know the button did anything. -->
      @if (message(); as text) {
        <div class="notice" [class.is-error]="failed()" role="status" aria-live="polite">
          <mat-icon aria-hidden="true">{{ failed() ? 'error' : 'check_circle' }}</mat-icon>
          <span>{{ text }}</span>
        </div>
      }

      @if (stage() === 'sign-up') {
        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.displayName' | translate }}</mat-label>
          <input
            matInput
            required
            autocomplete="name"
            [value]="displayName()"
            (input)="displayName.set(value($event))"
          />
        </mat-form-field>
      }

      @if (needsEmail()) {
        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.email' | translate }}</mat-label>
          <input
            matInput
            required
            cdkFocusInitial
            type="email"
            autocomplete="email"
            inputmode="email"
            [value]="email()"
            (input)="email.set(value($event))"
            (keyup.enter)="submit()"
          />
        </mat-form-field>
      }

      @if (needsPassword()) {
        <mat-form-field appearance="outline">
          <mat-label>{{ passwordLabel() | translate }}</mat-label>
          <input
            matInput
            required
            type="password"
            [autocomplete]="stage() === 'sign-in' ? 'current-password' : 'new-password'"
            [value]="password()"
            (input)="password.set(value($event))"
            (keyup.enter)="submit()"
          />
          @if (stage() !== 'sign-in') {
            <mat-hint>{{ 'auth.passwordHint' | translate: { min: minPassword } }}</mat-hint>
          }
        </mat-form-field>
      }

      @if (stage() === 'sign-in') {
        <button class="link" type="button" (click)="go('forgot-password')">
          {{ 'auth.forgotPassword' | translate }}
        </button>
      }
      @if (stage() === 'forgot-password' || stage() === 'verify-email') {
        <button class="link" type="button" (click)="go('sign-in')">
          {{ 'auth.backToSignIn' | translate }}
        </button>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="!canSubmit()" (click)="submit()">
        {{ submitLabel() | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .heading {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 24px 24px 4px;
    }

    .heading h2 {
      margin: 0;
      padding: 0;
    }

    .heading p {
      margin: 2px 0 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-medium);
    }

    .mark {
      display: grid;
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      place-items: center;
      border-radius: 12px;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }

    mat-dialog-content {
      display: flex;
      flex-direction: column;
      width: min(430px, 78vw);
      padding-top: 16px;
    }

    .mode {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin-bottom: 14px;
      padding: 4px;
      border-radius: 12px;
      background: var(--mat-sys-surface-container-high);
    }

    .mode button {
      min-height: 36px;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-large);
      cursor: pointer;
    }

    .mode button.active {
      background: var(--mat-sys-surface);
      color: var(--mat-sys-on-surface);
      box-shadow: 0 1px 3px color-mix(in srgb, var(--mat-sys-shadow) 18%, transparent);
    }

    .notice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 16px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-body-small);
    }

    .notice.is-error {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }

    .notice mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    mat-form-field {
      width: 100%;
    }

    .link {
      align-self: flex-start;
      padding: 4px 0;
      border: 0;
      background: none;
      color: var(--mat-sys-primary);
      font: var(--mat-sys-body-small);
      text-decoration: underline;
      cursor: pointer;
    }
  `,
})
export class AuthDialog implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly i18n = inject(I18n);
  private readonly data = inject<AuthDialogData>(MAT_DIALOG_DATA, { optional: true });
  private readonly ref = inject(MatDialogRef<AuthDialog>);

  protected readonly minPassword = MIN_PASSWORD;
  protected readonly stage = signal<Stage>('sign-in');
  protected readonly displayName = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly failed = signal(false);

  private token = '';

  ngOnInit(): void {
    this.stage.set(this.data?.mode ?? 'sign-in');
    this.token = this.data?.token ?? '';
    if (this.stage() === 'verify-email') this.succeed('auth.checkInbox');
  }

  protected readonly needsEmail = computed(
    () => this.stage() !== 'reset-password' && this.stage() !== 'verify-email',
  );

  protected readonly needsPassword = computed(
    () =>
      this.stage() === 'sign-in' || this.stage() === 'sign-up' || this.stage() === 'reset-password',
  );

  protected readonly title = computed(() => {
    switch (this.stage()) {
      case 'forgot-password':
        return 'auth.forgotTitle' as const;
      case 'reset-password':
        return 'auth.resetTitle' as const;
      case 'verify-email':
        return 'auth.verifyTitle' as const;
      default:
        return 'auth.welcome' as const;
    }
  });

  protected readonly subtitle = computed(() => {
    switch (this.stage()) {
      case 'forgot-password':
        return 'auth.forgotSubtitle' as const;
      case 'reset-password':
        return 'auth.resetSubtitle' as const;
      case 'verify-email':
        return 'auth.verifySubtitle' as const;
      default:
        return 'auth.subtitle' as const;
    }
  });

  protected readonly passwordLabel = computed(() =>
    this.stage() === 'reset-password' ? ('auth.newPassword' as const) : ('auth.password' as const),
  );

  protected readonly submitLabel = computed(() => {
    switch (this.stage()) {
      case 'sign-up':
        return 'auth.createAccount' as const;
      case 'forgot-password':
        return 'auth.sendResetLink' as const;
      case 'reset-password':
        return 'auth.setPassword' as const;
      case 'verify-email':
        return 'auth.resendVerification' as const;
      default:
        return 'auth.login' as const;
    }
  });

  protected readonly canSubmit = computed(() => {
    if (this.busy()) return false;
    const stage = this.stage();
    // Only shape is checked here. Whether an address exists, or a password is
    // right, is the server's to answer — and its answer is deliberately vague.
    const emailOk = !this.needsEmail() || this.email().includes('@');
    const passwordOk = !this.needsPassword() || this.password().length >= MIN_PASSWORD;
    const nameOk = stage !== 'sign-up' || this.displayName().trim().length > 0;
    if (stage === 'verify-email') return true;
    return emailOk && passwordOk && nameOk;
  });

  protected go(stage: Stage): void {
    this.stage.set(stage);
    this.message.set(null);
    this.failed.set(false);
    this.password.set('');
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    this.message.set(null);
    this.failed.set(false);
    try {
      await this.run();
    } finally {
      this.busy.set(false);
      // The password never lingers in a component field once it has been sent.
      if (this.stage() !== 'sign-in') this.password.set('');
    }
  }

  private async run(): Promise<void> {
    switch (this.stage()) {
      case 'sign-in': {
        const result = await this.auth.signIn(this.email(), this.password());
        if (result.ok) this.ref.close(true);
        else this.report(result.message);
        return;
      }
      case 'sign-up': {
        const result = await this.auth.signUp(
          this.displayName().trim(),
          this.email(),
          this.password(),
        );
        if (!result.ok) {
          this.report(result.message);
          return;
        }
        this.stage.set('verify-email');
        this.succeed('auth.checkInbox');
        return;
      }
      case 'forgot-password': {
        await this.auth.requestPasswordReset(this.email(), resetLink());
        // Intentionally unconditional: telling the user only on success would
        // turn this form into a test for whether an address is registered.
        this.succeed('auth.resetSent');
        return;
      }
      case 'reset-password': {
        const result = await this.auth.resetPassword(this.token, this.password());
        if (!result.ok) {
          this.report(result.message);
          return;
        }
        this.stage.set('sign-in');
        this.succeed('auth.resetDone');
        return;
      }
      case 'verify-email': {
        if (!this.email()) {
          this.succeed('auth.checkInbox');
          return;
        }
        await this.auth.resendVerification(this.email(), '/');
        this.succeed('auth.verificationSent');
        return;
      }
    }
  }

  /**
   * Notices hold rendered strings rather than keys, because about half of them
   * are the server's own message. Ours go through the same catalog the template
   * uses, so a locale change is not half-applied inside one dialog.
   */
  private report(message: string | undefined): void {
    this.failed.set(true);
    this.message.set(message ?? this.i18n.t('auth.genericError'));
  }

  private succeed(key: TranslationKey): void {
    this.failed.set(false);
    this.message.set(this.i18n.t(key));
  }
}

/** Where a reset link should land: this app, on the route that opens this dialog. */
function resetLink(): string {
  if (typeof window === 'undefined') return '/reset-password';
  return new URL('/reset-password', window.location.origin).toString();
}
