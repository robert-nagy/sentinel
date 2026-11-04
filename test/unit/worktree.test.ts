import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import {
  GitWorktreeManager,
  WorktreeError,
  parseWorktreeList,
} from '../../src/core/git-worktree-manager.js';

const TIMEOUT = 90_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand('git', args, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

let tmp: string;
let work: string;
let origin: string;

async function commitFile(cwd: string, name: string, content: string): Promise<void> {
  await writeFile(join(cwd, name), content, 'utf8');
  await git(cwd, 'add', name);
  await git(cwd, 'commit', '-q', '-m', `add ${name}`);
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'sentinel-wt-')));
  origin = join(tmp, 'origin.git');
  work = join(tmp, 'work');
  await git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  await git(tmp, 'init', '-q', '-b', 'main', work);
  await git(work, 'config', 'user.name', 'Test');
  await git(work, 'config', 'user.email', 'test@example.com');
  await git(work, 'config', 'commit.gpgsign', 'false');
  await commitFile(work, 'README.md', '# repo\n');
  await writeFile(join(work, '.env.example'), 'KEY=value\n', 'utf8');
  await git(work, 'add', '.env.example');
  await git(work, 'commit', '-q', '-m', 'env example');
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-q', '-u', 'origin', 'main');
}, TIMEOUT);

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}, TIMEOUT);

const manager = (config = DEFAULT_CONFIG) =>
  new GitWorktreeManager({ repoRoot: work, config, run: runCommand });

describe('parseWorktreeList', () => {
  it('parses branches, detached heads and paths with spaces', () => {
    const output = [
      'worktree /r',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /r/with space',
      'HEAD def',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreeList(output)).toEqual([
      { path: '/r', head: 'abc', branch: 'main' },
      { path: '/r/with space', head: 'def', branch: undefined },
    ]);
  });
});

