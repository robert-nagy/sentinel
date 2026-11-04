import { homedir } from 'node:os';
import { runCommand, type CommandRunner } from '../core/exec.js';
import { nodeFiles, type FileAccess } from '../core/fs.js';

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface CliDeps {
  readonly run: CommandRunner;
  readonly files: FileAccess;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly setExitCode: (code: number) => void;
  readonly nodeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}

export function defaultDeps(): CliDeps {
  return {
    run: runCommand,
    files: nodeFiles,
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    setExitCode: (code) => {
      process.exitCode = code;
    },
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    now: () => new Date(),
  };
}
