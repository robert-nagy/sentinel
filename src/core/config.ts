import { dirname, join, win32, posix } from 'node:path';
import type { ZodError } from 'zod';
import {
  DEFAULT_CONFIG,
  configSchema,
  userConfigSchema,
  type SentinelConfig,
} from './config-schema.js';
import type { FileAccess } from './fs.js';
import { findRepoRoot } from './repo.js';

export const CONFIG_FILE_NAME = 'sentinel.config.json';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function formatIssues(source: string, error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    return `  - ${path === '' ? '(root)' : path}: ${issue.message}`;
  });
  return `invalid configuration in ${source}:\n${lines.join('\n')}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merges plain objects; arrays and scalars in `override` replace `base`. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || value === undefined) continue;
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

export interface GlobalConfigLocation {
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

/** `%APPDATA%\sentinel\config.json` on Windows, `$XDG_CONFIG_HOME` or `~/.config` elsewhere. */
export function globalConfigPath(location: GlobalConfigLocation): string {
  const { homeDir, env, platform } = location;
  if (platform === 'win32') {
    const base = env.APPDATA ?? win32.join(homeDir, 'AppData', 'Roaming');
    return win32.join(base, 'sentinel', 'config.json');
  }
  const base = env.XDG_CONFIG_HOME ?? posix.join(homeDir, '.config');
  return posix.join(base, 'sentinel', 'config.json');
}

/** Nearest `sentinel.config.json` from `cwd` up to (and including) the git root. */
export async function findRepoConfigPath(
  cwd: string,
  files: FileAccess,
): Promise<string | undefined> {
  const root = await findRepoRoot(cwd, files);
  let dir = cwd;
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (await files.exists(candidate)) return candidate;
    const parent = dirname(dir);
    if (dir === root || parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadConfigOptions extends GlobalConfigLocation {
  readonly cwd: string;
  readonly files: FileAccess;
}

export interface LoadedConfig {
  readonly config: SentinelConfig;
  /** Config files that contributed, lowest precedence first. */
  readonly sources: readonly string[];
}

async function readUserConfig(path: string, files: FileAccess): Promise<unknown> {
  const text = await files.readText(path);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`${path} is not valid JSON: ${reason}`);
  }
  const parsed = userConfigSchema.safeParse(json);
  if (!parsed.success) throw new ConfigError(formatIssues(path, parsed.error));
  const { $schema: _ignored, ...rest } = parsed.data;
  return rest;
}

/** Loads defaults, then the global config, then the repo config (later wins). */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const candidates = [
    globalConfigPath(options),
    await findRepoConfigPath(options.cwd, options.files),
  ];
  let merged: unknown = DEFAULT_CONFIG;
  const sources: string[] = [];
  for (const path of candidates) {
    if (path === undefined) continue;
    const user = await readUserConfig(path, options.files);
    if (user === undefined) continue;
    merged = deepMerge(merged, user);
    sources.push(path);
  }
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigError(formatIssues(sources.at(-1) ?? 'the merged configuration', result.error));
  }
  return { config: result.data, sources };
}
