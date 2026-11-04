import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  compareVersions,
  formatDoctorReport,
  parseVersion,
  runDoctor,
  type DoctorContext,
} from '../../src/core/doctor/index.js';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});
const failed = (stderr = 'error'): CommandResult => ({
  exitCode: 1,
  stdout: '',
  stderr,
  notFound: false,
  timedOut: false,
});
const missing: CommandResult = {
  exitCode: null,
  stdout: '',
  stderr: 'ENOENT',
  notFound: true,
  timedOut: false,
};
const timedOut: CommandResult = {
  exitCode: null,
  stdout: '',
  stderr: '',
  notFound: false,
  timedOut: true,
};

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

  it('handles pathological input quickly (no ReDoS)', () => {
    const hostile = '9'.repeat(100_000);
    const start = performance.now();
    expect(parseVersion(hostile)).toBeUndefined();
    expect(parseVersion(`${hostile}.1.2`)).toBeUndefined();
    expect(performance.now() - start).toBeLessThan(100);
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

describe('runDoctor timeouts and concurrency', () => {
  it('reports a gh auth timeout as a warning, not as "not authenticated"', async () => {
    const run = fakeRunner({ ...healthy, 'gh auth status': timedOut });
    const report = await runDoctor(context({ run }));
    const auth = report.checks.find((c) => c.id === 'gh-auth');
    expect(report.ok).toBe(true);
    expect(auth?.status).toBe('warn');
    expect(auth?.message).toContain('did not respond');
    expect(auth?.message).not.toContain('not authenticated');
  });

  it('turns a timed-out git into a warning instead of crashing the report', async () => {
    const run = fakeRunner({ ...healthy, 'git --version': timedOut });
    const report = await runDoctor(context({ run }));
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('warn');
    expect(report.ok).toBe(true);
  });

  it('bounds every external command with the check timeout', async () => {
    const run = vi.fn<CommandRunner>(() =>
      Promise.resolve(ok('git version 2.47.1 gh version 2.89.0')),
    );
    await runDoctor(context({ run, platform: 'win32' }));
    expect(run).toHaveBeenCalled();
    for (const call of run.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: CHECK_TIMEOUT_MS, cwd: '/repo' });
    }
  });

  it('runs the git and gh groups concurrently but keeps the report order stable', async () => {
    const started: string[] = [];
    const run: CommandRunner = async (command, args) => {
      started.push([command, ...args].join(' '));
      // Make git slower than gh so a sequential runner would finish git first.
      await new Promise((resolve) => setTimeout(resolve, command === 'git' ? 30 : 1));
      return healthy[[command, ...args].join(' ')] ?? missing;
    };
    const report = await runDoctor(context({ run, platform: 'win32' }));

    // gh was started before the (slow) git checks had finished.
    expect(started.indexOf('gh --version')).toBeLessThan(
      started.indexOf('git rev-parse --is-inside-work-tree'),
    );
    expect(report.checks.map((c) => c.id)).toEqual([
      'node',
      'git',
      'git-repo',
      'worktrees',
      'gh',
      'gh-auth',
      'git-longpaths',
    ]);
  });
});

describe('formatDoctorReport', () => {
  it('renders symbols, hints for non-passing checks and a summary line', async () => {
    const run = fakeRunner({ ...healthy, 'gh auth status': failed() });
    const text = formatDoctorReport(await runDoctor(context({ run })));
    expect(text).toContain('✔ Node.js: Node.js 22.11.0');
    expect(text).toContain('⚠ GitHub authentication: gh is not authenticated');
    expect(text).toContain('→ Run `gh auth login`.');
    expect(text).toMatch(/OK: 4 passed, 1 warnings, 0 failed, 2 skipped$/);
  });

  it('reports FAILED when any check fails', async () => {
    const text = formatDoctorReport(await runDoctor(context({ nodeVersion: '18.0.0' })));
    expect(text).toMatch(/^FAILED:/m);
  });
});

describe('worktrees check', () => {
  const porcelain = (extra: number) =>
    ['worktree /repo\nHEAD a\nbranch refs/heads/main\n']
      .concat(
        Array.from({ length: extra }, (_, i) => `worktree /repo/.worktrees/${String(i)}\nHEAD b\n`),
      )
      .join('\n');
  const statusFor = async (extra: number) => {
    const run = fakeRunner({ ...healthy, 'git worktree list --porcelain': ok(porcelain(extra)) });
    const report = await runDoctor(context({ run }));
    return report.checks.find((c) => c.id === 'worktrees');
  };

  it('passes with few extra worktrees', async () => {
    expect((await statusFor(2))?.status).toBe('pass');
  });
  it('warns and suggests pruning from five extra worktrees on', async () => {
    const check = await statusFor(5);
    expect(check?.status).toBe('warn');
    expect(check?.hint).toContain('worktree prune');
  });
});
