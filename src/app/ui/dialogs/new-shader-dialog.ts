import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';
import { TranslatePipe } from '../i18n/translate.pipe';

export type NewShaderDialogResult = { action: 'create'; name: string } | { action: 'shadertoy' };

@Component({
  selector: 'app-new-shader-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
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
        <input
          matInput
          cdkFocusInitial
          [maxlength]="maxLength"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
          (keyup.enter)="create()"
        />
        <mat-hint>{{ 'dialog.newShaderHint' | translate }}</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton type="button" (click)="importShadertoy()">
        <mat-icon>code</mat-icon>
        {{ 'action.importShadertoy' | translate }}
      </button>
      <button matButton="filled" type="button" [disabled]="!valid()" (click)="create()">
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
  readonly maxLength = LIMITS.nameLength;
  readonly name = signal('');

  valid(): boolean {
    return this.name().trim().length > 0;
  }

  create(): void {
    if (this.valid()) this.dialogRef.close({ action: 'create', name: this.name().trim() });
  }

  importShadertoy(): void {
    this.dialogRef.close({ action: 'shadertoy' });
  }
}
