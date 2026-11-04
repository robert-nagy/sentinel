import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/core/exec.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = fileURLToPath(new URL('../../dist/bin/sentinel.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Generous limit: spawning git/gh is slow on Windows CI runners. Must stay below
// the vitest e2e testTimeout so a hang fails with a clear message.
const sentinel = (...args: string[]) =>
  runCommand(process.execPath, [bin, ...args], { cwd: root, timeoutMs: 45_000 });

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
    expect(result.timedOut, `doctor timed out; stderr: ${result.stderr}`).toBe(false);
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

describe('built CLI: config and branch', () => {
  it('config schema is valid JSON describing the config', async () => {
    const result = await sentinel('config', 'schema');
    expect(result.exitCode).toBe(0);
    const schema = JSON.parse(result.stdout) as { properties: Record<string, unknown> };
    expect(schema.properties).toHaveProperty('branches');
  });

  it('branch name works against the repo defaults', async () => {
    const result = await sentinel('branch', 'name', '--issue', '12', '--title', 'Hello World');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('feat/12-hello-world');
  });
});
