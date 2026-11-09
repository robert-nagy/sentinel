import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

/**
 * The CLI as one dependency-free file (`dist-bundle/sentinel.mjs`). `scripts/build-plugin.js`
 * copies it into every skill folder so a skill can run `node scripts/sentinel.mjs` after a
 * plain `git clone` with no `npm install` (ADR-0006).
 */
export default defineConfig({
  entry: { sentinel: 'src/bin/sentinel.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist-bundle',
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  splitting: false,
  dts: false,
  sourcemap: false,
  minify: false,
  noExternal: [/.*/],
  // commander is CommonJS: give bundled `require` calls something to resolve against.
  banner: {
    js: "import { createRequire as __sentinelCreateRequire } from 'node:module';\nconst require = __sentinelCreateRequire(import.meta.url);",
  },
  define: {
    __SENTINEL_VERSION__: JSON.stringify(pkg.version),
  },
});
