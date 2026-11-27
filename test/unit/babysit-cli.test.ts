import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CommandRunner } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';
import { lessonId, renderLesson } from '../../src/core/learnings.js';
import { parseFailureLog } from '../../src/core/log-parser.js';
import { StateStore } from '../../src/core/state.js';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'sentinel-babysit-cli-'));
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

function fakeGh(checks: object[], log = ''): CommandRunner {
  return (_command, args) => {
    const text = args.join(' ');
    if (text.startsWith('pr view')) {
      return Promise.resolve(
        ok(
          JSON.stringify({
            number: 7,
            url: 'https://github.com/o/r/pull/7',
            title: 't',
            state: 'OPEN',
            isDraft: false,
            headRefName: 'feat/7',
            baseRefName: 'main',
          }),
        ),
      );
    }
    if (text.startsWith('pr checks')) return Promise.resolve(ok(JSON.stringify(checks)));
    if (text.startsWith('run view')) return Promise.resolve(ok(log));
    return Promise.resolve(ok(''));
  };
}

function cli(run: CommandRunner) {
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
    env: { XDG_CONFIG_HOME: join(repo, 'xdg'), APPDATA: join(repo, 'appdata') },
    now: () => new Date('2026-03-05T12:00:00Z'),
  };
  return { out, codes, run: (...args: string[]) => main(['node', 'sentinel', ...args], deps) };
}

const link = 'https://github.com/o/r/actions/runs/55/job/1';

