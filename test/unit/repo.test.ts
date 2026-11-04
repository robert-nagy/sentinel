import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../../src/core/repo.js';

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
