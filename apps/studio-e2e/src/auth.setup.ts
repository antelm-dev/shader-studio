import { test as setup, expect } from '@playwright/test';

import { STORAGE_STATE } from './fixtures';

// The store is fresh on every run, so the account is always new. With
// verification off, the sign-up response sets the session cookie.
setup('sign up the test account', async ({ request, baseURL }) => {
  const response = await request.post('/api/auth/sign-up/email', {
    headers: { origin: baseURL! },
    data: { name: 'E2E', email: 'e2e@example.test', password: 'e2e-test-password' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  await request.storageState({ path: STORAGE_STATE });
});
