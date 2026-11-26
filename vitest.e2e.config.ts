import { defineConfig } from 'vitest/config';

// E2E tests: cli.test.ts runs the built CLI in dist/ (run `npm run build` first);
// plugin-install.test.ts runs the committed plugin bundle and needs no build.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
