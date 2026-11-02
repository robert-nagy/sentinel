import { runCommand, type CommandRunner } from '../core/exec.js';

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface CliDeps {
  readonly run: CommandRunner;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
}

export function defaultDeps(): CliDeps {
  return {
    run: runCommand,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: process.cwd(),
  };
}
