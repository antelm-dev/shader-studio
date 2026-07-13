import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';

/** An extra yes/no the prompt can carry alongside the name. */
export interface PromptDialogOption {
  label: string;
  hint?: string;
  checked?: boolean;
}

export interface PromptDialogData {
  title: string;
  label: string;
  value?: string;
  confirmText?: string;
  hint?: string;
  option?: PromptDialogOption;
}

export interface PromptDialogResult {
  value: string;
  /** The state of `data.option`, or `false` when the prompt had none. */
  checked: boolean;
}

/** One-line text prompt: naming a new shader, a duplicate, a rename, a preset. */
@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
  ],
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

      @if (data.option; as option) {
        <mat-checkbox class="option" [checked]="checked()" (change)="checked.set($event.checked)">
          {{ option.label }}
        </mat-checkbox>
        @if (option.hint) {
          <p class="option-hint">{{ option.hint }}</p>
        }
      }
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

    .option {
      display: block;
      margin-top: 4px;
    }

    .option-hint {
      margin: 0 0 4px 32px;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class PromptDialog {
  private readonly dialogRef = inject<MatDialogRef<PromptDialog, PromptDialogResult>>(MatDialogRef);
  readonly data = inject<PromptDialogData>(MAT_DIALOG_DATA);

  readonly maxLength = LIMITS.nameLength;
  readonly value = signal(this.data.value ?? '');
  readonly checked = signal(this.data.option?.checked ?? false);

  valid(): boolean {
    return this.value().trim().length > 0;
  }

  confirm(): void {
    if (this.valid()) {
      this.dialogRef.close({ value: this.value().trim(), checked: this.checked() });
    }
  }
}
