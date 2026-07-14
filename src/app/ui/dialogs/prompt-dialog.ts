import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormField, form, maxLength, requiredError, validate } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';
import { TranslatePipe } from '../../i18n/translate.pipe';

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
  checked: boolean;
}

@Component({
  selector: 'app-prompt-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormField,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>

    <mat-dialog-content>
      <mat-form-field appearance="outline" class="field">
        <mat-label>{{ data.label }}</mat-label>
        <input matInput cdkFocusInitial [formField]="form.value" (keyup.enter)="confirm()" />
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
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="form().invalid()" (click)="confirm()">
        {{ data.confirmText ?? ('action.save' | translate) }}
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

  readonly checked = signal(this.data.option?.checked ?? false);

  protected readonly model = signal({ value: this.data.value ?? '' });
  protected readonly form = form(this.model, (path) => {
    maxLength(path.value, LIMITS.nameLength);
    validate(path.value, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
  });

  confirm(): void {
    if (this.form().invalid()) return;
    this.dialogRef.close({ value: this.model().value.trim(), checked: this.checked() });
  }
}
