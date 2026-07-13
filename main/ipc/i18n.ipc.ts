import { defineIpcModule, handle } from 'electron-ipc-module';

import { loadI18nCatalog } from '../../src/server/i18n-catalog';

export function createI18nIpc(i18nDir: string) {
  return defineIpcModule('i18n', {
    catalog: handle(async (_event, locale: string) => loadI18nCatalog(locale, i18nDir)),
  });
}
