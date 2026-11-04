import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  define: {
    __SENTINEL_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['test/unit/**/*.test.{ts,js}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/bin/**', 'src/env.d.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 85,
      },
    },
  },
});
