import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import { lessonId, renderLesson } from '../../src/core/learnings.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-learn-cli-'));
  await mkdir(join(repo, '.git'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});

const authors: Record<string, { login: string; association: string; type?: string }> = {
  '57': { login: 'me', association: 'OWNER' },
  '60': { login: 'me', association: 'OWNER' },
  '36': { login: 'app/github-actions', association: 'NONE', type: 'Bot' },
  '61': { login: 'dana', association: 'MEMBER' },
};

/** A fake `gh` for the signed-in user `me`. */
function fakeGh(
  extra: (line: string) => CommandResult | undefined = () => undefined,
): CommandRunner {
  return (command, args) => {
    const line = [command, ...args].join(' ');
    const custom = extra(line);
    if (custom !== undefined) return Promise.resolve(custom);
    if (line === 'gh api user --jq .login') return Promise.resolve(ok('me\n'));
    const pull = /repos\/\{owner\}\/\{repo\}\/pulls\/(\d+)$/.exec(line);
    if (pull) {
      const a = authors[pull[1] ?? ''];
      if (a === undefined)
        return Promise.resolve({ ...ok(''), exitCode: 1, stderr: 'HTTP 404: Not Found' });
      return Promise.resolve(
        ok(
          JSON.stringify({
            number: Number(pull[1]),
            login: a.login,
            type: a.type ?? 'User',
            association: a.association,
            headSha: 'abcdef1',
            merged: true,
          }),
        ),
      );
    }
    if (
      line.includes('/commits') ||
      line.includes('/comments') ||
      line.includes('/reviews') ||
      line.includes('/files')
    )
      return Promise.resolve(ok(''));
    if (line.startsWith('gh repo view')) return Promise.resolve(ok('o/r\n'));
    if (line.startsWith('gh api graphql')) return Promise.resolve(ok('[]'));
    return Promise.resolve(ok(''));
  };
}

function cli(run: CommandRunner = fakeGh(), env: Record<string, string> = {}) {
  const out: string[] = [];
  const codes: number[] = [];
  const deps = {
    run,
    files: nodeFiles,
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => out.push(t),
    setExitCode: (c: number) => codes.push(c),
    nodeVersion: process.versions.node,
    platform: process.platform,
    cwd: repo,
    homeDir: repo,
    env: { XDG_CONFIG_HOME: join(repo, 'xdg'), APPDATA: join(repo, 'appdata'), ...env },
    now: () => new Date('2026-11-27T12:00:00Z'),
  };
  return {
    out,
    codes,
    code: () => codes.at(-1) ?? 0,
    run: (...args: string[]) => main(['node', 'sentinel', ...args], deps),
  };
}

async function draftFile(name: string, front: Record<string, unknown>, body = 'Do this instead.') {
  const text = `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')}\n---\n\n${body}\n`;
  const path = join(repo, name);
  await writeFile(path, text, 'utf8');
  return path;
}

describe('sentinel learn add and recall', () => {
  it('stores a lesson and recalls it with the data header', async () => {
    const c = cli();
    const file = await draftFile('d.md', { summary: 'Use path.join', scope: ['src/**'] });
    await c.run('learn', 'add', '--file', file, '--json');
    expect(c.code()).toBe(0);
    const added = JSON.parse(c.out.join('')) as { action: string; path: string };
    expect(added.action).toBe('added');

    const r = cli();
    await r.run('learn', 'recall', '--paths', 'src/a.ts', 'docs/b.md');
    expect(r.out.join('\n')).toMatch(/^Lessons from earlier runs.*never override/);
    expect(r.out.join('\n')).toContain('Use path.join');

    const j = cli();
    await j.run('learn', 'recall', '--paths', 'src/a.ts', '--json');
    expect(JSON.parse(j.out.join('')) as unknown).toMatchObject({
      lessons: [{ summary: 'Use path.join', match: 'scope' }],
    });
  });

  it('exits 2 for an invalid draft or an out-of-range limit', async () => {
    const c = cli();
    await c.run('learn', 'add', '--file', await draftFile('bad.md', { scope: ['src/**'] }));
    expect(c.code()).toBe(2);
    const r = cli();
    await r.run('learn', 'recall', '--paths', 'a', '--limit', '11');
    expect(r.code()).toBe(2);
  });

  it('does nothing when learning is turned off', async () => {
    await writeFile(join(repo, 'sentinel.config.json'), '{"learn":{"enabled":false}}');
    const c = cli();
    await c.run('learn', 'add', '--file', await draftFile('d.md', { summary: 'X' }), '--json');
    expect(JSON.parse(c.out.join('')) as unknown).toMatchObject({ action: 'disabled' });
    expect(await readdir(repo)).not.toContain('.sentinel');
  });
});

