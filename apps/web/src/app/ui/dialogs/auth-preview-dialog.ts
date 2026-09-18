import { Component, computed, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { TranslatePipe } from '../../i18n/translate.pipe';

type AuthMode = 'login' | 'signup';

@Component({
  selector: 'app-auth-preview-dialog',
  imports: [
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <div class="heading">
      <span class="mark" aria-hidden="true"><mat-icon>person</mat-icon></span>
      <div>
        <h2 mat-dialog-title>{{ 'auth.welcome' | translate }}</h2>
        <p>{{ 'auth.subtitle' | translate }}</p>
      </div>
    </div>

    <mat-dialog-content>
      <div class="mode" role="tablist" [attr.aria-label]="'auth.mode' | translate">
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="mode() === 'login'"
          [class.active]="mode() === 'login'"
          (click)="setMode('login')"
        >
          {{ 'auth.login' | translate }}
        </button>
        <button
          type="button"
          role="tab"
          [attr.aria-selected]="mode() === 'signup'"
          [class.active]="mode() === 'signup'"
          (click)="setMode('signup')"
        >
          {{ 'auth.createAccount' | translate }}
        </button>
      </div>

      <div class="preview-note" role="note">
        <mat-icon aria-hidden="true">science</mat-icon>
        <span>{{ 'auth.previewNotice' | translate }}</span>
      </div>

      @if (mode() === 'signup') {
        <mat-form-field appearance="outline">
          <mat-label>{{ 'auth.displayName' | translate }}</mat-label>
          <input
            matInput
            autocomplete="name"
            [value]="displayName()"
            (input)="displayName.set(inputValue($event))"
          />
        </mat-form-field>
      }

      <mat-form-field appearance="outline">
        <mat-label>{{ 'auth.email' | translate }}</mat-label>
        <input
          matInput
          cdkFocusInitial
          type="email"
          autocomplete="email"
          inputmode="email"
          [value]="email()"
          (input)="email.set(inputValue($event))"
        />
      </mat-form-field>

      <mat-form-field appearance="outline">
        <mat-label>{{ 'auth.password' | translate }}</mat-label>
        <input
          matInput
          type="password"
          [autocomplete]="mode() === 'login' ? 'current-password' : 'new-password'"
          [value]="password()"
          (input)="password.set(inputValue($event))"
          (keyup.enter)="submitPreview()"
        />
        @if (mode() === 'signup') {
          <mat-hint>{{ 'auth.passwordHint' | translate }}</mat-hint>
        }
      </mat-form-field>

      @if (submitted()) {
        <div class="preview-result" role="status">
          <mat-icon aria-hidden="true">check_circle</mat-icon>
          <span>{{ 'auth.previewComplete' | translate }}</span>
        </div>
      }
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.close' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="!canSubmit()" (click)="submitPreview()">
        {{ (mode() === 'login' ? 'auth.login' : 'auth.createAccount') | translate }}
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

    .preview-note,
    .preview-result {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 16px;
      padding: 10px 12px;
      border-radius: 10px;
      font: var(--mat-sys-body-small);
    }

    .preview-note {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .preview-result {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }

    .preview-note mat-icon,
    .preview-result mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    mat-form-field {
      width: 100%;
    }
  `,
})
export class AuthPreviewDialog {
  protected readonly mode = signal<AuthMode>('login');
  protected readonly displayName = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');
  protected readonly submitted = signal(false);

  protected readonly canSubmit = computed(() => {
    const hasIdentity = this.mode() === 'login' || this.displayName().trim().length > 0;
    return hasIdentity && this.email().includes('@') && this.password().length >= 8;
  });

  protected setMode(mode: AuthMode): void {
    this.mode.set(mode);
    this.submitted.set(false);
  }

  protected submitPreview(): void {
    if (!this.canSubmit()) return;
    this.password.set('');
    this.submitted.set(true);
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
