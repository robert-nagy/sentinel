import { spawn } from 'node:child_process';

export interface CommandResult {
  /** Process exit code; `null` if the process was killed or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the executable could not be found on PATH. */
  readonly notFound: boolean;
}

export interface CommandOptions {
  readonly cwd?: string;
  /** Kill the process after this many milliseconds (default 15s). */
  readonly timeoutMs?: number;
}

/**
 * Runs an executable with arguments and resolves with its output. Never rejects:
 * failures are reported through `exitCode` / `notFound` so callers can turn them
 * into diagnostics. Injectable so core logic can be unit-tested without spawning.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Default {@link CommandRunner}. Uses `shell: false` so arguments are never
 * interpreted by a shell (no injection, identical behaviour on Windows, where
 * libuv resolves `.exe` binaries such as `git.exe` and `gh.exe` from PATH).
 */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: process.env,
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        stdout,
        stderr: stderr || error.message,
        notFound: error.code === 'ENOENT',
      });
    });

    child.on('close', (code) => {
      finish({ exitCode: code, stdout, stderr, notFound: false });
    });
  });
