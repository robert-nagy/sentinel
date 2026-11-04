import type { Command } from 'commander';
import { analyze, formatStackReport, installCommands } from '../core/stack-analyzer.js';
import { findRepoRoot } from '../core/repo.js';
import type { CliDeps } from './deps.js';

export function registerAnalyze(program: Command, deps: CliDeps): void {
  program
    .command('analyze')
    .description('Detect the project stack and the test tooling for each tier')
    .option('--json', 'output machine-readable JSON')
    .option('--install', 'also print the commands that install the missing test tooling')
    .action(async (options: { json?: boolean; install?: boolean }) => {
      const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
      const report = await analyze(root, deps.files);
      const install = options.install === true ? installCommands(report) : undefined;
      if (options.json === true) {
        deps.stdout(JSON.stringify(install ? { ...report, install } : report, null, 2));
        return;
      }
      deps.stdout(formatStackReport(report));
      if (install) {
        deps.stdout('');
        deps.stdout(
          install.length === 0
            ? 'Nothing to install: every test tier is covered.'
            : [
                'Install commands (review, then run them yourself):',
                ...install.map((i) => `  [${i.path}] ${i.tier}: ${i.command}`),
              ].join('\n'),
        );
      }
    });
}