describe('GitWorktreeManager (real git)', () => {
  it(
    'creates a worktree on a new branch from origin/main',
    async () => {
      const result = await manager().create(42, 'feat/42-login');
      expect(result).toMatchObject({
        path: join(work, '.worktrees', '42'),
        branch: 'feat/42-login',
        branchSource: 'new',
        alreadyExisted: false,
        copiedFiles: ['.env.example'],
        gitignoreUpdated: true,
      });
      expect(await git(result.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/42-login');
      expect(await readFile(join(result.path, '.env.example'), 'utf8')).toBe('KEY=value\n');
      expect(await readFile(join(work, '.gitignore'), 'utf8')).toBe('.worktrees/\n');
      // Pushing the branch must not target main.
      const upstream = await runCommand('git', ['config', 'branch.feat/42-login.remote'], {
        cwd: work,
      });
      expect(upstream.stdout.trim()).toBe('');
    },
    TIMEOUT,
  );

  it(
    'is idempotent for an existing worktree',
    async () => {
      const first = await manager().create(7, 'feat/7');
      const second = await manager().create(7, 'feat/7');
      expect(second).toMatchObject({ alreadyExisted: true, branch: 'feat/7' });
      expect(await exists(first.path)).toBe(true);
      expect(await readFile(join(work, '.gitignore'), 'utf8')).toBe('.worktrees/\n');
    },
    TIMEOUT,
  );

  it(
    'does not touch .gitignore when the root is already ignored',
    async () => {
      await writeFile(join(work, '.gitignore'), '.worktrees/\n', 'utf8');
      const result = await manager().create(1, 'feat/1');
      expect(result.gitignoreUpdated).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'reuses an existing local branch',
    async () => {
      await git(work, 'branch', 'feat/9');
      const result = await manager().create(9, 'feat/9');
      expect(result.branchSource).toBe('local');
    },
    TIMEOUT,
  );

  it(
    'tracks an existing remote branch',
    async () => {
      await git(work, 'branch', 'feat/5');
      await git(work, 'push', '-q', 'origin', 'feat/5');
      await git(work, 'branch', '-D', 'feat/5');
      const result = await manager().create(5, 'feat/5');
      expect(result.branchSource).toBe('remote');
      const remote = await git(work, 'config', 'branch.feat/5.remote');
      expect(remote).toBe('origin');
    },
    TIMEOUT,
  );

  it(
    'refuses a directory that is not the worktree',
    async () => {
      await mkdir(join(work, '.worktrees', '3'), { recursive: true });
      await expect(manager().create(3, 'feat/3')).rejects.toThrow(/already exists/);
    },
    TIMEOUT,
  );

  it(
    'refuses a branch checked out in another worktree',
    async () => {
      await manager().create(1, 'feat/shared');
      await expect(manager().create(2, 'feat/shared')).rejects.toThrow(/already checked out/);
    },
    TIMEOUT,
  );

  it(
    'warns about a dirty main tree and about copyFiles outside the repo',
    async () => {
      await writeFile(join(work, 'dirty.txt'), 'x', 'utf8');
      const config = {
        ...DEFAULT_CONFIG,
        worktrees: { ...DEFAULT_CONFIG.worktrees, copyFiles: ['../secret', 'missing.txt'] },
      };
      const result = await manager(config).create(4, 'feat/4');
      expect(result.warnings.join('\n')).toContain('uncommitted changes');
      expect(result.warnings.join('\n')).toContain('outside the repository');
      expect(result.copiedFiles).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'fails clearly when origin/<default> is unknown',
    async () => {
      const config = { ...DEFAULT_CONFIG, codeHost: { ...DEFAULT_CONFIG.codeHost, defaultBranch: 'nope' } };
      await expect(manager(config).create(1, 'feat/1')).rejects.toThrow(WorktreeError);
    },
    TIMEOUT,
  );

  it(
    'lists only managed worktrees and removes them',
    async () => {
      const m = manager();
      await m.create(1, 'feat/1');
      await m.create(2, 'feat/2');
      const listed = await m.list();
      expect(listed.map((w) => w.branch).sort()).toEqual(['feat/1', 'feat/2']);

      const removed = await m.remove(1);
      expect(removed.branch).toBe('feat/1');
      expect(await exists(join(work, '.worktrees', '1'))).toBe(false);
      expect((await m.list()).map((w) => w.branch)).toEqual(['feat/2']);
      await expect(m.remove(1)).rejects.toThrow(/no worktree/);
    },
    TIMEOUT,
  );

  it(
    'refuses to remove a dirty worktree unless forced',
    async () => {
      const m = manager();
      const { path } = await m.create(1, 'feat/1');
      await writeFile(join(path, 'wip.txt'), 'x', 'utf8');
      await expect(m.remove(1)).rejects.toThrow(WorktreeError);
      await m.remove(1, { force: true });
      expect(await exists(path)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'prunes merged clean worktrees only',
    async () => {
      const m = manager();
      const merged = await m.create(1, 'feat/merged');
      const ahead = await m.create(2, 'feat/ahead');
      const dirty = await m.create(3, 'feat/dirty');
      await commitFile(ahead.path, 'work.txt', 'x');
      await writeFile(join(dirty.path, 'wip.txt'), 'x', 'utf8');

      const dry = await m.prune({ dryRun: true });
      expect(dry.removed.map((w) => w.branch)).toEqual(['feat/merged']);
      expect(await exists(merged.path)).toBe(true);

      const result = await m.prune();
      expect(result.removed.map((w) => w.branch)).toEqual(['feat/merged']);
      expect(result.skipped.map((s) => s.reason).sort()).toEqual([
        'branch is not merged',
        'has uncommitted changes',
      ]);
      expect(await exists(merged.path)).toBe(false);
      expect(await exists(ahead.path)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'honours a custom merged predicate (for example the code host)',
    async () => {
      const m = manager();
      const ahead = await m.create(2, 'feat/ahead');
      await commitFile(ahead.path, 'work.txt', 'x');
      const result = await m.prune({ isMerged: () => Promise.resolve(true) });
      expect(result.removed.map((w) => w.branch)).toEqual(['feat/ahead']);
    },
    TIMEOUT,
  );
});

describe('sentinel worktree (CLI, real git)', () => {
  it(
    'adds a worktree named from the branch template and prints its path',
    async () => {
      const out: string[] = [];
      const err: string[] = [];
      const deps = {
        run: runCommand,
        files: nodeFiles,
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
        setExitCode: () => undefined,
        nodeVersion: process.versions.node,
        platform: process.platform,
        cwd: work,
        homeDir: tmp,
        env: { XDG_CONFIG_HOME: join(tmp, 'xdg'), APPDATA: join(tmp, 'appdata') },
        now: () => new Date('2026-03-05T12:00:00Z'),
      };
      const argv = (...args: string[]) => ['node', 'sentinel', ...args];

      expect(await main(argv('worktree', 'add', '42', '--title', 'Add login'), deps)).toBe(0);
      expect(out).toEqual([join(work, '.worktrees', '42')]);
      expect(await git(join(work, '.worktrees', '42'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(
        'feat/42-add-login',
      );

      out.length = 0;
      expect(await main(argv('worktree', 'list', '--json'), deps)).toBe(0);
      expect((JSON.parse(out.join('\n')) as { branch: string }[])[0]?.branch).toBe(
        'feat/42-add-login',
      );

      out.length = 0;
      expect(await main(argv('worktree', 'remove', '42'), deps)).toBe(0);
      expect(out[0]).toContain('removed');
      expect(err).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    'exits 1 outside a git repository',
    async () => {
      const err: string[] = [];
      let code = 0;
      const deps = {
        run: runCommand,
        files: nodeFiles,
        stdout: () => undefined,
        stderr: (t: string) => err.push(t),
        setExitCode: (c: number) => {
          code = c;
        },
        nodeVersion: process.versions.node,
        platform: process.platform,
        cwd: tmp,
        homeDir: tmp,
        env: {},
        now: () => new Date(),
      };
      await main(['node', 'sentinel', 'worktree', 'list'], deps);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('not inside a git repository');
    },
    TIMEOUT,
  );
});
