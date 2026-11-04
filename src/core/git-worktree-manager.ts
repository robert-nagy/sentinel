import { constants } from 'node:fs';
import { appendFile, copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { normalizeIssueId } from './branch-namer.js';
import type { CommandResult, CommandRunner } from './exec.js';
import type { SentinelConfig } from './config-schema.js';

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeInfo {
  readonly path: string;
  /** Branch name without `refs/heads/`; `undefined` for a detached HEAD. */
  readonly branch: string | undefined;
  readonly head: string | undefined;
}

export interface CreateWorktreeResult {
  readonly path: string;
  readonly branch: string;
  /** `new` = branch created from the default branch, `local`/`remote` = existing branch reused. */
  readonly branchSource: 'new' | 'local' | 'remote';
  /** True when the worktree already existed for this branch and nothing was changed. */
  readonly alreadyExisted: boolean;
  readonly copiedFiles: readonly string[];
  readonly gitignoreUpdated: boolean;
  readonly warnings: readonly string[];
}

export interface PruneResult {
  readonly removed: readonly WorktreeInfo[];
  readonly skipped: readonly { readonly worktree: WorktreeInfo; readonly reason: string }[];
}

export interface WorktreeManagerOptions {
  /** Top-level directory of the main work tree. */
  readonly repoRoot: string;
  readonly config: Pick<SentinelConfig, 'worktrees' | 'codeHost'>;
  readonly run: CommandRunner;
  readonly platform?: NodeJS.Platform | undefined;
}

const GIT_TIMEOUT_MS = 120_000;

/** Parses `git worktree list --porcelain`. */
export function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  for (const block of output.split(/\r?\n\r?\n/)) {
    let path: string | undefined;
    let branch: string | undefined;
    let head: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (path !== undefined) worktrees.push({ path, branch, head });
  }
  return worktrees;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath.native(path);
  } catch {
    return resolve(path);
  }
}

