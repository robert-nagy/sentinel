import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import type { CommandRunner } from '../../src/core/exec.js';
import { nodeFiles } from '../../src/core/fs.js';

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
});
