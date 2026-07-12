import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

@Component({
  selector: 'app-recovery-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Recover local edits?</h2>
    <mat-dialog-content
      >The saved shader changed after this local draft was created.</mat-dialog-content
    >
    <mat-dialog-actions align="end">
      <button matButton="outlined" type="button" [mat-dialog-close]="false">
        Use saved version
      </button>
      <button matButton="filled" type="button" cdkFocusInitial [mat-dialog-close]="true">
        Restore local draft
      </button>
    </mat-dialog-actions>
  `,
})
export class RecoveryDialog {}
