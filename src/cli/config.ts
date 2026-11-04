import type { Command } from 'commander';
import { configJsonSchema } from '../core/config-schema.js';
import { findRepoConfigPath, globalConfigPath, loadConfig } from '../core/config.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

export function registerConfig(program: Command, deps: CliDeps): void {
  const config = program.command('config').description('Inspect sentinel configuration');
  const location = { homeDir: deps.homeDir, env: deps.env, platform: deps.platform };

  config
    .command('show')
    .description('Print the effective configuration (defaults + global + repo)')
    .option('--json', 'accepted for symmetry; output is always JSON')
    .action(
      guarded(deps, async () => {
        const loaded = await loadConfig({ cwd: deps.cwd, files: deps.files, ...location });
        deps.stdout(JSON.stringify(loaded.config, null, 2));
      }),
    );

  config
    .command('path')
    .description('Print the config files that contribute, lowest precedence first')
    .action(
      guarded(deps, async () => {
        const loaded = await loadConfig({ cwd: deps.cwd, files: deps.files, ...location });
        const repo = await findRepoConfigPath(deps.cwd, deps.files);
        deps.stdout(`global: ${globalConfigPath(location)}`);
        deps.stdout(`repo:   ${repo ?? '(none found)'}`);
        const used = loaded.sources.length === 0 ? '(defaults only)' : loaded.sources.join(', ');
        deps.stdout(`loaded: ${used}`);
      }),
    );

  config
    .command('schema')
    .description('Print the JSON Schema for sentinel.config.json')
    .action(() => {
      deps.stdout(JSON.stringify(configJsonSchema(), null, 2));
    });
}
