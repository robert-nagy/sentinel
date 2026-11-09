import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { runCommand } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-setup-'));
  await mkdir(join(repo, '.git'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cli(extra: { interactive?: boolean; replies?: string[] } = {}) {
  const out: string[] = [];
  const codes: number[] = [];
  const replies = [...(extra.replies ?? [])];
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
    interactive: extra.interactive ?? false,
    ask: () => Promise.resolve(replies.shift() ?? ''),
  };
  return {
    out,
    codes,
    json: () => JSON.parse(out.join('')) as Record<string, any>,
    run: (...args: string[]) => main(['node', 'sentinel', ...args], deps),
  };
}

const core = { problem: 'P', users: 'U', data: 'D', scale: 'S' };
const writeJson = (name: string, value: unknown) => writeFile(join(repo, name), JSON.stringify(value), 'utf8');
const domain = async () =>
  JSON.parse(await readFile(join(repo, '.sentinel', 'domain.json'), 'utf8')) as Record<string, any>;

describe('sentinel setup', () => {
  it('lists the open questions and an empty-stack proposal without writing', async () => {
    const { run, json, codes } = cli();
    await run('setup', '--questions', '--json');
    const result = json();
    expect(result.next.map((q: { id: string }) => q.id)).toEqual(['problem', 'users', 'data', 'scale']);
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
    expect(await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8')).toContain('go test ./...');

    const again = cli();
    await again.run('setup', '--workflows', '--stack', 'go');
    expect(again.codes).toContain(1);
    expect(again.out.join('\n')).toContain('already exists');

    const forced = cli();
    await forced.run('setup', '--workflows', '--stack', 'go', '--force');
    expect(forced.codes).not.toContain(1);
  });

  it('uses the detected stack in an existing project', async () => {
    await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'x', devDependencies: {} }), 'utf8');
    await writeFile(join(repo, 'pnpm-lock.yaml'), '', 'utf8');
    const { run } = cli();
    await run('setup', '--workflows');
    expect(await readFile(join(repo, '.github/workflows/sentinel-tests.yml'), 'utf8')).toContain('pnpm install');
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
});
