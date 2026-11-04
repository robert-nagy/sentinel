import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateError, StateStore } from '../../src/core/state.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sentinel-state-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('returns undefined for missing state', async () => {
    expect(await new StateStore(root).read('nope')).toBeUndefined();
  });
  it('round-trips JSON and leaves no temp files', async () => {
    const store = new StateStore(root);
    await store.write('run-1', { attempts: 2 });
    await store.write('run-1', { attempts: 3 });
    expect(await store.read('run-1')).toEqual({ attempts: 3 });
    expect(await readdir(store.dir)).toEqual(['run-1.json']);
  });
  it('removes state and tolerates removing twice', async () => {
    const store = new StateStore(root);
    await store.write('a', 1);
    await store.remove('a');
    await store.remove('a');
    expect(await store.read('a')).toBeUndefined();
  });
  it('rejects path-like names', async () => {
    const store = new StateStore(root);
    for (const name of ['../x', 'a/b', 'a\\b', '', '.hidden', 'a..b']) {
      await expect(store.write(name, 1)).rejects.toThrow(StateError);
    }
  });
  it('reports corrupt files clearly', async () => {
    const store = new StateStore(root);
    await mkdir(store.dir, { recursive: true });
    await writeFile(join(store.dir, 'bad.json'), '{oops', 'utf8');
    await expect(store.read('bad')).rejects.toThrow(/corrupt/);
  });
});
