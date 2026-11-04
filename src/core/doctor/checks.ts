import type { CommandRunner } from '../exec.js';
import { WORKTREE_CLEANUP_THRESHOLD } from '../git-worktree-manager.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly message: string;
  /** Suggested fix, shown when the check does not pass. */
  readonly hint?: string | undefined;
}

export interface DoctorContext {
  readonly run: CommandRunner;
  /** `process.versions.node`, e.g. `22.11.0`. */
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
}

export const MIN_NODE_MAJOR = 22;
/** `git worktree` subcommands sentinel relies on are stable from 2.25 onwards. */
export const MIN_GIT_VERSION: Version = [2, 25, 0];

type Version = readonly [number, number, number];

/**
 * Upper bound for any single external command. Without it one hung process (for
 * example `gh auth status` waiting on the network) would stall the whole report.
 */
export const CHECK_TIMEOUT_MS = 10_000;

function exec(ctx: DoctorContext, command: string, args: readonly string[]) {
  return ctx.run(command, args, { cwd: ctx.cwd, timeoutMs: CHECK_TIMEOUT_MS });
}

const timeoutMessage = (what: string): string =>
  `${what} did not respond within ${CHECK_TIMEOUT_MS / 1000}s`;

/** Longest tool output prefix scanned for a version (version banners are short). */
const MAX_VERSION_INPUT = 256;

/**
 * Extracts the first `x.y.z` (or `x.y`) version found in `text`. Quantifiers are
 * bounded and input is truncated so untrusted tool output cannot trigger
 * catastrophic regex backtracking (ReDoS).
 */
