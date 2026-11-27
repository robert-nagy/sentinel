import type { Command } from 'commander';
import { ARCHITECTURE_FILE, formatDecision, readDecision } from '../core/architecture.js';
import { ExitCode } from '../core/exit-codes.js';
import { findRepoRoot } from '../core/repo.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

export function registerArchitecture(program: Command, deps: CliDeps): void {
  const architecture = program
    .command('architecture')
    .description('The stack and architecture decision recorded during setup');

  architecture
    .command('show')
    .description(
      `Print the recorded decision (${ARCHITECTURE_FILE}); exits 2 when none is recorded`,
    )
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { json?: boolean }) => {
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const decision = await readDecision(root, deps.files);
        if (decision === undefined) {
          deps.stdout(
            options.json === true
              ? JSON.stringify({ path: ARCHITECTURE_FILE, recorded: false }, null, 2)
              : `No stack and architecture decision is recorded (${ARCHITECTURE_FILE}). Decide it with the user and record it with \`sentinel setup --architecture <file>\`.`,
          );
          deps.setExitCode(ExitCode.Refine);
          return;
        }
        deps.stdout(
          options.json === true
            ? JSON.stringify({ path: ARCHITECTURE_FILE, recorded: true, decision }, null, 2)
            : formatDecision(decision),
        );
      }),
    );
}
