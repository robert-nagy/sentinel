import { spawn } from 'node:child_process';

export interface CommandResult {
  /** Process exit code; `null` if the process was killed or never started. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the executable could not be found on PATH. */
  readonly notFound: boolean;
  /** True when the process was killed because it exceeded `timeoutMs`. */
  readonly timedOut: boolean;
}

export interface CommandOptions {
  readonly cwd?: string;
  /** Kill the process after this many milliseconds (default 15s). */
  readonly timeoutMs?: number;
}

/**
 * Runs an executable with arguments and resolves with its output. Never rejects:
 * failures are reported through `exitCode` / `notFound` / `timedOut` so callers can
 * turn them into diagnostics. Injectable so core logic can be unit-tested without
 * spawning.
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
    let timedOut = false;
    let settled = false;
    const finish = (result: Omit<CommandResult, 'timedOut'>): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...result, timedOut });
      }
    };

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
    });

    // Our own timer (rather than spawn's `timeout` option) so a timeout is
    // reported explicitly and behaves identically on every platform.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
