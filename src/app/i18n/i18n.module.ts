import { NgModule, Pipe, PipeTransform, inject } from '@angular/core';

import { I18n, type TranslationParams } from './i18n';
import type { TranslationKey } from './keys';

@Pipe({ name: 'translate', standalone: true, pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);

  transform(key: TranslationKey, params?: TranslationParams): string {
    return this.i18n.t(key, params);
  }
}

@NgModule({ imports: [TranslatePipe], exports: [TranslatePipe] })
export class I18nModule {}
