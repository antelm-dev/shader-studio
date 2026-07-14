import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

import { TranslatePipe } from '../../i18n/translate.pipe';

@Component({
  selector: 'app-recovery-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'dialog.recoveryTitle' | translate }}</h2>
    <mat-dialog-content>{{ 'dialog.recoveryMessage' | translate }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton="outlined" type="button" [mat-dialog-close]="false">
        {{ 'dialog.useSaved' | translate }}
      </button>
      <button matButton="filled" type="button" cdkFocusInitial [mat-dialog-close]="true">
        {{ 'dialog.restoreDraft' | translate }}
      </button>
    </mat-dialog-actions>
  `,
})
export class RecoveryDialog {}
