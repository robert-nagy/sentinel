import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../../src/cli/index.js';
import type { CommandResult } from '../../src/core/exec.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { VERSION } from '../../src/version.js';

const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '', notFound: false });

function harness(nodeVersion = '22.11.0') {
  const out: string[] = [];
  const err: string[] = [];
  let exitCode: number | undefined;
  const deps: CliDeps = {
    run: (command, args) => {
      const key = [command, ...args].join(' ');
      const responses: Record<string, CommandResult> = {
        'git --version': ok('git version 2.47.1'),
        'git rev-parse --is-inside-work-tree': ok('true'),
        'gh --version': ok('gh version 2.89.0'),
        'gh auth status': ok(),
      };
      return Promise.resolve(
        responses[key] ?? { exitCode: null, stdout: '', stderr: '', notFound: true },
      );
    },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
    nodeVersion,
    platform: 'linux',
    cwd: '/repo',
  };
  return { deps, out, err, exitCode: () => exitCode };
}

const argv = (...args: string[]) => ['node', 'sentinel', ...args];

describe('sentinel CLI', () => {
  it('prints the version', async () => {
    const h = harness();
    const code = await main(argv('--version'), h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toBe(VERSION);
  });

  it('prints help listing the doctor command', async () => {
    const h = harness();
    const code = await main(argv('--help'), h.deps);
    expect(code).toBe(0);
    expect(h.out.join('\n')).toContain('doctor');
  });

  it('rejects unknown commands with a non-zero exit code', async () => {
    const h = harness();
    const code = await main(argv('frobnicate'), h.deps);
    expect(code).not.toBe(0);
    expect(h.err.join('\n')).toContain('unknown command');
  });

  it('rejects unknown options on subcommands without exiting the process', async () => {
    const h = harness();
    const code = await main(argv('doctor', '--nope'), h.deps);
    expect(code).not.toBe(0);
    expect(h.err.join('\n')).toContain('unknown option');
  });

  it('doctor --json emits a parseable report and exits 0 when healthy', async () => {
    const h = harness();
    const code = await main(argv('doctor', '--json'), h.deps);
    expect(code).toBe(ExitCode.Ok);
    const report = JSON.parse(h.out.join('\n')) as { ok: boolean; checks: { id: string }[] };
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toContain('node');
  });

  it('doctor exits with Failure when a check fails', async () => {
    const h = harness('20.0.0');
    const code = await main(argv('doctor'), h.deps);
    expect(code).toBe(ExitCode.Failure);
    expect(h.exitCode()).toBe(ExitCode.Failure);
    expect(h.out.join('\n')).toContain('FAILED');
  });
});
