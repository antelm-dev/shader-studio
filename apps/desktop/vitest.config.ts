import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['main/src/**/*.spec.ts'],
    environment: 'node',
  },
});
