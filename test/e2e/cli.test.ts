import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('built CLI: analyze', () => {
  it('detects this repository as a TypeScript/node project using vitest', async () => {
    const result = await sentinel('analyze', '--json');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      projects: { path: string; language: string; tests: { unit: { detected: string } } }[];
    };
    const root = report.projects.find((p) => p.path === '.');
    expect(root?.language).toBe('typescript');
    expect(root?.tests.unit.detected).toBe('vitest');
  });
});

describe('built CLI: learn', () => {
  it('adds a lesson in a fresh repository and recalls it by path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-e2e-learn-'));
    try {
      const init = await runCommand('git', ['init', '-q'], { cwd: dir, timeoutMs: 45_000 });
      expect(init.exitCode).toBe(0);
      const draft = join(dir, 'draft.md');
      await writeFile(
        draft,
        '---\nsummary: "Use path.join for fixture paths"\nscope: ["test/**/*.ts"]\n---\n\nThe Windows leg fails on "/".\n',
        'utf8',
      );
      const run = (...args: string[]) =>
        runCommand(process.execPath, [bin, ...args], { cwd: dir, timeoutMs: 45_000 });
      const added = await run('learn', 'add', '--file', draft, '--json');
      expect(added.exitCode, added.stderr).toBe(0);
      expect(JSON.parse(added.stdout) as unknown).toMatchObject({ action: 'added' });
      const recalled = await run('learn', 'recall', '--paths', 'test\\unit\\a.test.ts', '--json');
      expect(recalled.exitCode, recalled.stderr).toBe(0);
      expect(JSON.parse(recalled.stdout) as unknown).toMatchObject({
        lessons: [{ summary: 'Use path.join for fixture paths' }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
  it('records an architecture decision and shows it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sentinel-e2e-architecture-'));
    try {
      const init = await runCommand('git', ['init', '-q'], { cwd: dir, timeoutMs: 45_000 });
      expect(init.exitCode).toBe(0);
      const run = (...args: string[]) =>
        runCommand(process.execPath, [bin, ...args], { cwd: dir, timeoutMs: 45_000 });
      const missing = await run('architecture', 'show', '--json');
      expect(missing.exitCode).toBe(2);
      await writeFile(
        join(dir, 'decision.json'),
        JSON.stringify({
          layers: [
            { name: 'api', path: 'api', ecosystem: 'dotnet', language: 'C#', frameworks: [] },
            { name: 'web', path: 'web', ecosystem: 'node', language: 'TypeScript', frameworks: [] },
          ],
          architecture: {
            style: 'Modular monolith',
            ddd: 'strategic',
            principles: ['SOLID'],
            rationale: 'Clear module seams without the cost of services.',
          },
          alternatives: [{ style: 'Microservices', reason: 'One team, one deploy.' }],
          folders: [{ path: 'api/Modules', purpose: 'One folder per bounded context' }],
        }),
        'utf8',
      );
      const recorded = await run(
        'setup',
        '--architecture',
        'decision.json',
        '--workflows',
        '--json',
      );
      expect(recorded.stderr).toBe('');
      expect(JSON.parse(recorded.stdout) as unknown).toMatchObject({
        architecture: { recorded: true, adr: 'docs/adr/0001-stack-and-architecture.md' },
      });
      expect(readFileSync(join(dir, '.github/workflows/sentinel-tests.yml'), 'utf8')).toContain(
        'actions/setup-dotnet',
      );
      const shown = await run('architecture', 'show');
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain('architecture: Modular monolith');
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
