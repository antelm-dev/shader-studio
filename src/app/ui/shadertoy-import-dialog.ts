import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';
import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';

export interface ShadertoyImportDialogResult {
  name: string;
  source: string;
}

@Component({
  selector: 'app-shadertoy-import-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'shadertoy.title' | translate }}</h2>
    <mat-dialog-content>
      <p class="intro">{{ 'shadertoy.intro' | translate }}</p>
      <mat-form-field appearance="outline">
        <mat-label>{{ 'shadertoy.name' | translate }}</mat-label>
        <input
          matInput
          cdkFocusInitial
          [maxlength]="nameMaxLength"
          [ngModel]="name()"
          (ngModelChange)="name.set($event)"
        />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>{{ 'shadertoy.source' | translate }}</mat-label>
        <textarea
          matInput
          rows="16"
          spellcheck="false"
          [ngModel]="source()"
          (ngModelChange)="source.set($event)"
        ></textarea>
        <mat-hint>{{ 'shadertoy.hint' | translate }}</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="!valid()" (click)="confirm()">
        {{ 'shadertoy.import' | translate }}
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
  private readonly i18n = inject(I18n);
  readonly nameMaxLength = LIMITS.nameLength;
  readonly name = signal(this.i18n.t('shadertoy.defaultName'));
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