describe('sentinel babysit', () => {
  it('exits 0 with action done when CI is green', async () => {
    const { run, out, codes } = cli(fakeGh([{ name: 'ci', bucket: 'pass', workflow: 'CI', link }]));
    await run('babysit', '7', '--once', '--json');
    expect(JSON.parse(out.join('')) as unknown).toMatchObject({ action: 'done' });
    expect(codes.at(-1)).toBe(0);
  });

  it('exits 2 with a failure packet when a fix is needed', async () => {
    const log = 'ci\tbuild\t2026-01-01T00:00:00Z src/a.ts(1,1): error TS2322: bad';
    const { run, out, codes } = cli(
      fakeGh([{ name: 'ci', bucket: 'fail', workflow: 'CI', link }], log),
    );
    await run('babysit', '7', '--once', '--json');
    const result = JSON.parse(out.join('')) as {
      action: string;
      packet: { errors: { file: string }[] };
    };
    expect(result.action).toBe('patch');
    expect(result.packet.errors[0]?.file).toBe('src/a.ts');
    expect(codes.at(-1)).toBe(2);
  });

  it('exits 0 with action wait while checks run in once mode', async () => {
    const { run, out, codes } = cli(
      fakeGh([{ name: 'ci', bucket: 'pending', workflow: 'CI', link }]),
    );
    await run('babysit', '7', '--once');
    expect(out.join('\n')).toContain('wait: checks are still running');
    expect(codes.at(-1)).toBe(0);
  });

  describe('recurring failures', () => {
    const log = 'ci\tbuild\t2026-01-01T00:00:00Z src/a.ts(1,1): error TS2322: bad';
    const failing = () => fakeGh([{ name: 'ci', bucket: 'fail', workflow: 'CI', link }], log);

    it('is not recurring the first time', async () => {
      const { run, out } = cli(failing());
      await run('babysit', '7', '--once', '--json');
      expect(JSON.parse(out.join('')) as unknown).toMatchObject({
        recurring: false,
        recurringPrs: [],
        lessons: [],
      });
    });

    it('names other PRs with the same signature and the lessons that carry it', async () => {
      const { signature } = parseFailureLog(log, ['ci']);
      const state = new StateStore(repo);
      await state.write('babysit-pr-3', {
        pr: 3,
        attempts: 1,
        signatures: { [signature]: { seen: 1, reran: false } },
        lastRunIds: [],
        afterRerun: false,
        gaveUp: false,
      });
      const lessons = join(repo, '.sentinel', 'learnings');
      await mkdir(lessons, { recursive: true });
      const lesson = {
        id: lessonId('Fix the type of a', '2026-03-05'),
        summary: 'Fix the type of a',
        scope: ['src/**'],
        tags: [],
        signature,
        source: 'ci-signature' as const,
        created: '2026-03-05',
        body: 'Declare a as number.',
      };
      await writeFile(join(lessons, `${lesson.id}.md`), renderLesson(lesson), 'utf8');

      const { run, out } = cli(failing());
      await run('babysit', '7', '--once', '--json');
      const result = JSON.parse(out.join('')) as {
        recurring: boolean;
        recurringPrs: number[];
        lessons: { id: string; body: string }[];
      };
      expect(result.recurring).toBe(true);
      expect(result.recurringPrs).toEqual([3]);
      expect(result.lessons).toEqual([
        expect.objectContaining({ id: lesson.id, body: 'Declare a as number.' }),
      ]);
    });
  });

  it('counts an archived lesson with the same signature as recurring', async () => {
    const log = 'ci\tbuild\t2026-01-01T00:00:00Z src/a.ts(1,1): error TS2322: bad';
    const { signature } = parseFailureLog(log, ['ci']);
    const lessons = join(repo, '.sentinel', 'learnings');
    await mkdir(lessons, { recursive: true });
    const lesson = {
      id: lessonId('Old fix of a', '2026-03-05'),
      summary: 'Old fix of a',
      scope: ['src/**'],
      tags: [],
      signature,
      source: 'ci-signature' as const,
      created: '2026-03-05',
      body: 'Declare a as number.',
    };
    await writeFile(join(lessons, `${lesson.id}.md`), renderLesson(lesson), 'utf8');
    await new StateStore(repo).write('learn-usage', {
      version: 1,
      lessons: { [`shared:${lesson.id}`]: { recurrences: 0, recalls: 0, archived: '2026-03-01' } },
      prs: {},
    });
    const { run, out } = cli(fakeGh([{ name: 'ci', bucket: 'fail', workflow: 'CI', link }], log));
    await run('babysit', '7', '--once', '--json');
    expect(JSON.parse(out.join('')) as unknown).toMatchObject({ recurring: true, lessons: [] });
  });

  it('still prints the packet when the lessons cannot be read', async () => {
    const log = 'ci\tbuild\t2026-01-01T00:00:00Z src/a.ts(1,1): error TS2322: bad';
    await mkdir(join(repo, '.sentinel', 'state'), { recursive: true });
    await writeFile(join(repo, '.sentinel', 'state', 'learn-usage.json'), '{broken', 'utf8');
    const { run, out, codes } = cli(
      fakeGh([{ name: 'ci', bucket: 'fail', workflow: 'CI', link }], log),
    );
    await run('babysit', '7', '--once', '--json');
    const json = out.find((line) => line.trim().startsWith('{')) ?? '';
    expect(JSON.parse(json) as unknown).toMatchObject({ action: 'patch', lessons: [] });
    expect(codes.at(-1)).toBe(2);
  });

  it('records the head SHA of the open pull request', async () => {
    const run: CommandRunner = (command, args) => {
      const text = args.join(' ');
      if (text.startsWith('pr view'))
        return Promise.resolve(
          ok(
            JSON.stringify({
              number: 7,
              url: 'https://github.com/o/r/pull/7',
              title: 't',
              state: 'OPEN',
              isDraft: false,
              headRefName: 'feat/7',
              baseRefName: 'main',
              headRefOid: 'abc1234',
            }),
          ),
        );
      return fakeGh([{ name: 'ci', bucket: 'pending', workflow: 'CI', link }])(command, args);
    };
    await cli(run).run('babysit', '7', '--once');
    expect(await new StateStore(repo).read('babysit-pr-7')).toMatchObject({ headSha: 'abc1234' });
  });

  describe('learnable', () => {
    const merged =
      (author: string, commits: string): CommandRunner =>
      (command, args) => {
        const text = args.join(' ');
        if (text.startsWith('pr view'))
          return Promise.resolve(
            ok(
              JSON.stringify({
                number: 7,
                url: 'https://github.com/o/r/pull/7',
                title: 't',
                state: 'MERGED',
                isDraft: false,
                headRefName: 'feat/7',
                baseRefName: 'main',
              }),
            ),
          );
        if (text === 'api user --jq .login') return Promise.resolve(ok('me\n'));
        if (text.endsWith('repos/{owner}/{repo}/pulls/7'))
          return Promise.resolve(
            ok(
              JSON.stringify({
                number: 7,
                login: author,
                type: 'User',
                association: 'OWNER',
                headSha: 'abcdef1',
                merged: true,
              }),
            ),
          );
        if (text.includes('pulls/7/commits')) return Promise.resolve(ok(commits));
        return Promise.resolve(ok(''));
      };
    const byDana = JSON.stringify({
      sha: 'c3',
      login: 'dana',
      type: 'User',
      message: 'fix',
      url: '',
    });

    it('is true once for a merged PR of your own with commits by others', async () => {
      const first = cli(merged('me', byDana));
      await first.run('babysit', '7', '--once', '--json');
      expect(JSON.parse(first.out.join('')) as unknown).toMatchObject({
        action: 'done',
        learnable: true,
      });
      const again = cli(merged('me', byDana));
      await again.run('babysit', '7', '--once', '--json');
      expect(JSON.parse(again.out.join('')) as unknown).toMatchObject({ learnable: false });
    });

    it("is false for someone else's PR or one with nothing to learn", async () => {
      for (const run of [merged('dana', byDana), merged('me', '')]) {
        const c = cli(run);
        await c.run('babysit', '7', '--once', '--json');
        expect(JSON.parse(c.out.join('')) as unknown).toMatchObject({
          action: 'done',
          learnable: false,
        });
        expect(c.codes.at(-1)).toBe(0);
      }
    });
  });
});
