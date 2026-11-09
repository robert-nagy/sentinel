import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CommandRunner } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import {
  MiningError,
  markCreated,
  mergeFindings,
  parseGapFile,
  parseRepoSearch,
  renderGapFile,
  type Finding,
} from '../../src/core/mining.js';

const findings: Finding[] = [
  {
    title: 'Offline mode',
    summary: 'Works without a network.',
    sources: ['a/one'],
    priority: 'high',
  },
  { title: 'Dark theme', summary: 'A dark colour scheme.', sources: ['b/two', 'a/one'] },
];

describe('parseRepoSearch', () => {
  const text = JSON.stringify([
    {
      fullName: 'a/big',
      url: 'u1',
      stargazersCount: 9000,
      description: 'd',
      language: 'Go',
      license: { key: 'mit' },
    },
    {
      fullName: 'a/small',
      url: 'u2',
      stargazersCount: 10,
      description: null,
      language: null,
      license: null,
    },
  ]);

  it('keeps repositories above the star floor and fills missing fields', () => {
    expect(parseRepoSearch(text, 500)).toEqual([
      {
        fullName: 'a/big',
        url: 'u1',
        stars: 9000,
        description: 'd',
        language: 'Go',
        license: 'mit',
      },
    ]);
    expect(parseRepoSearch(text, 0)[1]).toMatchObject({
      description: '',
      language: '',
      license: '',
    });
  });

  it('rejects output that is not a repository list', () => {
    expect(() => parseRepoSearch('nope', 0)).toThrow(MiningError);
    expect(() => parseRepoSearch('{"a":1}', 0)).toThrow(MiningError);
  });
});

describe('mergeFindings', () => {
  it('merges near-duplicate titles and their sources', () => {
    const merged = mergeFindings([
      { title: 'Offline mode support', summary: 's', sources: ['a/one'] },
      { title: 'Offline mode support', summary: 'other', sources: ['b/two', 'a/one'] },
      { title: 'Dark theme', summary: 's', sources: [] },
    ]);
    expect(merged.map((f) => f.title)).toEqual(['Offline mode support', 'Dark theme']);
    expect(merged[0]?.sources).toEqual(['a/one', 'b/two']);
  });
});

describe('gap file', () => {
  it('round-trips findings as unticked gaps', () => {
    const gaps = parseGapFile(renderGapFile(findings));
    expect(gaps.map((g) => g.title)).toEqual(['Offline mode', 'Dark theme']);
    expect(gaps[0]).toMatchObject({
      priority: 'high',
      approved: false,
      sources: ['a/one'],
      summary: 'Works without a network.',
    });
    expect(gaps[1]?.sources).toEqual(['b/two', 'a/one']);
  });

  it('reads ticked boxes and Created lines, and ignores other text', () => {
    const md = [
      '# Notes',
      '- [x] **Offline mode**',
      '  - s',
      '  - Created: #4',
      '- [X] **Dark theme**',
      '- [ ] plain item',
      '- [x] **Unclosed',
    ].join('\n');
    const gaps = parseGapFile(md);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ approved: true, created: '#4' });
    expect(gaps[1]).toMatchObject({ approved: true, created: undefined });
  });

  it('marks a gap as created after its detail lines', () => {
    const md = renderGapFile(findings);
    const gap = parseGapFile(md)[0];
    const next = markCreated(md, gap?.lineIndex ?? 0, '#9');
    expect(parseGapFile(next)[0]?.created).toBe('#9');
    expect(parseGapFile(next)).toHaveLength(2);
  });
});

