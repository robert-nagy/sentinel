import { Command, CommanderError } from 'commander';
import { VERSION } from '../version.js';
import { defaultDeps, type CliDeps } from './deps.js';
import { registerDoctor } from './doctor.js';

export type { CliDeps } from './deps.js';

/** Builds the `sentinel` command tree. Subcommands are added milestone by milestone. */
export function createProgram(deps: CliDeps = defaultDeps()): Command {
  const program = new Command()
    .name('sentinel')
    .description(
      'Agentic PDLC/SDLC governance: skills, guardrails and deterministic tooling for AI coding agents',
    )
    .version(VERSION, '-v, --version', 'print the sentinel version')
    .showHelpAfterError()
    // Throw instead of calling process.exit. Must be set before subcommands are
    // added so they inherit it.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        deps.stdout(text.replace(/\n$/, ''));
      },
      writeErr: (text) => {
        deps.stderr(text.replace(/\n$/, ''));
      },
    });

  registerDoctor(program, deps);

  return program;
}

/** CLI entry point. Resolves with the exit code instead of calling `process.exit`. */
export async function main(
  argv: readonly string[],
  deps: CliDeps = defaultDeps(),
): Promise<number> {
  let exitCode = 0;
  const trackedDeps: CliDeps = {
    ...deps,
    setExitCode: (code) => {
      exitCode = code;
      deps.setExitCode(code);
    },
  };
  const program = createProgram(trackedDeps);
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help / --version exit with code 0 through CommanderError as well.
      exitCode = error.exitCode;
      deps.setExitCode(exitCode);
    } else {
      throw error;
    }
  }
  return exitCode;
}
