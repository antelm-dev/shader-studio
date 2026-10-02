import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';

import { TranslatePipe } from '../../i18n/translate.pipe';

export interface DeleteLinkedDialogData {
  name: string;
}

/** Deleting a shader linked to the account: closes with a `SyncRemoveMode`, or nothing. */
@Component({
  selector: 'app-delete-linked-dialog',
  imports: [MatButtonModule, MatDialogModule, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ 'dialog.deleteShader' | translate }}</h2>
    <mat-dialog-content>
      <p class="message">{{ 'dialog.deleteLinkedMessage' | translate: { name: data.name } }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton="outlined" cdkFocusInitial type="button" [mat-dialog-close]="'local'">
        {{ 'dialog.deleteHere' | translate }}
      </button>
      <button
        matButton="filled"
        class="destructive"
        type="button"
        [mat-dialog-close]="'everywhere'"
      >
        {{ 'dialog.deleteEverywhere' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .message {
      margin: 0;
      max-width: 44ch;
    }

    .destructive {
      --mat-button-filled-container-color: var(--mat-sys-error);
      --mat-button-filled-label-text-color: var(--mat-sys-on-error);
    }
  `,
})
export class DeleteLinkedDialog {
  readonly data = inject<DeleteLinkedDialogData>(MAT_DIALOG_DATA);
}
