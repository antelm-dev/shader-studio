import { Component, inject, signal } from '@angular/core';
import { FormField, form, maxLength, requiredError, validate } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';
import { TranslatePipe } from '../../i18n/translate.pipe';

export type NewShaderDialogResult = { action: 'create'; name: string } | { action: 'shadertoy' };

interface NewShaderModel {
  name: string;
}

@Component({
  selector: 'app-new-shader-dialog',
  imports: [
    FormField,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'dialog.newShader' | translate }}</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="field">
        <mat-label>{{ 'dialog.name' | translate }}</mat-label>
        <input matInput cdkFocusInitial [formField]="form.name" (keyup.enter)="create()" />
        <mat-hint>{{ 'dialog.newShaderHint' | translate }}</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton type="button" (click)="importShadertoy()">
        <mat-icon>code</mat-icon>
        {{ 'action.importShadertoy' | translate }}
      </button>
      <button matButton="filled" type="button" [disabled]="form().invalid()" (click)="create()">
        {{ 'action.create' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .field {
      width: min(460px, 72vw);
    }
  `,
})
export class NewShaderDialog {
  private readonly dialogRef =
    inject<MatDialogRef<NewShaderDialog, NewShaderDialogResult>>(MatDialogRef);

  protected readonly model = signal<NewShaderModel>({ name: '' });
  protected readonly form = form(this.model, (path) => {
    maxLength(path.name, LIMITS.nameLength);
    validate(path.name, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
  });

  create(): void {
    if (this.form().invalid()) return;
    this.dialogRef.close({ action: 'create', name: this.model().name.trim() });
  }

  importShadertoy(): void {
    this.dialogRef.close({ action: 'shadertoy' });
  }
}
