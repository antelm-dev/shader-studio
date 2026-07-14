import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: 'node',
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'dist/**', 'dist-pack/**'],
    testTimeout: 20_000,
  },
});
