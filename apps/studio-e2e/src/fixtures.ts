import { resolve } from 'node:path';

import { test as base, expect } from '@playwright/test';

/** The signed-in session `auth.setup.ts` saves and every other test starts from. */
export const STORAGE_STATE = resolve(import.meta.dirname, '../.auth/user.json');

/** `page`, signed in, and failing its test on any uncaught error in the app. */
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await use(page);
    expect(errors, 'uncaught errors in the page').toEqual([]);
  },
});

export { expect };