async function samePath(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([canonical(a), canonical(b)]);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `child` is `parent` or inside it (purely lexical). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class GitWorktreeManager {
  private readonly repoRoot: string;
  private readonly config: WorktreeManagerOptions['config'];
  private readonly run: CommandRunner;
  private readonly platform: NodeJS.Platform;

  constructor(options: WorktreeManagerOptions) {
    this.repoRoot = options.repoRoot;
    this.config = options.config;
    this.run = options.run;
    this.platform = options.platform ?? process.platform;
  }

  /** Absolute directory holding all sentinel worktrees. */
  get root(): string {
    return resolve(this.repoRoot, this.config.worktrees.root);
  }

  /** Where the worktree for an issue lives. */
  pathFor(issueId: string | number): string {
    return join(this.root, normalizeIssueId(issueId));
  }

  private git(args: readonly string[], cwd = this.repoRoot): Promise<CommandResult> {
    return this.run('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
  }

  private async mustGit(args: readonly string[], cwd = this.repoRoot): Promise<string> {
    const result = await this.git(args, cwd);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim() || 'no output';
      throw new WorktreeError(`git ${args.slice(0, 2).join(' ')} failed: ${detail}`);
    }
    return result.stdout;
  }

  private async refExists(ref: string): Promise<boolean> {
    return (await this.git(['show-ref', '--verify', '--quiet', ref])).exitCode === 0;
  }

  /** All worktrees of the repository (the main one included). */
  async listAll(): Promise<WorktreeInfo[]> {
    return parseWorktreeList(await this.mustGit(['worktree', 'list', '--porcelain']));
  }

  /** Worktrees living under the configured worktree root. */
  async list(): Promise<WorktreeInfo[]> {
    const root = await canonical(this.root).catch(() => this.root);
    const managed: WorktreeInfo[] = [];
    for (const worktree of await this.listAll()) {
      const path = await canonical(worktree.path);
      if (path !== root && isInside(root, path)) managed.push(worktree);
    }
    return managed;
  }

  /**
   * Creates (or reuses) the worktree for an issue on `branch`. Idempotent: calling it
   * again for an existing worktree on the same branch changes nothing.
   */
  async create(issueId: string | number, branch: string): Promise<CreateWorktreeResult> {
    const path = this.pathFor(issueId);
    const warnings: string[] = [];
    const defaultBranch = this.config.codeHost.defaultBranch;
    const base = `origin/${defaultBranch}`;

    const existing = (await this.listAll()).find((w) => w.branch === branch);
    if (existing !== undefined) {
      if (await samePath(existing.path, path)) {
        return {
          path: existing.path,
          branch,
          branchSource: 'local',
          alreadyExisted: true,
          copiedFiles: [],
          gitignoreUpdated: false,
          warnings,
        };
      }
      throw new WorktreeError(`branch ${branch} is already checked out at ${existing.path}`);
    }
    if (await this.pathExists(path)) {
      throw new WorktreeError(`${path} already exists but is not a worktree for ${branch}`);
    }

    const status = await this.git(['status', '--porcelain']);
    if (status.exitCode === 0 && status.stdout.trim() !== '') {
      warnings.push('the main working tree has uncommitted changes (they are not copied)');
    }

    const fetched = await this.git(['fetch', '--quiet', 'origin', defaultBranch]);
    if (fetched.exitCode !== 0) {
      const reason = (fetched.stderr || 'fetch failed').trim();
      if (!(await this.refExists(`refs/remotes/${base}`))) {
        throw new WorktreeError(`cannot fetch ${base} and no local copy exists: ${reason}`);
      }
      warnings.push(`could not fetch ${base}; using the existing local copy (${reason})`);
    }

    const prefix = this.platform === 'win32' ? ['-c', 'core.longpaths=true'] : [];
    let branchSource: CreateWorktreeResult['branchSource'];
    if (await this.refExists(`refs/heads/${branch}`)) {
      branchSource = 'local';
      await this.mustGit([...prefix, 'worktree', 'add', path, branch]);
    } else if (await this.refExists(`refs/remotes/origin/${branch}`)) {
      branchSource = 'remote';
      await this.mustGit([...prefix, 'worktree', 'add', '--track', '-b', branch, path, `origin/${branch}`]);
    } else {
      branchSource = 'new';
      if (!(await this.refExists(`refs/remotes/${base}`))) {
        throw new WorktreeError(`${base} does not exist; is the default branch "${defaultBranch}" correct?`);
      }
      await this.mustGit([...prefix, 'worktree', 'add', '--no-track', '-b', branch, path, base]);
    }

    const copiedFiles = await this.copyFiles(path, warnings);
    const gitignoreUpdated = await this.ensureIgnored();
    return { path, branch, branchSource, alreadyExisted: false, copiedFiles, gitignoreUpdated, warnings };
  }

  /** Removes the worktree of an issue. Git refuses when it has local changes unless `force`. */
  async remove(issueId: string | number, options: { force?: boolean } = {}): Promise<WorktreeInfo> {
    const path = this.pathFor(issueId);
    let target: WorktreeInfo | undefined;
    for (const worktree of await this.list()) {
      if (await samePath(worktree.path, path)) target = worktree;
    }
    if (target === undefined) throw new WorktreeError(`no worktree for issue ${String(issueId)} at ${path}`);
    await this.mustGit(['worktree', 'remove', ...(options.force === true ? ['--force'] : []), target.path]);
    return target;
  }

  /**
   * Removes clean worktrees whose branch `isMerged` reports as merged, then prunes stale
   * worktree records. Defaults to "branch is an ancestor of origin/<default>".
   */
  async prune(
    options: { dryRun?: boolean; isMerged?: (branch: string) => Promise<boolean> } = {},
  ): Promise<PruneResult> {
    const isMerged = options.isMerged ?? ((branch: string) => this.isAncestorOfDefault(branch));
    const removed: WorktreeInfo[] = [];
    const skipped: { worktree: WorktreeInfo; reason: string }[] = [];

    for (const worktree of await this.list()) {
      if (worktree.branch === undefined) {
        skipped.push({ worktree, reason: 'detached HEAD' });
        continue;
      }
      if (!(await isMerged(worktree.branch))) {
        skipped.push({ worktree, reason: 'branch is not merged' });
        continue;
      }
      const status = await this.git(['status', '--porcelain'], worktree.path);
      if (status.exitCode !== 0 || status.stdout.trim() !== '') {
        skipped.push({ worktree, reason: 'has uncommitted changes' });
        continue;
      }
      if (options.dryRun !== true) {
        await this.mustGit(['worktree', 'remove', worktree.path]);
        // Best effort: `-d` refuses if git cannot prove the merge (for example squash merges).
        await this.git(['branch', '-d', worktree.branch]);
      }
      removed.push(worktree);
    }
    if (options.dryRun !== true) await this.git(['worktree', 'prune']);
    return { removed, skipped };
  }

  private async isAncestorOfDefault(branch: string): Promise<boolean> {
    const base = `origin/${this.config.codeHost.defaultBranch}`;
    const result = await this.git(['merge-base', '--is-ancestor', `refs/heads/${branch}`, base]);
    return result.exitCode === 0;
  }

  private async pathExists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  private async copyFiles(worktreePath: string, warnings: string[]): Promise<string[]> {
    const copied: string[] = [];
    for (const file of this.config.worktrees.copyFiles) {
      const source = resolve(this.repoRoot, file);
      const target = resolve(worktreePath, file);
      if (!isInside(this.repoRoot, source) || !isInside(worktreePath, target)) {
        warnings.push(`skipped copyFiles entry outside the repository: ${file}`);
        continue;
      }
      try {
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target, constants.COPYFILE_EXCL);
        copied.push(file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'EISDIR') {
          warnings.push(`could not copy ${file}: ${(error as Error).message}`);
        }
      }
    }
    return copied;
  }

  /** Adds the worktree root to `.gitignore` unless git already ignores it. */
  private async ensureIgnored(): Promise<boolean> {
    const rel = relative(this.repoRoot, this.root);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
    const entry = rel.split(sep).join('/');
    const ignored = await this.git(['check-ignore', '-q', `${entry}/probe`]);
    if (ignored.exitCode === 0) return false;

    const gitignore = join(this.repoRoot, '.gitignore');
    let current = '';
    try {
      current = await readFile(gitignore, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(gitignore, `${separator}${entry}/\n`, 'utf8');
    return true;
  }
}
