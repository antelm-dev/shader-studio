import { Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { DesktopUpdater } from '../../desktop/desktop-updater';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';

@Component({
  selector: 'app-desktop-version-dialog',
  imports: [MatButtonModule, MatDialogModule, MatIconModule, MatProgressBarModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'desktop.versionTitle' | translate }}</h2>
    <mat-dialog-content>
      <div class="identity">
        <div>
          <strong>Shader Studio</strong>
          <span>{{
            'desktop.versionLabel' | translate: { version: updater.state().currentVersion || '—' }
          }}</span>
        </div>
      </div>
      <div class="status" aria-live="polite">
        <mat-icon [class.error]="updater.state().status === 'error'">{{ statusIcon() }}</mat-icon>
        <span>{{ statusText() }}</span>
      </div>
      @if (updater.state().status === 'downloading') {
        <mat-progress-bar
          mode="determinate"
          [value]="updater.state().progress ?? 0"
          [attr.aria-label]="'desktop.downloadProgress' | translate: { progress: progressLabel() }"
        />
        <span class="progress">{{ progressLabel() }}</span>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" mat-dialog-close>{{ 'action.close' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="actionDisabled()" (click)="runAction()">
        <mat-icon [class.spin]="isBusy()">{{ isBusy() ? 'sync' : actionIcon() }}</mat-icon>
        {{ actionLabel() }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(420px, 78vw);
      padding-top: 8px;
    }
    .identity {
      display: flex;
      align-items: center;
      gap: 18px;
      padding-block: 8px 24px;
    }
    .identity div {
      display: grid;
      gap: 4px;
    }
    .identity strong {
      font: var(--mat-sys-title-large);
    }
    .identity span,
    .progress {
      color: var(--mat-sys-on-surface-variant);
    }
    .status {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      min-height: 48px;
      padding: 12px;
      border-radius: var(--mat-sys-corner-medium);
      background: var(--mat-sys-surface-container);
      color: var(--mat-sys-on-surface-variant);
    }
    .status mat-icon {
      color: var(--mat-sys-primary);
    }
    .status mat-icon.error {
      color: var(--mat-sys-error);
    }
    mat-progress-bar {
      margin-top: 16px;
    }
    .progress {
      display: block;
      margin-top: 6px;
      text-align: right;
      font: var(--mat-sys-label-small);
    }
    .spin {
      animation: spin 900ms linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spin {
        animation: none;
      }
    }
  `,
})
export class DesktopVersionDialog {
  protected readonly updater = inject(DesktopUpdater);
  private readonly i18n = inject(I18n);

  protected readonly statusText = computed(() => {
    const state = this.updater.state();
    switch (state.status) {
      case 'unavailable':
        return state.message ?? this.i18n.t('desktop.unavailable');
      case 'idle':
      case 'checking':
        return this.i18n.t('desktop.checking');
      case 'up-to-date':
        return this.i18n.t('desktop.upToDate');
      case 'available':
        return this.i18n.t('desktop.available', { version: state.availableVersion ?? '' });
      case 'downloading':
        return this.i18n.t('desktop.downloading', { version: state.availableVersion ?? '' });
      case 'downloaded':
        return this.i18n.t('desktop.downloaded', { version: state.availableVersion ?? '' });
      case 'error':
        return state.message
          ? this.i18n.t('desktop.checkFailed', { error: state.message })
          : this.i18n.t('desktop.checkFailedGeneric');
    }
  });

  protected readonly statusIcon = computed(() => {
    switch (this.updater.state().status) {
      case 'up-to-date':
        return 'check_circle';
      case 'available':
      case 'downloaded':
        return 'system_update';
      case 'error':
        return 'error';
      case 'unavailable':
        return 'info';
      default:
        return 'sync';
    }
  });

  protected readonly actionLabel = computed(() => {
    switch (this.updater.state().status) {
      case 'up-to-date':
        return this.i18n.t('desktop.actionUpToDate');
      case 'available':
        return this.i18n.t('desktop.actionUpdate');
      case 'downloaded':
        return this.i18n.t('desktop.actionRestart');
      case 'error':
        return this.i18n.t('desktop.actionRetry');
      case 'unavailable':
        return this.i18n.t('desktop.actionUnavailable');
      case 'downloading':
        return this.i18n.t('desktop.actionDownloading');
      default:
        return this.i18n.t('desktop.actionChecking');
    }
  });

  protected readonly actionIcon = computed(() =>
    this.updater.state().status === 'up-to-date' ? 'check' : 'download',
  );
  protected readonly isBusy = computed(() =>
    ['idle', 'checking', 'downloading'].includes(this.updater.state().status),
  );
  protected readonly actionDisabled = computed(() =>
    ['unavailable', 'idle', 'checking', 'up-to-date', 'downloading'].includes(
      this.updater.state().status,
    ),
  );
  protected readonly progressLabel = computed(
    () => `${Math.round(this.updater.state().progress ?? 0)} %`,
  );

  protected runAction(): void {
    if (this.updater.state().status === 'error') void this.updater.check();
    else this.updater.update();
  }
}
