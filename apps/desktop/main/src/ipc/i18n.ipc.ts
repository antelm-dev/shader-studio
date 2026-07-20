import { defineIpcModule, handle } from 'electron-ipc-module';

import { loadI18nCatalog } from '@shader-studio/backend/i18n';

export function createI18nIpc(i18nDir: string) {
  return defineIpcModule('i18n', {
    catalog: handle(async (_event, locale: string) => loadI18nCatalog(locale, i18nDir)),
  });
}
