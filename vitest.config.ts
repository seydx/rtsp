import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['src/__tests__/setup.ts'],
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/index.ts'],
      reporter: ['text', 'html'],
    },
  },
});
