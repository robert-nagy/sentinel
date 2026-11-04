import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config-schema.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import { fillTemplate, resolveInside, ScaffoldError } from '../../src/core/scaffold.js';
import { analyzePrd, DIMENSIONS, validatePrd } from '../../src/core/prd-validator.js';
import { RUBRIC, formatRubric } from '../../src/templates/prd-rubric.js';
import { PRD_TEMPLATE } from '../../src/templates/prd-template.js';

describe('fillTemplate / resolveInside', () => {
  it('replaces known placeholders only', () => {
    expect(fillTemplate('{{A}} {{B}} {{a}}', { A: 'x' })).toBe('x {{B}} {{a}}');
  });
  it('rejects directories that escape the repository', () => {
    expect(() => resolveInside(join('/r'), '../outside', 'f.md')).toThrow(ScaffoldError);
    expect(resolveInside(join('/r'), 'docs/prd', 'f.md')).toBe(join('/r', 'docs', 'prd', 'f.md'));
  });
});

describe('PRD template', () => {
  const filled = fillTemplate(PRD_TEMPLATE, { TITLE: 'T', SLUG: 't', ISSUE: 'none', DATE: '2026-01-01' });

  it('has every required section, so only the TODO markers stand between it and a pass', () => {
    const codes = new Set(analyzePrd(filled).issues.map((i) => i.code));
    expect(codes).toEqual(new Set(['ambiguous-term']));
  });
  it('cannot pass while TODO markers remain', () => {
    const scores = { clarity: 100, testability: 100, completeness: 100, security: 100, feasibility: 100 };
    const report = validatePrd(filled, { scores, config: DEFAULT_CONFIG });
    expect(report.pass).toBe(false);
    expect(report.nextAction).toBe('refine');
  });
  it('turns into a passing PRD once the TODO markers are replaced', () => {
    const done = filled.replace(/TODO:?\s*/g, '');
    expect(analyzePrd(done).issues).toEqual([]);
  });
});

describe('rubric', () => {
  it('covers every dimension', () => {
    expect(Object.keys(RUBRIC).sort()).toEqual([...DIMENSIONS].sort());
    const text = formatRubric();
    for (const d of DIMENSIONS) expect(text).toContain(`${d}:`);
    expect(text).toContain('--scores');
  });
});

describe('prd new / rfc new', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'sentinel-scaffold-'));
    await mkdir(join(repo, '.git'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const cli = () => {
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
    return { out, err, run: (...a: string[]) => main(['node', 'sentinel', ...a], deps) };
  };

  it('creates a PRD in the configured folder, then refuses to overwrite it', async () => {
    const a = cli();
    expect(await a.run('prd', 'new', 'Order Tracking!', '--issue', '#12')).toBe(0);
    const path = join(repo, 'docs', 'prd', 'order-tracking.md');
    expect(a.out).toEqual([path]);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# PRD: Order Tracking!');
    expect(text).toContain('Issue: #12');
    expect(text).toContain('Created: 2026-03-05');

    const b = cli();
    expect(await b.run('prd', 'new', 'order-tracking')).toBe(1);
    expect(b.err.join('\n')).toContain('already exists');
    const c = cli();
    expect(await c.run('prd', 'new', 'order-tracking', '--force')).toBe(0);
  });

  it('validates a freshly scaffolded PRD as needing work (exit 2)', async () => {
    const a = cli();
    await a.run('prd', 'new', 'x');
    const b = cli();
    expect(await b.run('prd', 'validate', 'docs/prd/x.md')).toBe(2);
  });

  it('honours a custom directory and refuses one outside the repository', async () => {
    await writeFile(join(repo, 'sentinel.config.json'), JSON.stringify({ prd: { dir: 'specs' } }));
    const a = cli();
    expect(await a.run('prd', 'new', 'a')).toBe(0);
    expect(a.out[0]).toBe(join(repo, 'specs', 'a.md'));
    await writeFile(join(repo, 'sentinel.config.json'), JSON.stringify({ prd: { dir: '../escape' } }));
    const b = cli();
    expect(await b.run('prd', 'new', 'b')).toBe(1);
    expect(b.err.join('\n')).toContain('outside the repository');
  });

  it('creates an RFC named after the issue', async () => {
    const a = cli();
    expect(await a.run('rfc', 'new', '#42', '--title', 'Add login')).toBe(0);
    const path = join(repo, 'docs', 'rfcs', 'issue-42.md');
    expect(a.out).toEqual([path]);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('# RFC: Add login');
    expect(text).toContain('Issue: #42');
    expect(text).toContain('Implementation does not start until this is checked');
  });

  it('rejects an invalid issue id for rfc new', async () => {
    const a = cli();
    expect(await a.run('rfc', 'new', '../etc')).toBe(1);
  });

  it('prints the rubric', async () => {
    const a = cli();
    expect(await a.run('prd', 'rubric')).toBe(0);
    expect(a.out.join('\n')).toContain('testability:');
  });
});
