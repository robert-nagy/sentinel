import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import { evaluationsBefore, recordEvaluation, type PrdState } from '../../src/core/prd-state.js';
import { validatePrd, type Scores } from '../../src/core/prd-validator.js';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/prd/${name}.md`, import.meta.url));
const uniform = (n: number): Scores => ({
  clarity: n,
  testability: n,
  completeness: n,
  security: n,
  feasibility: n,
});

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-prd-'));
  await mkdir(join(repo, '.git'));
  await mkdir(join(repo, 'docs'));
  await copyFile(fixture('good'), join(repo, 'docs', 'good.md'));
  await copyFile(fixture('borderline'), join(repo, 'docs', 'borderline.md'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cli() {
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    run: runCommand,
    files: nodeFiles,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => err.push(t),
    setExitCode: () => undefined,
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: repo,
    homeDir: repo,
    env: { XDG_CONFIG_HOME: join(repo, 'xdg'), APPDATA: join(repo, 'appdata') },
    now: () => new Date('2026-03-05T12:00:00Z'),
  };
  const run = (...args: string[]) => main(['node', 'sentinel', ...args], deps);
  return { run, out, err };
}

const writeScores = async (name: string, scores: Scores) => {
  await writeFile(join(repo, name), JSON.stringify(scores), 'utf8');
};

describe('sentinel prd validate', () => {
  it('asks for self-scores when the structure is sound (exit 2)', async () => {
    const { run, out } = cli();
    expect(await run('prd', 'validate', 'docs/good.md')).toBe(2);
    expect(out.join('\n')).toContain('SCORE');
  });

  it('accepts a good PRD with high scores (exit 0) and reports JSON', async () => {
    await writeScores('s.json', uniform(92));
    const { run, out } = cli();
    expect(await run('prd', 'validate', 'docs/good.md', '--scores', 's.json', '--json')).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ slug: 'good', nextAction: 'accept', mean: 92 });
  });

  it('refines three times and then escalates (exit 2, 2, 2, 3)', async () => {
    const { run, out } = cli();
    const codes: number[] = [];
    for (const score of [60, 61, 62, 63]) {
      await writeScores('s.json', uniform(score));
      codes.push(await run('prd', 'validate', 'docs/borderline.md', '--scores', 's.json'));
    }
    expect(codes).toEqual([2, 2, 2, 3]);
    expect(out.join('\n')).toContain('Escalate to a higher-reasoning model');
  });

  it('does not use up a refinement when the same input is validated again', async () => {
    await writeScores('s.json', uniform(60));
    const { run } = cli();
    const codes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push(await run('prd', 'validate', 'docs/borderline.md', '--scores', 's.json'));
    }
    expect(codes).toEqual([2, 2, 2, 2, 2]);
  });

  it('shows progress with prd status', async () => {
    await writeScores('s.json', uniform(60));
    const { run, out } = cli();
    await run('prd', 'validate', 'docs/borderline.md', '--scores', 's.json');
    out.length = 0;
    expect(await run('prd', 'status', 'borderline')).toBe(0);
    expect(out.join('\n')).toContain('1 evaluation(s)');
    expect(out.join('\n')).toContain('refinements remaining: 3');
  });

  it('fails clearly for missing files, bad scores and unknown status', async () => {
    const a = cli();
    expect(await a.run('prd', 'validate', 'nope.md')).toBe(1);
    expect(a.err.join('\n')).toContain('PRD file not found');
    await writeFile(join(repo, 'bad.json'), '{"clarity": 200}', 'utf8');
    const b = cli();
    expect(await b.run('prd', 'validate', 'docs/good.md', '--scores', 'bad.json')).toBe(1);
    expect(b.err.join('\n')).toContain('must be');
    const c = cli();
    expect(await c.run('prd', 'status', 'ghost')).toBe(1);
  });
});

describe('prd state rules', () => {
  const report = (n: number, before: number) =>
    validatePrd('# x', { scores: uniform(n), config: DEFAULT_CONFIG, evaluationsBefore: before });
  const now = new Date('2026-03-05T12:00:00Z');

  it('starts a fresh cycle when an accepted PRD changes', () => {
    const accepted: PrdState = recordEvaluation(undefined, 's', 'h1', { ...report(99, 0), nextAction: 'accept' }, now);
    expect(evaluationsBefore(accepted, 'h2')).toBe(0);
    const next = recordEvaluation(accepted, 's', 'h2', report(10, 0), now);
    expect(next.evaluations).toBe(1);
    expect(next.history).toHaveLength(1);
  });
  it('keeps the state unchanged for a repeated hash', () => {
    const first = recordEvaluation(undefined, 's', 'h', report(10, 0), now);
    expect(recordEvaluation(first, 's', 'h', report(10, 0), now)).toBe(first);
    expect(evaluationsBefore(first, 'h')).toBe(0);
  });
});
