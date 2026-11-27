import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../src/core/exec.js';
import { findMainRoot, findRepoRoot } from '../../src/core/repo.js';

const files = (paths: string[]) => ({
  exists: (p: string) => Promise.resolve(paths.includes(p)),
});

describe('findRepoRoot', () => {
  const root = join('/w', 'repo');
  it('finds the nearest ancestor with .git', async () => {
    expect(await findRepoRoot(join(root, 'a', 'b'), files([join(root, '.git')]))).toBe(root);
  });
  it('accepts the start directory itself', async () => {
    expect(await findRepoRoot(root, files([join(root, '.git')]))).toBe(root);
  });
  it('returns undefined outside a repo', async () => {
    expect(await findRepoRoot(join(root, 'a'), files([]))).toBeUndefined();
  });
});

describe('findMainRoot', () => {
  const answer =
    (stdout: string, exitCode = 0): CommandRunner =>
    () =>
      Promise.resolve({ exitCode, stdout, stderr: '', notFound: false, timedOut: false });

  it('is the parent of the common .git directory', async () => {
    expect(
      await findMainRoot(answer('/home/u/repo/.git\n'), '/home/u/repo/.worktrees/3', '/x'),
    ).toBe('/home/u/repo');
  });

  it('falls back for bare repositories and git errors', async () => {
    expect(await findMainRoot(answer('/srv/repo.git\n'), '/srv', '/fb')).toBe('/fb');
    expect(await findMainRoot(answer('', 128), '/srv', '/fb')).toBe('/fb');
  });
});
