import { defineConfig } from 'vitest/config';

// E2E tests run against the built CLI in dist/ — run `npm run build` first.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
