import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/exec.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = fileURLToPath(new URL('../../dist/bin/sentinel.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

const sentinel = (...args: string[]) => runCommand(process.execPath, [bin, ...args], { cwd: root });

describe('built CLI (dist)', () => {
  beforeAll(() => {
    if (!existsSync(bin)) throw new Error(`Missing ${bin}; run \`npm run build\` first.`);
  });

  it('starts with a node shebang so it can be installed as a bin', () => {
    expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('--version prints the package version', async () => {
    const result = await sentinel('--version');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('doctor --json reports on the real environment', async () => {
    const result = await sentinel('doctor', '--json');
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: { id: string; status: string }[];
    };
    expect(report.checks.find((c) => c.id === 'node')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'git')?.status).toBe('pass');
    expect(result.exitCode).toBe(report.ok ? 0 : 1);
  });

  it('exits non-zero on an unknown command', async () => {
    const result = await sentinel('definitely-not-a-command');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('unknown command');
  });
});