export function parseVersion(text: string): Version | undefined {
  const match = /(?<!\d)(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?/.exec(
    text.slice(0, MAX_VERSION_INPUT),
  );
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const formatVersion = (v: Version): string => v.join('.');

export function checkNode(ctx: DoctorContext): CheckResult {
  const version = parseVersion(ctx.nodeVersion);
  const base = { id: 'node', title: 'Node.js' } as const;
  if (!version) {
    return {
      ...base,
      status: 'fail',
      message: `Could not parse Node.js version "${ctx.nodeVersion}"`,
    };
  }
  if (version[0] < MIN_NODE_MAJOR) {
    return {
      ...base,
      status: 'fail',
      message: `Node.js ${formatVersion(version)} is too old (need >= ${MIN_NODE_MAJOR})`,
      hint: `Install Node.js ${MIN_NODE_MAJOR} LTS or newer (https://nodejs.org).`,
    };
  }
  return { ...base, status: 'pass', message: `Node.js ${formatVersion(version)}` };
}

export async function checkGit(ctx: DoctorContext): Promise<CheckResult> {
  const base = { id: 'git', title: 'git' } as const;
  const result = await exec(ctx, 'git', ['--version']);
  if (result.timedOut) {
    return {
      ...base,
      status: 'warn',
      message: timeoutMessage('git'),
      hint: 'Re-run `sentinel doctor`.',
    };
  }
  if (result.notFound || result.exitCode !== 0) {
    return {
      ...base,
      status: 'fail',
      message: 'git is not installed or not on PATH',
      hint: 'Install git from https://git-scm.com/downloads.',
    };
  }
  const version = parseVersion(result.stdout);
  if (!version) {
    return {
      ...base,
      status: 'warn',
      message: `Unrecognised git version output: ${result.stdout.trim()}`,
    };
  }
  if (compareVersions(version, MIN_GIT_VERSION) < 0) {
    return {
      ...base,
      status: 'warn',
      message: `git ${formatVersion(version)} is older than ${formatVersion(MIN_GIT_VERSION)}; worktree commands may misbehave`,
      hint: 'Upgrade git.',
    };
  }
  return { ...base, status: 'pass', message: `git ${formatVersion(version)}` };
}

export async function checkGitRepository(ctx: DoctorContext): Promise<CheckResult> {
  const base = { id: 'git-repo', title: 'Git repository' } as const;
  const result = await exec(ctx, 'git', ['rev-parse', '--is-inside-work-tree']);
  if (result.timedOut) {
    return {
      ...base,
      status: 'warn',
      message: timeoutMessage('git'),
      hint: 'Re-run `sentinel doctor`.',
    };
  }
  if (result.exitCode === 0 && result.stdout.trim() === 'true') {
    return { ...base, status: 'pass', message: 'Current directory is inside a git work tree' };
  }
  return {
    ...base,
    status: 'warn',
    message: 'Current directory is not inside a git repository',
    hint: 'Run sentinel from a git repository (or `git init` one) to use repo-scoped commands.',
  };
}

export async function checkGh(ctx: DoctorContext): Promise<CheckResult> {
  const base = { id: 'gh', title: 'GitHub CLI' } as const;
  const result = await exec(ctx, 'gh', ['--version']);
  if (result.timedOut) {
    return {
      ...base,
      status: 'warn',
      message: timeoutMessage('gh'),
      hint: 'Re-run `sentinel doctor`.',
    };
  }
  if (result.notFound || result.exitCode !== 0) {
    return {
      ...base,
      status: 'warn',
      message:
        'gh is not installed; required for the GitHub code host (and useful when issues live on GitHub)',
      hint: 'Install the GitHub CLI from https://cli.github.com.',
    };
  }
  const version = parseVersion(result.stdout);
  return {
    ...base,
    status: 'pass',
    message: version ? `gh ${formatVersion(version)}` : 'gh is installed',
  };
}

export async function checkGhAuth(ctx: DoctorContext, ghAvailable: boolean): Promise<CheckResult> {
  const base = { id: 'gh-auth', title: 'GitHub authentication' } as const;
  if (!ghAvailable) {
    return { ...base, status: 'skip', message: 'Skipped: gh is not installed' };
  }
  const result = await exec(ctx, 'gh', ['auth', 'status']);
  if (result.timedOut) {
    return {
      ...base,
      status: 'warn',
      message: `Could not verify authentication: ${timeoutMessage('gh auth status')}`,
      hint: 'Check your network connection, then run `gh auth status`.',
    };
  }
  if (result.exitCode === 0) {
    return { ...base, status: 'pass', message: 'gh is authenticated' };
  }
  return {
    ...base,
    status: 'warn',
    message: 'gh is not authenticated',
    hint: 'Run `gh auth login`.',
  };
}

export async function checkWindowsLongPaths(ctx: DoctorContext): Promise<CheckResult> {
  const base = { id: 'git-longpaths', title: 'git core.longpaths (Windows)' } as const;
  if (ctx.platform !== 'win32') {
    return { ...base, status: 'skip', message: 'Skipped: only relevant on Windows' };
  }
  const result = await exec(ctx, 'git', ['config', '--get', 'core.longpaths']);
  if (result.timedOut) {
    return {
      ...base,
      status: 'warn',
      message: timeoutMessage('git'),
      hint: 'Re-run `sentinel doctor`.',
    };
  }
  if (result.exitCode === 0 && result.stdout.trim().toLowerCase() === 'true') {
    return { ...base, status: 'pass', message: 'core.longpaths is enabled' };
  }
  return {
    ...base,
    status: 'warn',
    message: 'core.longpaths is not enabled; deep worktree paths may exceed 260 characters',
    hint: 'Run `git config --global core.longpaths true`.',
  };
}

export async function checkWorktrees(ctx: DoctorContext): Promise<CheckResult> {
  const base = { id: 'worktrees', title: 'git worktrees' } as const;
  const result = await exec(ctx, 'git', ['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) {
    return { ...base, status: 'skip', message: 'Skipped: could not list worktrees' };
  }
  const extra = Math.max(
    0,
    result.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length - 1,
  );
  if (extra >= WORKTREE_CLEANUP_THRESHOLD) {
    return {
      ...base,
      status: 'warn',
      message: `${String(extra)} extra worktrees exist`,
      hint: 'Run `sentinel worktree prune --dry-run` to see which ones can be removed.',
    };
  }
  return { ...base, status: 'pass', message: `${String(extra)} extra worktrees` };
}
