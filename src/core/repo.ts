import { basename, dirname, join } from 'node:path';
import type { CommandRunner } from './exec.js';
import type { FileAccess } from './fs.js';

/**
 * Finds the root of the git work tree containing `startDir`: the nearest ancestor
 * (including `startDir`) with a `.git` entry. A directory entry for normal clones, a
 * file for linked worktrees and submodules, so only existence is checked.
 */
export async function findRepoRoot(
  startDir: string,
  files: Pick<FileAccess, 'exists'>,
): Promise<string | undefined> {
  let dir = startDir;
  for (;;) {
    if (await files.exists(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The main checkout of the repository containing `cwd`: the parent of git's common
 * directory. In a linked worktree that is the checkout the worktree was made from; elsewhere
 * it is the repository root. Falls back to `fallback` when git cannot tell (bare repository,
 * git missing).
 */
export async function findMainRoot(
  run: CommandRunner,
  cwd: string,
  fallback: string,
): Promise<string> {
  const result = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
  });
  const dir = result.exitCode === 0 ? result.stdout.trim() : '';
  if (dir === '' || basename(dir) !== '.git') return fallback;
  return dirname(dir);
}
