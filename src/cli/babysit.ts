import type { Command } from 'commander';
import { ExitCode } from '../core/exit-codes.js';
import { GitHubCodeHost } from '../core/hosts/github.js';
import { babysit, type BabysitAction } from '../core/pr-babysitter.js';
import { findRepoRoot } from '../core/repo.js';
import { StateStore } from '../core/state.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

const EXIT: Record<BabysitAction, number> = {
  done: ExitCode.Ok,
  wait: ExitCode.Ok,
  rerun: ExitCode.Ok,
  patch: ExitCode.Refine,
  'give-up': ExitCode.Escalate,
};

export function registerBabysit(program: Command, deps: CliDeps): void {
  program
    .command('babysit')
    .description('Watch a pull request until CI is green, needs a fix, or sentinel gives up')
    .argument('<pr>', 'pull request number or URL')
    .option('--once', 'evaluate once and return, even while checks are running')
    .option('--watch', 'poll until there is something to do (the default)')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (ref: string, options: { once?: boolean; json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const host = new GitHubCodeHost({ run: deps.run, cwd: deps.cwd });
        const result = await babysit(host, ref, new StateStore(root), {
          settings: { maxAttempts: config.babysit.maxAttempts },
          pollIntervalSec: config.babysit.pollIntervalSec,
          timeoutMin: config.babysit.timeoutMin,
          once: options.once === true,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => deps.now().getTime(),
          onProgress: (message) => {
            deps.stderr(`sentinel: ${message}`);
          },
        });
        const output = {
          action: result.action,
          reason: result.reason,
          pr: result.pr.url,
          attempts: result.attempts,
          packet: result.packet,
        };
        deps.stdout(
          options.json === true
            ? JSON.stringify(output, null, 2)
            : [
                `${result.action}: ${result.reason}`,
                ...(result.packet?.errors
                  .slice(0, 10)
                  .map(
                    (e) =>
                      `  ${e.file ?? ''}${e.line === undefined ? '' : `:${String(e.line)}`} ${e.message}`,
                  ) ?? []),
              ].join('\n'),
        );
        deps.setExitCode(EXIT[result.action]);
      }),
    );
}
