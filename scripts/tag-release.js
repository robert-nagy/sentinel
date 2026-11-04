#!/usr/bin/env node
// Once a staged version has been approved and is live on npm, create the matching
// git tag and GitHub release. Safe to run repeatedly: does nothing if the version
// is not live yet or the release already exists. Needs the GitHub CLI (GH_TOKEN)
// and a full-history checkout.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractChangelogSection, isPrerelease, versionLinePattern } from './release-utils.js';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
const tag = `v${version}`;

const view = run('npm', ['view', `${name}@${version}`, 'version']);
if (!(view.status === 0 && view.stdout.trim() === version)) {
  console.log(
    `${name}@${version} is not published on npm yet (awaiting approval?). Nothing to tag.`,
  );
  process.exit(0);
}

const existing = run('gh', ['release', 'view', tag]);
if (existing.status === 0) {
  console.log(`GitHub release ${tag} already exists.`);
  process.exit(0);
}

// The commit that introduced this version: the oldest commit whose diff touches its
// `"version": "<version>"` line (a later bump away from it would come after).
const introduced = run('git', [
  'log',
  '--reverse',
  '--format=%H',
  `-G${versionLinePattern(version)}`,
  '--',
  'package.json',
]);
const target = introduced.stdout.split('\n').find((line) => line !== '') ?? process.env.GITHUB_SHA;

let notes = `Release ${tag}`;
if (existsSync('CHANGELOG.md')) {
  notes = extractChangelogSection(readFileSync('CHANGELOG.md', 'utf8'), version) ?? notes;
}
const notesFile = join(mkdtempSync(join(tmpdir(), 'sentinel-release-')), 'notes.md');
writeFileSync(notesFile, `${notes}\n`);

const args = ['release', 'create', tag, '--title', tag, '--notes-file', notesFile];
if (target) args.push('--target', target);
if (isPrerelease(version)) args.push('--prerelease');

const created = run('gh', args);
process.stdout.write(created.stdout);
process.stderr.write(created.stderr);
if (created.status !== 0) {
  console.error(`Failed to create GitHub release ${tag}.`);
  process.exit(1);
}

summary(`### Released ${name}@${version}\n\nCreated tag and GitHub release \`${tag}\`.`);
