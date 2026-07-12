import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '../../shared/validate';

export interface PromptDialogData {
  title: string;
  label: string;
  value?: string;
  confirmText?: string;
  hint?: string;
}

/** One-line text prompt: naming a new shader, a duplicate, a rename, a preset. */
@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>

    <mat-dialog-content>
      <mat-form-field appearance="outline" class="field">
        <mat-label>{{ data.label }}</mat-label>
        <input
          matInput
          cdkFocusInitial
          [maxlength]="maxLength"
          [ngModel]="value()"
          (ngModelChange)="value.set($event)"
          (keyup.enter)="confirm()"
        />
        @if (data.hint) {
          <mat-hint>{{ data.hint }}</mat-hint>
        }
      </mat-form-field>
    </mat-dialog-content>

    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">Cancel</button>
      <button matButton="filled" type="button" [disabled]="!valid()" (click)="confirm()">
        {{ data.confirmText ?? 'Save' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .field {
      width: min(420px, 70vw);
    }
  `,
})
export class PromptDialog {
  private readonly dialogRef = inject<MatDialogRef<PromptDialog, string>>(MatDialogRef);
  readonly data = inject<PromptDialogData>(MAT_DIALOG_DATA);

  readonly maxLength = LIMITS.nameLength;
  readonly value = signal(this.data.value ?? '');

  valid(): boolean {
    return this.value().trim().length > 0;
  }

  confirm(): void {
    if (this.valid()) this.dialogRef.close(this.value().trim());
  }
}
