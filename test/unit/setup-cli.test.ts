import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand, type CommandRunner } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';

interface SetupResult {
  dryRun: boolean;
  domain: { written: boolean; complete: boolean };
  next: { id: string; branch: string }[];
  stack: { empty: boolean; proposal: boolean };
  files: string[];
}

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-setup-'));
  await mkdir(join(repo, '.git'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cli(extra: { interactive?: boolean; replies?: string[]; run?: CommandRunner } = {}) {
  const out: string[] = [];
  const codes: number[] = [];
  const replies = [...(extra.replies ?? [])];
  const deps = {
    run: extra.run ?? runCommand,
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
    interactive: extra.interactive ?? false,
    ask: () => Promise.resolve(replies.shift() ?? ''),
  };
  return {
    out,
    codes,
    json: () => JSON.parse(out.join('')) as SetupResult,
    run: (...args: string[]) => main(['node', 'sentinel', ...args], deps),
  };
}

const core = { problem: 'P', users: 'U', data: 'D', scale: 'S' };
const writeJson = (name: string, value: unknown) =>
  writeFile(join(repo, name), JSON.stringify(value), 'utf8');
const domain = async () =>
  JSON.parse(await readFile(join(repo, '.sentinel', 'domain.json'), 'utf8')) as {
    answers: Record<string, string>;
  };

describe('sentinel setup', () => {
  it('lists the open questions and an empty-stack proposal without writing', async () => {
    const { run, json, codes } = cli();
    await run('setup', '--questions', '--json');
    const result = json();
    expect(result.next.map((q) => q.id)).toEqual(['problem', 'users', 'data', 'scale']);
    expect(result.stack).toMatchObject({ empty: true, proposal: true });
    expect(codes).toEqual([]);
    await expect(domain()).rejects.toThrow();
  });

  it('saves answers to the domain file and exits 2 while questions remain', async () => {
    await writeJson('a.json', core);
    const { run, json, codes } = cli();
    await run('setup', '--answers', 'a.json', '--json');
    expect(json().domain).toMatchObject({ written: true, complete: false });
    expect(codes.at(-1)).toBe(2);
    expect((await domain()).answers).toEqual(core);
  });

  it('merges answers across rounds', async () => {
    await writeJson('a.json', core);
    await cli().run('setup', '--answers', 'a.json');
    await writeJson('b.json', { availability: '99.9%' });
    await cli().run('setup', '--answers', 'b.json');
    expect((await domain()).answers).toMatchObject({ ...core, availability: '99.9%' });
  });

  it('rejects bad answers files with exit 1', async () => {
    await writeJson('bad.json', { colour: 'blue' });
    const { run, codes, out } = cli();
    await run('setup', '--answers', 'bad.json');
    expect(codes).toContain(1);
    expect(out.join('\n')).toContain('unknown question');
    const missing = cli();
    await missing.run('setup', '--answers', 'nope.json');
    expect(missing.codes).toContain(1);
  });

  it('--dry-run does not write', async () => {
    await writeJson('a.json', core);
    const { run, json } = cli();
    await run('setup', '--answers', 'a.json', '--dry-run', '--json');
    expect(json().dryRun).toBe(true);
    await expect(domain()).rejects.toThrow();
  });

  it('asks questions in the terminal when interactive, skipping blanks', async () => {
    const { run } = cli({ interactive: true, replies: ['P', 'U', '', 'S'] });
    await run('setup');
    expect((await domain()).answers).toEqual({ problem: 'P', users: 'U', scale: 'S' });
  });

  it('needs a stack to write workflows in an empty repo', async () => {
    const { run, codes, out } = cli();
    await run('setup', '--workflows');
    expect(codes).toContain(1);
    expect(out.join('\n')).toContain('--stack');
    const unknown = cli();
    await unknown.run('setup', '--workflows', '--stack', 'cobol');
    expect(unknown.codes).toContain(1);
  });

  it('writes the workflows for a confirmed stack, and refuses to overwrite', async () => {
    const first = cli();
    await first.run('setup', '--workflows', '--stack', 'go', '--json');
    expect(first.json().files).toEqual([
      '.github/workflows/sentinel-tests.yml',
      '.github/workflows/sentinel-load.yml',
    ]);
    expect(await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8')).toContain(
      'go test ./...',
    );

    const again = cli();
    await again.run('setup', '--workflows', '--stack', 'go');
    expect(again.codes).toContain(1);
    expect(again.out.join('\n')).toContain('already exists');

    const forced = cli();
    await forced.run('setup', '--workflows', '--stack', 'go', '--force');
    expect(forced.codes).not.toContain(1);
  });

  it('uses the detected stack in an existing project', async () => {
    await writeFile(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: {} }),
      'utf8',
    );
    await writeFile(join(repo, 'pnpm-lock.yaml'), '', 'utf8');
    const { run } = cli();
    await run('setup', '--workflows');
    expect(await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8')).toContain(
      'pnpm install',
    );
  });

  it('writes a README from the answers, and needs the core answers first', async () => {
    const early = cli();
    await early.run('setup', '--readme');
    expect(early.codes).toContain(1);

    await writeJson('a.json', core);
    await cli().run('setup', '--answers', 'a.json');
    const { run } = cli();
    await run('setup', '--readme', '--name', 'Demo');
    const readme = await readFile(join(repo, 'README.md'), 'utf8');
    expect(readme).toContain('# Demo');
    expect(readme).toContain('```mermaid');

    const again = cli();
    await again.run('setup', '--readme');
    expect(again.codes).toContain(1);
  });

  const decision = {
    layers: [
      {
        name: 'backend',
        path: 'src/backend',
        ecosystem: 'dotnet',
        language: 'C#',
        frameworks: ['ASP.NET Core'],
      },
      {
        name: 'frontend',
        path: 'src/web',
        ecosystem: 'node',
        language: 'TypeScript',
        frameworks: ['React'],
      },
      { name: 'database', language: 'SQL', frameworks: ['PostgreSQL'] },
    ],
    architecture: {
      style: 'Vertical slices around a pure domain project',
      ddd: 'tactical',
      principles: ['SOLID'],
      rationale: 'One small team ships features end to end.',
    },
    alternatives: [{ style: 'Clean Architecture', reason: 'Too many layers for two people.' }],
    folders: [
      { path: 'src/backend/Domain', purpose: 'Entities and rules, no I/O' },
      { path: 'src/web', purpose: 'React app' },
    ],
  };
  type ArchitectureResult = SetupResult & {
    architecture: { path: string; recorded: boolean; adr: string | null };
    problems?: string[];
  };

  it('reports that no architecture decision is recorded yet', async () => {
    const { run, json } = cli();
    await run('setup', '--questions', '--json');
    expect((json() as ArchitectureResult).architecture).toEqual({
      path: '.sentinel/architecture.json',
      recorded: false,
      adr: null,
    });
  });

  it('records the architecture decision and its ADR', async () => {
    await writeJson('decision.json', decision);
    const { run, json, codes } = cli();
    await run('setup', '--architecture', 'decision.json', '--json');
    const result = json() as ArchitectureResult;
    expect(result.problems).toBeUndefined();
    expect(codes).not.toContain(1);
    expect(result.files).toEqual([
      '.sentinel/architecture.json',
      'docs/adr/0001-stack-and-architecture.md',
    ]);
    expect(result.architecture).toEqual({
      path: '.sentinel/architecture.json',
      recorded: true,
      adr: 'docs/adr/0001-stack-and-architecture.md',
    });
    const stored = JSON.parse(
      await readFile(join(repo, '.sentinel', 'architecture.json'), 'utf8'),
    ) as { version: number; decidedAt: string; adr: string };
    expect(stored).toMatchObject({
      version: 1,
      decidedAt: '2026-03-05T12:00:00.000Z',
      adr: 'docs/adr/0001-stack-and-architecture.md',
    });
    const adr = await readFile(join(repo, 'docs/adr/0001-stack-and-architecture.md'), 'utf8');
    expect(adr).toContain('# ADR-0001: Stack and architecture');
    expect(adr).toContain('Vertical slices around a pure domain project');
  });

  it('numbers the ADR after existing ones and refuses to overwrite without --force', async () => {
    await mkdir(join(repo, 'docs', 'adr'), { recursive: true });
    await writeFile(join(repo, 'docs/adr/0004-logging.md'), '# ADR-0004\n', 'utf8');
    await writeJson('decision.json', decision);
    await cli().run('setup', '--architecture', 'decision.json');
    expect(await readFile(join(repo, 'docs/adr/0005-stack-and-architecture.md'), 'utf8')).toMatch(
      /^# ADR-0005/,
    );

    const again = cli();
    await again.run('setup', '--architecture', 'decision.json');
    expect(again.codes).toContain(1);
    expect(again.out.join('\n')).toContain('already exists');

    const changed = { ...decision, architecture: { ...decision.architecture, ddd: 'none' } };
    await writeJson('decision.json', changed);
    const forced = cli();
    await forced.run('setup', '--architecture', 'decision.json', '--force', '--json');
    expect(forced.codes).not.toContain(1);
    expect((forced.json() as ArchitectureResult).architecture.adr).toBe(
      'docs/adr/0005-stack-and-architecture.md',
    );
    expect(await readFile(join(repo, 'docs/adr/0005-stack-and-architecture.md'), 'utf8')).toContain(
      '**Domain-driven design:** none',
    );
  });

  it('exits 2 with the problems when the decision is invalid, writing nothing', async () => {
    await writeJson('decision.json', { ...decision, alternatives: [] });
    const { run, json, codes } = cli();
    await run('setup', '--architecture', 'decision.json', '--json');
    expect(codes.at(-1)).toBe(2);
    const result = json() as ArchitectureResult;
    expect(result.problems?.join('\n')).toMatch(/alternatives/);
    expect(result.files).toEqual([]);
    await expect(readFile(join(repo, '.sentinel', 'architecture.json'), 'utf8')).rejects.toThrow();
  });

  it('--dry-run reports the decision files without writing them', async () => {
    await writeJson('decision.json', decision);
    const { run, json } = cli();
    await run('setup', '--architecture', 'decision.json', '--dry-run', '--json');
    expect(json().files).toContain('.sentinel/architecture.json');
    await expect(readFile(join(repo, '.sentinel', 'architecture.json'), 'utf8')).rejects.toThrow();
  });

  it('writes workflows for several ecosystems from --stack', async () => {
    const { run, codes } = cli();
    await run('setup', '--workflows', '--stack', 'dotnet:src/backend,node:src/web');
    expect(codes).not.toContain(1);
    const tests = await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8');
    expect(tests).toContain('actions/setup-dotnet');
    expect(tests).toContain('actions/setup-node');
    expect(tests).toContain('working-directory: src/backend');
    expect(tests).toContain('working-directory: src/web');
    const bad = cli();
    await bad.run('setup', '--workflows', '--stack', 'node,go');
    expect(bad.codes).toContain(1);
    expect(bad.out.join('\n')).toContain('give each a path');
  });

  it('plans the workflows from the recorded decision in an empty repo', async () => {
    await writeJson('decision.json', decision);
    const { run, json, codes } = cli();
    await run('setup', '--architecture', 'decision.json', '--workflows', '--json');
    expect(codes).not.toContain(1);
    const result = json() as ArchitectureResult & { stack: { projects: { path: string }[] } };
    expect(result.stack.projects.map((p) => p.path)).toEqual(['src/backend', 'src/web']);
    expect(result.stack.proposal).toBe(false);
    const tests = await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8');
    expect(tests).toContain('actions/setup-dotnet');
    expect(tests).toContain('actions/setup-node');
  });

  it('adds the recorded decision to the README', async () => {
    await writeJson('a.json', core);
    await writeJson('decision.json', decision);
    await cli().run('setup', '--answers', 'a.json', '--architecture', 'decision.json');
    await cli().run('setup', '--readme', '--name', 'Demo');
    const readme = await readFile(join(repo, 'README.md'), 'utf8');
    expect(readme).toContain('### Stack and architecture');
    expect(readme).toContain('docs/adr/0001-stack-and-architecture.md');
    expect(readme).toContain('- **backend**: C# (ASP.NET Core), `src/backend`');
    expect(readme).toContain('- **database**: SQL (PostgreSQL)');
  });

  it('writes nothing when another requested file already exists', async () => {
    await writeJson('a.json', core);
    await cli().run('setup', '--answers', 'a.json');
    await writeFile(join(repo, 'README.md'), '# Mine\n', 'utf8');
    await writeJson('decision.json', decision);
    const { run, codes, out } = cli();
    await run('setup', '--architecture', 'decision.json', '--workflows', '--readme');
    expect(codes).toContain(1);
    expect(out.join('\n')).toContain('README.md already exists');
    await expect(readFile(join(repo, '.sentinel', 'architecture.json'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8'),
    ).rejects.toThrow();
  });

  it('plans the recorded layers that have no code yet next to the detected ones', async () => {
    await mkdir(join(repo, 'src', 'backend', 'Api'), { recursive: true });
    await writeFile(join(repo, 'src/backend/Api/Api.csproj'), '<Project />', 'utf8');
    await writeJson('decision.json', decision);
    const { run, json } = cli();
    await run('setup', '--architecture', 'decision.json', '--workflows', '--json');
    const result = json() as ArchitectureResult & {
      stack: { projects: { path: string; ecosystem: string }[] };
      warnings: string[];
    };
    expect(result.stack.projects.map((p) => [p.path, p.ecosystem])).toEqual([
      ['src/backend/Api', 'dotnet'],
      ['src/web', 'node'],
    ]);
    expect(result.warnings.join('\n')).toContain('layer "frontend" (src/web) has no code yet');
    const tests = await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8');
    expect(tests).toContain('actions/setup-dotnet');
    expect(tests).toContain('working-directory: src/web');
  });

  it('checks the README answers before writing anything', async () => {
    await writeJson('decision.json', decision);
    const { run, codes } = cli();
    await run('setup', '--architecture', 'decision.json', '--workflows', '--readme');
    expect(codes).toContain(1);
    await expect(readFile(join(repo, '.sentinel', 'architecture.json'), 'utf8')).rejects.toThrow();
    await expect(
      readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8'),
    ).rejects.toThrow();
  });

  it('warns when --stack overrides the recorded decision', async () => {
    await writeJson('decision.json', decision);
    await cli().run('setup', '--architecture', 'decision.json');
    const { run, json } = cli();
    await run('setup', '--workflows', '--stack', 'go', '--json');
    const result = json() as ArchitectureResult & { warnings: string[] };
    expect(result.warnings.join('\n')).toContain('--stack overrides the layers');
  });

  it('replaces a corrupt recorded decision with --architecture --force', async () => {
    await mkdir(join(repo, '.sentinel'), { recursive: true });
    await writeFile(join(repo, '.sentinel', 'architecture.json'), '{"version":1}', 'utf8');
    await writeJson('decision.json', decision);
    const refused = cli();
    await refused.run('setup', '--architecture', 'decision.json');
    expect(refused.codes).toContain(5);
    const { run, json, codes } = cli();
    await run('setup', '--architecture', 'decision.json', '--force', '--json');
    expect(codes).not.toContain(5);
    expect((json() as ArchitectureResult).architecture.recorded).toBe(true);
  });

  it('fails with exit 5 when the recorded decision is corrupt', async () => {
    await mkdir(join(repo, '.sentinel'), { recursive: true });
    await writeFile(join(repo, '.sentinel', 'architecture.json'), '{"version":1}', 'utf8');
    const { run, codes, out } = cli();
    await run('setup', '--questions');
    expect(codes).toContain(5);
    expect(out.join('\n')).toContain('.sentinel/architecture.json is invalid');
  });

  const sha = 'a'.repeat(40);
  const gh =
    (stdout: string, exitCode = 0): CommandRunner =>
    (command, args, options) =>
      command === 'gh'
        ? Promise.resolve({ exitCode, stdout, stderr: '', notFound: false, timedOut: false })
        : runCommand(command, args, options);

  it('writes the lesson check pinned to a commit, and a ruleset for the user to apply', async () => {
    const c = cli({ run: gh(`${sha}\n`) });
    await c.run('setup', '--learn-verify', '--json');
    const result = c.json() as SetupResult & { ruleset: string; warnings: string[] };
    expect(result.files).toEqual(['.github/workflows/sentinel-lessons.yml']);
    expect(result.warnings).toEqual([]);
    const workflow = await readFile(
      join(repo, '.github', 'workflows', 'sentinel-lessons.yml'),
      'utf8',
    );
    expect(workflow).toContain('pull_request_target:');
    expect(workflow).toContain('name: sentinel learn verify');
    expect(workflow).toContain(`raw.githubusercontent.com/robert-nagy/sentinel/${sha}/`);
    expect(workflow).not.toContain('actions/checkout');
    expect(result.ruleset).toBe('.sentinel/state/learn-ruleset.json');
    const ruleset = JSON.parse(await readFile(join(repo, result.ruleset), 'utf8')) as {
      bypass_actors: unknown[];
      rules: { parameters: { required_status_checks: { context: string }[] } }[];
    };
    expect(ruleset.bypass_actors).toEqual([]);
    expect(ruleset.rules[0]?.parameters.required_status_checks[0]?.context).toBe(
      'sentinel learn verify',
    );

    const again = cli({ run: gh(`${sha}\n`) });
    await again.run('setup', '--learn-verify');
    expect(again.codes.at(-1)).toBe(1);
  });

  it('falls back to the tag with a warning when the commit cannot be resolved', async () => {
    const c = cli({ run: gh('', 1) });
    await c.run('setup', '--learn-verify', '--json');
    const result = c.json() as SetupResult & { warnings: string[] };
    expect(result.warnings.join()).toMatch(/downloads by tag/);
    const workflow = await readFile(
      join(repo, '.github', 'workflows', 'sentinel-lessons.yml'),
      'utf8',
    );
    expect(workflow).toMatch(/robert-nagy\/sentinel\/v\d+\.\d+\.\d+\//);
  });
});
