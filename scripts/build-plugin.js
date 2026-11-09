// Builds the plugin, or checks it (ADR-0006).
//   node scripts/build-plugin.js                 rebuild bundle copies, manifests and schema
//   node scripts/build-plugin.js --check         committed plugin is internally consistent (every PR)
//   node scripts/build-plugin.js --verify-fresh  committed bundle equals a fresh build (release only)
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { buildPlugin, checkConsistency, verifyFresh } from './plugin-lib.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const flag = process.argv[2];

if (flag === undefined) {
  buildPlugin(root);
  process.stdout.write('plugin built\n');
} else if (flag === '--check' || flag === '--verify-fresh') {
  const problems = flag === '--check' ? checkConsistency(root) : verifyFresh(root);
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`- ${problem}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      flag === '--check' ? 'plugin is consistent\n' : 'plugin bundle is fresh\n',
    );
  }
} else {
  process.stderr.write(`unknown option ${flag}; use --check or --verify-fresh\n`);
  process.exitCode = 2;
}
