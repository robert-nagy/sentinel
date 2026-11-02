import { describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/exec.js';

const node = process.execPath;

describe('runCommand', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await runCommand(node, [
      '-e',
      'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)',
    ]);
    expect(result).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err', notFound: false });
  });

  it('passes arguments verbatim without shell interpretation', async () => {
    const tricky = 'a b; echo $HOME && "quoted" | pipe';
    const result = await runCommand(node, ['-e', 'process.stdout.write(process.argv[1])', tricky]);
    expect(result.stdout).toBe(tricky);
  });

  it('reports a missing executable as notFound instead of throwing', async () => {
    const result = await runCommand('sentinel-definitely-not-a-real-binary', ['--version']);
    expect(result.notFound).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('honours the working directory', async () => {
    const cwd = process.platform === 'win32' ? 'C:\\' : '/';
    const result = await runCommand(node, ['-e', 'process.stdout.write(process.cwd())'], { cwd });
    expect(result.stdout).toBe(cwd);
  });
});
