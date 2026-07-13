import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';

import { DesktopUpdater } from '../core/desktop-updater';

@Component({
  selector: 'app-desktop-version-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>Version desktop</h2>
    <mat-dialog-content>
      <div class="identity">
        <div>
          <strong>Shader Studio</strong
          ><span>Version {{ updater.state().currentVersion || '—' }}</span>
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
          [attr.aria-label]="'Téléchargement de la mise à jour : ' + progressLabel()"
        />
        <span class="progress">{{ progressLabel() }}</span>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" mat-dialog-close>Fermer</button>
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

  protected readonly statusText = computed(() => {
    const state = this.updater.state();
    switch (state.status) {
      case 'unavailable':
        return state.message ?? 'Mise à jour automatique indisponible.';
      case 'idle':
      case 'checking':
        return 'Recherche d’une mise à jour…';
      case 'up-to-date':
        return 'Vous utilisez la dernière version.';
      case 'available':
        return `La version ${state.availableVersion} est disponible.`;
      case 'downloading':
        return `Téléchargement de la version ${state.availableVersion}…`;
      case 'downloaded':
        return `La version ${state.availableVersion} est prête à être installée.`;
      case 'error':
        return state.message
          ? `Échec de la vérification : ${state.message}`
          : 'Échec de la vérification.';
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
        return 'À jour';
      case 'available':
        return 'Mettre à jour';
      case 'downloaded':
        return 'Redémarrer et mettre à jour';
      case 'error':
        return 'Réessayer';
      case 'unavailable':
        return 'Indisponible';
      case 'downloading':
        return 'Téléchargement…';
      default:
        return 'Vérification…';
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
