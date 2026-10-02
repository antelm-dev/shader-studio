import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/desktop/main/**/*.spec.ts'],
    environment: 'node',
  },
});
