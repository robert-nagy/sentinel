import { loadConfig } from '../core/config.js';
import type { CliDeps } from './deps.js';

/** Commander collector for repeatable options. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Loads the effective configuration for the current working directory. */
export function loadCliConfig(deps: CliDeps) {
  return loadConfig({
    cwd: deps.cwd,
    files: deps.files,
    homeDir: deps.homeDir,
    env: deps.env,
    platform: deps.platform,
  });
}
