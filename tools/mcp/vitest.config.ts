import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'dist-pack/**'],
    // Packaging invokes npm in a fresh process and can exceed the default on CI runners.
    testTimeout: 60_000,
  },
});
