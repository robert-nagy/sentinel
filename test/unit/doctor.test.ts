import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatDoctorReport,
  parseVersion,
  runDoctor,
  type DoctorContext,
} from '../../src/core/doctor/index.js';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '', notFound: false });
const failed = (stderr = 'error'): CommandResult => ({
  exitCode: 1,
  stdout: '',
  stderr,
  notFound: false,
});
const missing: CommandResult = { exitCode: null, stdout: '', stderr: 'ENOENT', notFound: true };

/** Fake runner keyed by "command arg1 arg2"; unknown commands are "not found". */
function fakeRunner(responses: Record<string, CommandResult>): CommandRunner {
  return (command, args) => Promise.resolve(responses[[command, ...args].join(' ')] ?? missing);
}

const healthy: Record<string, CommandResult> = {
  'git --version': ok('git version 2.47.1\n'),
  'git rev-parse --is-inside-work-tree': ok('true\n'),
  'gh --version': ok('gh version 2.89.0 (2026-03-26)\n'),
  'gh auth status': ok(),
  'git config --get core.longpaths': ok('true\n'),
};

function context(overrides: Partial<DoctorContext> = {}): DoctorContext {
  return {
    run: fakeRunner(healthy),
    nodeVersion: '22.11.0',
    platform: 'linux',
    cwd: '/repo',
    ...overrides,
  };
}

const statusOf = async (ctx: DoctorContext) =>
  Object.fromEntries((await runDoctor(ctx)).checks.map((c) => [c.id, c.status]));

describe('version helpers', () => {
  it('parses versions out of tool output', () => {
    expect(parseVersion('git version 2.47.1.windows.2')).toEqual([2, 47, 1]);
    expect(parseVersion('v22.11.0')).toEqual([22, 11, 0]);
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(parseVersion('no version here')).toBeUndefined();
  });

  it('compares versions', () => {
    expect(compareVersions([2, 25, 0], [2, 25, 0])).toBe(0);
    expect(compareVersions([2, 24, 9], [2, 25, 0])).toBeLessThan(0);
    expect(compareVersions([3, 0, 0], [2, 99, 99])).toBeGreaterThan(0);
  });
});

describe('runDoctor', () => {
  it('passes on a healthy Linux environment and skips Windows-only checks', async () => {
    const report = await runDoctor(context());
    expect(report.ok).toBe(true);
    expect(await statusOf(context())).toEqual({
      node: 'pass',
      git: 'pass',
      'git-repo': 'pass',
      gh: 'pass',
      'gh-auth': 'pass',
      'git-longpaths': 'skip',
    });
  });

  it('fails on Node.js older than 22', async () => {
    const report = await runDoctor(context({ nodeVersion: '20.18.0' }));
    expect(report.ok).toBe(false);
    const node = report.checks.find((c) => c.id === 'node');
    expect(node?.status).toBe('fail');
    expect(node?.hint).toContain('22');
  });

  it('fails when git is missing and skips the repository check', async () => {
    const { 'git --version': _git, ...rest } = healthy;
    const report = await runDoctor(context({ run: fakeRunner(rest) }));
    expect(report.ok).toBe(false);
    const ids = report.checks.map((c) => c.id);
    expect(ids).not.toContain('git-repo');
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('fail');
  });

  it('warns on an old git version', async () => {
    const run = fakeRunner({ ...healthy, 'git --version': ok('git version 2.20.0') });
    expect((await statusOf(context({ run }))).git).toBe('warn');
  });

  it('warns outside a git repository without failing', async () => {
    const run = fakeRunner({
      ...healthy,
      'git rev-parse --is-inside-work-tree': failed('fatal: not a git repository'),
    });
    const report = await runDoctor(context({ run }));
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'git-repo')?.status).toBe('warn');
  });

  it('warns when gh is missing and skips the auth check', async () => {
    const { 'gh --version': _gh, ...rest } = healthy;
    const statuses = await statusOf(context({ run: fakeRunner(rest) }));
    expect(statuses.gh).toBe('warn');
    expect(statuses['gh-auth']).toBe('skip');
  });

  it('warns when gh is not authenticated', async () => {
    const run = fakeRunner({ ...healthy, 'gh auth status': failed('not logged in') });
    expect((await statusOf(context({ run })))['gh-auth']).toBe('warn');
  });

  it('checks core.longpaths on Windows', async () => {
    expect((await statusOf(context({ platform: 'win32' })))['git-longpaths']).toBe('pass');

    const run = fakeRunner({ ...healthy, 'git config --get core.longpaths': failed('') });
    expect((await statusOf(context({ platform: 'win32', run })))['git-longpaths']).toBe('warn');
  });
});

describe('formatDoctorReport', () => {
  it('renders symbols, hints for non-passing checks and a summary line', async () => {
    const run = fakeRunner({ ...healthy, 'gh auth status': failed() });
    const text = formatDoctorReport(await runDoctor(context({ run })));
    expect(text).toContain('✔ Node.js: Node.js 22.11.0');
    expect(text).toContain('⚠ GitHub authentication: gh is not authenticated');
    expect(text).toContain('→ Run `gh auth login`.');
    expect(text).toMatch(/OK: 4 passed, 1 warnings, 0 failed, 1 skipped$/);
  });

  it('reports FAILED when any check fails', async () => {
    const text = formatDoctorReport(await runDoctor(context({ nodeVersion: '18.0.0' })));
    expect(text).toMatch(/^FAILED:/m);
  });
});
