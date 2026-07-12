import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule } from '@angular/material/dialog';

export type UnsavedChoice = 'save' | 'discard' | 'cancel';

@Component({
  selector: 'app-unsaved-changes-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatDialogModule],
  template: `
    <h2 mat-dialog-title>Unsaved changes</h2>
    <mat-dialog-content
      >Your source or configuration has changes that have not been saved.</mat-dialog-content
    >
    <mat-dialog-actions align="end">
      <button matButton type="button" [mat-dialog-close]="'cancel'">Cancel</button>
      <button matButton="outlined" type="button" [mat-dialog-close]="'discard'">Discard</button>
      <button matButton="filled" type="button" cdkFocusInitial [mat-dialog-close]="'save'">
        Save
      </button>
    </mat-dialog-actions>
  `,
})
export class UnsavedChangesDialog {}
