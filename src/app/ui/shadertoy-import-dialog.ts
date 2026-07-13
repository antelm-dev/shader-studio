import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';

export interface ShadertoyImportDialogResult {
  name: string;
  source: string;
}

@Component({
  selector: 'app-shadertoy-import-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Import from Shadertoy</h2>
    <mat-dialog-content>
      <p class="intro">Paste the GLSL code from a Shadertoy Image pass.</p>
      <mat-form-field appearance="outline">
        <mat-label>Shader name</mat-label>
        <input
          matInput
          cdkFocusInitial
          [maxlength]="nameMaxLength"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
        />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>Shadertoy GLSL</mat-label>
        <textarea
          matInput
          rows="16"
          spellcheck="false"
          [ngModel]="source()"
          (ngModelChange)="source.set($event)"
        ></textarea>
        <mat-hint>Image shaders only; mainImage is converted automatically.</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">Cancel</button>
      <button matButton="filled" type="button" [disabled]="!valid()" (click)="confirm()">
        Import
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(760px, 82vw);
    }
    mat-form-field {
      display: block;
      width: 100%;
    }
    .intro {
      margin-top: 0;
    }
    textarea {
      font-family: var(--editor-font-family, monospace);
      font-size: 13px;
    }
  `,
})
export class ShadertoyImportDialog {
  private readonly dialogRef =
    inject<MatDialogRef<ShadertoyImportDialog, ShadertoyImportDialogResult>>(MatDialogRef);
  readonly nameMaxLength = LIMITS.nameLength;
  readonly name = signal('Imported Shadertoy');
  readonly source = signal('');

  valid(): boolean {
    return this.name().trim().length > 0 && this.source().trim().length > 0;
  }

  confirm(): void {
    if (this.valid()) {
      this.dialogRef.close({ name: this.name().trim(), source: this.source().trim() });
    }
  }
}
