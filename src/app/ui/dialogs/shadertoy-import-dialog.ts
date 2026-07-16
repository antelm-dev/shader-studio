import { Component, inject, signal } from '@angular/core';
import { FormField, form, maxLength, requiredError, validate } from '@angular/forms/signals';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { LIMITS } from '@shader-studio/shared/validate';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { Preferences } from '../../prefs/preferences';

export type ShadertoyImportDialogResult =
  | { mode: 'api'; idOrUrl: string; apiKey: string }
  | { mode: 'paste'; name: string; source: string };

interface ApiModel {
  idOrUrl: string;
  apiKey: string;
}

interface PasteModel {
  name: string;
  source: string;
}

@Component({
  selector: 'app-shadertoy-import-dialog',
  imports: [
    FormField,
    MatButtonModule,
    MatButtonToggleModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslatePipe,
  ],
  template: `
    <h2 mat-dialog-title>{{ 'shadertoy.title' | translate }}</h2>
    <mat-dialog-content>
      <mat-button-toggle-group
        class="mode"
        [value]="mode()"
        (valueChange)="mode.set($event)"
      >
        <mat-button-toggle value="api">{{ 'shadertoy.modeApi' | translate }}</mat-button-toggle>
        <mat-button-toggle value="paste">{{ 'shadertoy.modePaste' | translate }}</mat-button-toggle>
      </mat-button-toggle-group>

      @if (mode() === 'api') {
        <p class="intro">{{ 'shadertoy.apiIntro' | translate }}</p>
        <mat-form-field appearance="outline">
          <mat-label>{{ 'shadertoy.idOrUrl' | translate }}</mat-label>
          <input
            matInput
            cdkFocusInitial
            [formField]="apiForm.idOrUrl"
            placeholder="https://www.shadertoy.com/view/XsBSRR"
          />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>{{ 'shadertoy.apiKey' | translate }}</mat-label>
          <input matInput [formField]="apiForm.apiKey" />
          <mat-hint>{{ 'shadertoy.apiKeyHint' | translate }}</mat-hint>
        </mat-form-field>
      } @else {
        <p class="intro">{{ 'shadertoy.intro' | translate }}</p>
        <mat-form-field appearance="outline">
          <mat-label>{{ 'shadertoy.name' | translate }}</mat-label>
          <input matInput [formField]="pasteForm.name" />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>{{ 'shadertoy.source' | translate }}</mat-label>
          <textarea matInput rows="14" spellcheck="false" [formField]="pasteForm.source"></textarea>
          <mat-hint>{{ 'shadertoy.hint' | translate }}</mat-hint>
        </mat-form-field>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button">{{ 'action.cancel' | translate }}</button>
      <button matButton="filled" type="button" [disabled]="invalid()" (click)="confirm()">
        {{ 'shadertoy.import' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      width: min(760px, 82vw);
    }
    .mode {
      display: flex;
      margin-bottom: 16px;
    }
    mat-button-toggle {
      flex: 1;
      text-align: center;
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
  private readonly preferences = inject(Preferences);

  protected readonly mode = signal<'api' | 'paste'>('api');

  protected readonly apiModel = signal<ApiModel>({
    idOrUrl: '',
    apiKey: this.preferences.value().shadertoyApiKey ?? '',
  });
  protected readonly apiForm = form(this.apiModel, (path) => {
    validate(path.idOrUrl, ({ value }) =>
      value().trim().length > 0 ? undefined : requiredError(),
    );
    validate(path.apiKey, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
  });

  protected readonly pasteModel = signal<PasteModel>({
    name: this.i18n.t('shadertoy.defaultName'),
    source: '',
  });
  protected readonly pasteForm = form(this.pasteModel, (path) => {
    maxLength(path.name, LIMITS.nameLength);
    validate(path.name, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
    validate(path.source, ({ value }) => (value().trim().length > 0 ? undefined : requiredError()));
  });

  protected invalid(): boolean {
    return this.mode() === 'api' ? this.apiForm().invalid() : this.pasteForm().invalid();
  }

  confirm(): void {
    if (this.invalid()) return;

    if (this.mode() === 'api') {
      const { idOrUrl, apiKey } = this.apiModel();
      const trimmedKey = apiKey.trim();
      this.preferences.patch({ shadertoyApiKey: trimmedKey });
      this.dialogRef.close({ mode: 'api', idOrUrl: idOrUrl.trim(), apiKey: trimmedKey });
      return;
    }

    const { name, source } = this.pasteModel();
    this.dialogRef.close({ mode: 'paste', name: name.trim(), source: source.trim() });
  }
}
