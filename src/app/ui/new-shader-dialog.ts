import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';

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
  ],
  template: `
    <h2 mat-dialog-title>New shader</h2>
    <mat-dialog-content>
      <mat-form-field appearance="outline" class="field">
        <mat-label>Name</mat-label>
        <input
          matInput
          cdkFocusInitial
          [maxlength]="maxLength"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
          (keyup.enter)="create()"
        />
        <mat-hint>Starts from a small template you can edit straight away</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">Cancel</button>
      <button matButton type="button" (click)="importShadertoy()">
        <mat-icon>code</mat-icon>
        Import from Shadertoy…
      </button>
      <button matButton="filled" type="button" [disabled]="!valid()" (click)="create()">
        Create
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
