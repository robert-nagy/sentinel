import { dirname, join } from 'node:path';
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
