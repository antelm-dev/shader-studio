import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

import { TranslatePipe } from '../i18n/i18n.module';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

@Component({
  selector: 'app-unsaved-changes-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'dialog.unsavedTitle' | translate }}</h2>
    <mat-dialog-content>{{ 'dialog.unsavedMessage' | translate }}</mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton type="button" [mat-dialog-close]="'cancel'">
        {{ 'action.cancel' | translate }}
      </button>
      <button matButton="outlined" type="button" [mat-dialog-close]="'discard'">
        {{ 'dialog.discard' | translate }}
      </button>
      <button matButton="filled" type="button" cdkFocusInitial [mat-dialog-close]="'save'">
        {{ 'action.save' | translate }}
      </button>
    </mat-dialog-actions>
  `,
})
export class UnsavedChangesDialog {}
