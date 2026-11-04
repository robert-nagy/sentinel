#!/usr/bin/env node
// Stage the current package version on npm (`npm stage publish`) instead of
// publishing it. A maintainer approves it afterwards with 2FA. See
// docs/RELEASING.md.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { planStage, readVersion } from './release-utils.js';

/** Run a command and capture its output without throwing. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const { name, version } = pkg;
const eventName = process.env.GITHUB_EVENT_NAME ?? '';
const before = process.env.RELEASE_BEFORE_SHA ?? '';

// Version before this push (only meaningful for push events on an existing branch).
let versionBefore;
if (eventName === 'push' && before !== '' && !/^0+$/.test(before)) {
  const previous = run('git', ['show', `${before}:package.json`]);
  versionBefore = previous.status === 0 ? readVersion(previous.stdout) : undefined;
}

const view = run('npm', ['view', `${name}@${version}`, 'version']);
const live = view.status === 0 && view.stdout.trim() === version;

const plan = planStage({ eventName, versionBefore, versionNow: version, live });
console.log(`${plan.action === 'stage' ? 'Staging' : 'Skipping'}: ${plan.reason}`);

if (plan.action === 'skip') {
  summary(`### Not staged\n\n${plan.reason}.`);
  process.exit(0);
}

const staged = run('npm', ['stage', 'publish', '--access', 'public', '--provenance']);
process.stdout.write(staged.stdout);
process.stderr.write(staged.stderr);

if (staged.status !== 0) {
  console.error(
    [
      '',
      `Staging ${name}@${version} failed.`,
      'If this version is already staged, approve or reject it under "Staged Packages" on',
      `https://www.npmjs.com/package/${name}, then re-run this workflow if needed.`,
      'If the error mentions permissions, check that the trusted publisher has "Allow npm stage publish" enabled.',
    ].join('\n'),
  );
  summary(`### Staging failed\n\n\`${name}@${version}\` could not be staged. See the job log.`);
  process.exit(1);
}

summary(
  [
    `### Staged ${name}@${version}`,
    '',
    'The package is in the npm stage queue and is **not installable yet**. Approve it with 2FA:',
    '',
    `- on https://www.npmjs.com/package/${name} → **Staged Packages** → **Approve**, or`,
    '- `npm stage list` then `npm stage approve <stage-id>` (npm 11.15 or newer).',
    '',
    'After approval, the next scheduled or manual run of this workflow tags the release on GitHub.',
  ].join('\n'),
);
