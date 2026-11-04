import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  deepMerge,
  findRepoConfigPath,
  globalConfigPath,
  loadConfig,
} from '../../src/core/config.js';
import { DEFAULT_CONFIG, configJsonSchema } from '../../src/core/config-schema.js';
import type { FileAccess } from '../../src/core/fs.js';

function memory(entries: Record<string, string>): FileAccess {
  const tree = new Map(Object.entries(entries));
  return {
    readText: (path) => Promise.resolve(tree.get(path)),
    exists: (path) => Promise.resolve(tree.has(path)),
  };
}

const repo = join('/work', 'repo');
const repoGit = join(repo, '.git');
const repoConfig = join(repo, 'sentinel.config.json');
const globalPath = '/home/u/.config/sentinel/config.json';
const base = { homeDir: '/home/u', env: {}, platform: 'linux' as const };

describe('globalConfigPath', () => {
  it('uses XDG_CONFIG_HOME when set', () => {
    expect(globalConfigPath({ ...base, env: { XDG_CONFIG_HOME: '/x' } })).toBe(
      '/x/sentinel/config.json',
    );
  });
  it('defaults to ~/.config on posix', () => {
    expect(globalConfigPath(base)).toBe(globalPath);
  });
  it('uses APPDATA on Windows', () => {
    expect(
      globalConfigPath({
        homeDir: 'C:\\Users\\u',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\sentinel\\config.json');
  });
});

describe('deepMerge', () => {
  it('merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2], d: 3 } })).toEqual({
      a: { b: 1, c: [2], d: 3 },
    });
  });
  it('ignores __proto__ keys', () => {
    const merged = deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}')) as object;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(merged)).toEqual([]);
  });
});

describe('findRepoConfigPath', () => {
  it('finds the config in a parent directory within the repo', async () => {
    const files = memory({ [repoGit]: '', [repoConfig]: '{}' });
    expect(await findRepoConfigPath(join(repo, 'a', 'b'), files)).toBe(repoConfig);
  });
  it('does not look above the repo root', async () => {
    const files = memory({ [repoGit]: '', [join('/work', 'sentinel.config.json')]: '{}' });
    expect(await findRepoConfigPath(join(repo, 'a'), files)).toBeUndefined();
  });
});

describe('loadConfig', () => {
  const load = (entries: Record<string, string>) =>
    loadConfig({ ...base, cwd: repo, files: memory({ [repoGit]: '', ...entries }) });

  it('returns defaults with no files', async () => {
    const { config, sources } = await load({});
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(sources).toEqual([]);
  });
  it('layers global under repo', async () => {
    const { config, sources } = await load({
      [globalPath]: JSON.stringify({ prd: { threshold: 90 }, rfc: { dir: 'rfc' } }),
      [repoConfig]: JSON.stringify({ prd: { maxRefinements: 1 }, $schema: 'x' }),
    });
    expect(config.prd).toEqual({
      dir: 'docs/prd',
      threshold: 90,
      dimensionFloor: 70,
      maxRefinements: 1,
    });
    expect(config.rfc.dir).toBe('rfc');
    expect(sources).toEqual([globalPath, repoConfig]);
  });
  it('rejects malformed JSON', async () => {
    await expect(load({ [repoConfig]: '{nope' })).rejects.toThrow(/not valid JSON/);
  });
  it('rejects unknown keys with the path in the message', async () => {
    await expect(load({ [repoConfig]: '{"prd":{"treshold":1}}' })).rejects.toThrow(/prd/);
  });
  it('rejects out-of-range values', async () => {
    await expect(load({ [repoConfig]: '{"prd":{"threshold":150}}' })).rejects.toThrow(ConfigError);
  });
  it('rejects a floor above the threshold', async () => {
    await expect(load({ [repoConfig]: '{"prd":{"dimensionFloor":95}}' })).rejects.toThrow(
      /dimensionFloor/,
    );
  });
  it('rejects bad branch templates', async () => {
    await expect(load({ [repoConfig]: '{"branches":{"bugfix":"fix/{nope}"}}' })).rejects.toThrow(
      /unknown placeholder/,
    );
  });
});

describe('configJsonSchema', () => {
  it('describes every section', () => {
    const schema = configJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(
      [
        '$schema',
        'babysit',
        'branches',
        'codeHost',
        'issueProvider',
        'prd',
        'rfc',
        'testing',
        'worktrees',
      ].sort(),
    );
  });
});