describe('sentinel mine', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'sentinel-mine-'));
    await mkdir(join(repo, '.git'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const ok = (stdout: string) => ({
    exitCode: 0,
    stdout,
    stderr: '',
    notFound: false,
    timedOut: false,
  });
  function cli(run: CommandRunner = () => Promise.resolve(ok(''))) {
    const out: string[] = [];
    const err: string[] = [];
    const deps = {
      run,
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
    return { out, err, run: (...args: string[]) => main(['node', 'sentinel', ...args], deps) };
  }
  const useTracker = (tracker: string) =>
    writeFile(
      join(repo, 'sentinel.config.json'),
      JSON.stringify({ issueProvider: { tracker } }),
      'utf8',
    );

  it('search asks gh for repositories sorted by stars and filters them', async () => {
    const calls: string[][] = [];
    const run: CommandRunner = (_c, args) => {
      calls.push([...args]);
      return Promise.resolve(
        ok(
          JSON.stringify([
            { fullName: 'a/big', url: 'u', stargazersCount: 900, description: 'd' },
            { fullName: 'a/tiny', url: 'u', stargazersCount: 3 },
          ]),
        ),
      );
    };
    const { run: sentinel, out } = cli(run);
    await sentinel('mine', 'search', 'task', 'tracker', '--json');
    expect(calls[0]).toEqual(
      expect.arrayContaining(['search', 'repos', 'task', 'tracker', '--sort', 'stars']),
    );
    expect((JSON.parse(out.join('')) as unknown[]).length).toBe(1);
  });

  it('draft writes the gap list and refuses to overwrite it', async () => {
    await writeFile(join(repo, 'findings.json'), JSON.stringify(findings), 'utf8');
    const first = cli();
    await first.run('mine', 'draft', '--findings', 'findings.json', '--json');
    expect(JSON.parse(first.out.join('')) as unknown).toMatchObject({ gaps: 2 });
    expect(await readFile(join(repo, 'docs', 'feature-gaps.md'), 'utf8')).toContain(
      '- [ ] **Offline mode**',
    );

    const codes: number[] = [];
    const second = cli();
    const failing = { ...second };
    await failing.run('mine', 'draft', '--findings', 'findings.json');
    expect(codes).toEqual([]);
    expect(second.err.join('\n')).toContain('already exists');
  });

  it('draft rejects a malformed findings file', async () => {
    await writeFile(join(repo, 'findings.json'), '[{"title":"x"}]', 'utf8');
    const { run, err } = cli();
    await run('mine', 'draft', '--findings', 'findings.json');
    expect(err.join('\n')).toContain('not a list of findings');
  });

  it('create files approved gaps in the local tracker, skips duplicates and is idempotent', async () => {
    await useTracker('local');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(
      join(repo, 'docs', 'feature-gaps.md'),
      renderGapFile(findings)
        .replace('- [ ] **Offline mode**', '- [x] **Offline mode**')
        .replace('- [ ] **Dark theme**', '- [x] **Dark theme**'),
      'utf8',
    );
    // An open local issue already covers dark theme.
    const seed = cli();
    await seed.run('issue', 'create', '--title', 'Dark theme');

    const first = cli();
    await first.run('mine', 'create', '--approved', 'docs/feature-gaps.md', '--json');
    const result = JSON.parse(first.out.join('')) as {
      created: { title: string }[];
      skippedDuplicates: { title: string }[];
    };
    expect(result.created.map((c) => c.title)).toEqual(['Offline mode']);
    expect(result.skippedDuplicates.map((c) => c.title)).toEqual(['Dark theme']);
    expect(await readFile(join(repo, 'docs', 'feature-gaps.md'), 'utf8')).toContain('Created: #2');

    const again = cli();
    await again.run('mine', 'create', '--approved', 'docs/feature-gaps.md', '--json');
    expect((JSON.parse(again.out.join('')) as { created: unknown[] }).created).toEqual([]);
  });

  it('create lists issues for the agent to file when the tracker is not local', async () => {
    await useTracker('jira');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(
      join(repo, 'docs', 'feature-gaps.md'),
      renderGapFile(findings).replace('- [ ] **Offline mode**', '- [x] **Offline mode**'),
      'utf8',
    );
    await writeFile(
      join(repo, 'existing.json'),
      JSON.stringify([{ id: 'PROJ-1', title: 'Something else' }]),
      'utf8',
    );
    const { run, out } = cli();
    await run(
      'mine',
      'create',
      '--approved',
      'docs/feature-gaps.md',
      '--candidates',
      'existing.json',
      '--json',
    );
    const result = JSON.parse(out.join('')) as {
      toCreate: { title: string; labels: string[] }[];
      created: unknown[];
    };
    expect(result.toCreate).toEqual([
      expect.objectContaining({ title: 'Offline mode', labels: ['kind/feature'] }),
    ]);
    expect(result.created).toEqual([]);
  });

  it('create warns when duplicates cannot be checked', async () => {
    await useTracker('jira');
    await mkdir(join(repo, 'docs'), { recursive: true });
    await writeFile(join(repo, 'docs', 'feature-gaps.md'), renderGapFile(findings), 'utf8');
    const { run, err, out } = cli();
    await run('mine', 'create', '--approved', 'docs/feature-gaps.md');
    expect(err.join('\n')).toContain('duplicates cannot be checked');
    expect(out.join('\n')).toContain('nothing approved');
  });
});