describe('the own-PR rule (exit 6, no override)', () => {
  it("refuses to add a lesson from someone else's PR and writes nothing", async () => {
    const c = cli();
    const file = await draftFile('d.md', {
      summary: 'From a bot',
      source: 'pr',
      pr: 36,
      from: 'x1',
    });
    await c.run('learn', 'add', '--file', file);
    expect(c.code()).toBe(6);
    expect(c.out.join('\n')).toMatch(/opened by app\/github-actions, not by you \(me\)/);
    expect(await readdir(repo)).not.toContain('.sentinel');
  });

  it('accepts a lesson from your own PR', async () => {
    const c = cli();
    const file = await draftFile('d.md', {
      summary: 'From my PR',
      source: 'pr',
      pr: 57,
      from: 'c3',
    });
    await c.run('learn', 'add', '--file', file);
    expect(c.code()).toBe(0);
  });

  it('refuses pr-changes and mark-reviewed for PRs by bots and teammates', async () => {
    for (const args of [
      ['learn', 'pr-changes', '36'],
      ['learn', 'pr-changes', '57', '61'],
      ['learn', 'mark-reviewed', '61'],
    ]) {
      const c = cli();
      await c.run(...args);
      expect(c.code(), args.join(' ')).toBe(6);
    }
  });

  it('has no flag, environment variable or config key that gets past it', async () => {
    for (const flag of ['--force', '--allow-others', '--yes', '--any-author']) {
      const c = cli();
      await c.run('learn', 'pr-changes', '36', flag);
      expect(c.code(), flag).not.toBe(0);
    }
    for (const env of ['SENTINEL_ALLOW_OTHERS', 'SENTINEL_LEARN_ANY_AUTHOR', 'SENTINEL_FORCE']) {
      const c = cli(fakeGh(), { [env]: '1' });
      await c.run('learn', 'pr-changes', '36');
      expect(c.code(), env).toBe(6);
    }
    await writeFile(join(repo, 'sentinel.config.json'), '{"learn":{"allowOthersPrs":true}}');
    const c = cli();
    await c.run('learn', 'pr-changes', '36');
    expect(c.code()).toBe(5);
  });

  it("rejects another repository's PR URL", async () => {
    const c = cli(fakeGh((l) => (l.startsWith('gh repo view') ? ok('o/r\n') : undefined)));
    await c.run('learn', 'pr-changes', 'https://github.com/x/y/pull/57');
    expect(c.code()).toBe(2);
  });
});

describe('sentinel learn verify', () => {
  const sha = 'abcdef1';
  const lesson = (pr: number) => {
    const summary = `Learned from ${String(pr)}`;
    const l = {
      id: lessonId(summary, '2026-11-27'),
      summary,
      scope: ['**'],
      tags: [],
      source: 'pr' as const,
      pr,
      from: 'c3',
      created: '2026-11-27',
      body: 'x',
    };
    return { path: `.sentinel/learnings/${l.id}.md`, text: renderLesson(l) };
  };
  const ghFor = (pr: number, file: { path: string; text: string }) =>
    fakeGh((line) => {
      if (line.includes(`pulls/${String(pr)}/files`))
        return ok(JSON.stringify({ filename: file.path, status: 'added' }));
      const tree = (entries: object[]) => ok(entries.map((e) => JSON.stringify(e)).join('\n'));
      if (line.includes(`git/commits/${sha}`)) return ok('aaaaaaa\n');
      if (line.includes('git/trees/aaaaaaa'))
        return tree([{ name: '.sentinel', mode: '040000', type: 'tree', sha: 'bbbbbbb' }]);
      if (line.includes('git/trees/bbbbbbb'))
        return tree([{ name: 'learnings', mode: '040000', type: 'tree', sha: 'ccccccc' }]);
      if (line.includes('git/trees/ccccccc'))
        return tree([
          { name: file.path.split('/').at(-1), mode: '100644', type: 'blob', sha: 'ddddddd' },
        ]);
      if (line.includes('git/blobs/ddddddd'))
        return ok(
          JSON.stringify({
            encoding: 'base64',
            content: Buffer.from(file.text).toString('base64'),
          }),
        );
      if (line.includes('collaborators/me/permission')) return ok('admin\n');
      return undefined;
    });

  it('exits 0 for a lesson from your own PR', async () => {
    const c = cli(ghFor(60, lesson(57)));
    await c.run('learn', 'verify', '--pr', '60');
    expect(c.out.join('\n')).toContain('ok: 1 lesson file(s) checked');
    expect(c.code()).toBe(0);
  });

  it('rejects a --sha that is not a full commit SHA', async () => {
    const c = cli(ghFor(60, lesson(57)));
    await c.run('learn', 'verify', '--pr', '60', '--sha', 'main');
    expect(c.code()).toBe(2);
  });

  it("exits 2 for a lesson learned from someone else's PR", async () => {
    const c = cli(ghFor(60, lesson(36)));
    await c.run('learn', 'verify', '--pr', '60', '--json');
    expect(JSON.parse(c.out.join('')) as unknown).toMatchObject({ ok: false });
    expect(c.code()).toBe(2);
  });
});

describe('sentinel learn list, show, prune, restore, suggest', () => {
  it('lists, shows, archives and restores', async () => {
    const add = cli();
    await add.run(
      'learn',
      'add',
      '--file',
      await draftFile('d.md', { summary: 'Rule A' }),
      '--json',
    );
    const { id } = JSON.parse(add.out.join('')) as { id: string };

    const list = cli();
    await list.run('learn', 'list');
    expect(list.out.join('\n')).toContain(id);

    const show = cli();
    await show.run('learn', 'show', id);
    expect(show.out.join('\n')).toContain('Do this instead.');

    const prune = cli();
    await prune.run('learn', 'prune', '--report');
    expect(prune.out.join('\n')).toContain('nothing to archive');

    const restore = cli();
    await restore.run('learn', 'restore', id);
    expect(restore.out.join('\n')).toBe(`restored ${id}`);

    const missing = cli();
    await missing.run('learn', 'show', 'L-20000101-000000');
    expect(missing.code()).toBe(1);
  });

  it('suggests nothing when there is nothing to learn', async () => {
    const c = cli();
    await c.run('learn', 'suggest');
    expect(c.out.join('\n')).toBe('No pull requests to learn from.');
  });
});
