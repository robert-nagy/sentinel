import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-architecture-'));
  await mkdir(join(repo, '.git'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cli() {
  const out: string[] = [];
  const codes: number[] = [];
  const deps = {
    run: runCommand,
    files: nodeFiles,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => out.push(t),
    setExitCode: (c: number) => codes.push(c),
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: repo,
    homeDir: repo,
    env: { XDG_CONFIG_HOME: join(repo, 'xdg'), APPDATA: join(repo, 'appdata') },
    now: () => new Date('2026-03-05T12:00:00Z'),
    interactive: false,
  };
  return { out, codes, run: (...args: string[]) => main(['node', 'sentinel', ...args], deps) };
}

const recorded = {
  version: 1,
  decidedAt: '2026-03-05T12:00:00.000Z',
  adr: 'docs/adr/0001-stack-and-architecture.md',
  layers: [{ name: 'app', ecosystem: 'go', language: 'Go', frameworks: ['chi'] }],
  architecture: {
    style: 'Layered',
    ddd: 'none',
    principles: [],
    rationale: 'A small CRUD service.',
  },
  alternatives: [{ style: 'Hexagonal', reason: 'Not worth the ports for three tables.' }],
  folders: [{ path: 'internal', purpose: 'Application code' }],
};

async function record(value: unknown): Promise<void> {
  await mkdir(join(repo, '.sentinel'), { recursive: true });
  await writeFile(join(repo, '.sentinel', 'architecture.json'), JSON.stringify(value), 'utf8');
}

describe('sentinel architecture show', () => {
  it('prints the recorded decision and exits 0', async () => {
    await record(recorded);
    const { run, out, codes } = cli();
    await run('architecture', 'show', '--json');
    expect(codes).toEqual([]);
    const result = JSON.parse(out.join('')) as { recorded: boolean; decision: typeof recorded };
    expect(result.recorded).toBe(true);
    expect(result.decision.architecture.style).toBe('Layered');

    const plain = cli();
    await plain.run('architecture', 'show');
    expect(plain.out.join('\n')).toContain('architecture: Layered');
    expect(plain.out.join('\n')).toContain('app: Go (chi) [go]');
  });

  it('exits 2 when no decision is recorded', async () => {
    const { run, out, codes } = cli();
    await run('architecture', 'show', '--json');
    expect(codes).toEqual([2]);
    expect(JSON.parse(out.join(''))).toEqual({
      path: '.sentinel/architecture.json',
      recorded: false,
    });
    const plain = cli();
    await plain.run('architecture', 'show');
    expect(plain.out.join('\n')).toContain('sentinel setup');
  });

  it('exits 5 when the decision file is invalid', async () => {
    await record({ ...recorded, architecture: { style: 'Layered' } });
    const { run, out, codes } = cli();
    await run('architecture', 'show');
    expect(codes).toEqual([5]);
    expect(out.join('\n')).toContain('.sentinel/architecture.json is invalid');
  });
});
