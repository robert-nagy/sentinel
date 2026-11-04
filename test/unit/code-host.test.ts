import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';
import { MAX_LOG_CHARS, GitHubCodeHost } from '../../src/core/hosts/github.js';
import { ProviderError } from '../../src/core/provider-error.js';

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});

/** Records calls and answers by predicate on the joined command line. */
function fakeRun(responder: (line: string) => CommandResult | undefined) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ command, args });
    const line = [command, ...args].join(' ');
    return Promise.resolve(
      responder(line) ?? {
        exitCode: null,
        stdout: '',
        stderr: '',
        notFound: true,
        timedOut: false,
      },
    );
  };
  return { run, calls };
}

describe('GitHubCodeHost', () => {
  const prJson = JSON.stringify({
    number: 9,
    url: 'https://github.com/o/r/pull/9',
    title: 'T',
    state: 'OPEN',
    isDraft: true,
    headRefName: 'feat/1',
    baseRefName: 'main',
  });

  it('creates a pull request and reads it back', async () => {
    const { run, calls } = fakeRun((l) => {
      if (l.startsWith('gh pr create')) return ok('https://github.com/o/r/pull/9\n');
      if (l.startsWith('gh pr view')) return ok(prJson);
      return undefined;
    });
    const pr = await new GitHubCodeHost({ run, cwd: '/r' }).createPullRequest({
      title: 'T',
      body: 'Closes #1',
      head: 'feat/1',
      base: 'main',
      draft: true,
    });
    expect(pr).toMatchObject({ number: 9, isDraft: true, head: 'feat/1', state: 'open' });
    expect(calls[0]?.args).toContain('--draft');
  });

  it('lists checks even when gh exits 8 (pending) and extracts run ids', async () => {
    const { run } = fakeRun(() => ({
      exitCode: 8,
      stdout: JSON.stringify([
        {
          name: 'Test',
          bucket: 'fail',
          workflow: 'CI',
          link: 'https://github.com/o/r/actions/runs/123/job/4',
        },
        { name: 'Lint', bucket: 'skipping', workflow: 'CI', link: null },
        { name: 'Odd', bucket: 'whatever' },
      ]),
      stderr: '',
      notFound: false,
      timedOut: false,
    }));
    const checks = await new GitHubCodeHost({ run, cwd: '/r' }).listChecks('9');
    expect(checks.map((c) => [c.bucket, c.runId])).toEqual([
      ['fail', '123'],
      ['skipped', undefined],
      ['pending', undefined],
    ]);
  });

  it('treats a PR without checks as no checks', async () => {
    const { run } = fakeRun(() => ok(''));
    expect(await new GitHubCodeHost({ run, cwd: '/r' }).listChecks('9')).toEqual([]);
  });

  it('truncates huge failed logs to their tail and validates run ids', async () => {
    const big = 'x'.repeat(MAX_LOG_CHARS + 50) + 'THE-END';
    const { run } = fakeRun(() => ok(big));
    const host = new GitHubCodeHost({ run, cwd: '/r' });
    const logs = await host.getFailedLogs('https://github.com/o/r/actions/runs/55/job/1');
    expect(logs.startsWith('…(truncated)')).toBe(true);
    expect(logs.endsWith('THE-END')).toBe(true);
    await expect(host.getFailedLogs('nope')).rejects.toThrow(ProviderError);
    await expect(host.rerunFailed('1; rm')).rejects.toThrow(ProviderError);
  });

  it('re-runs, comments and detects merged pull requests', async () => {
    const { run, calls } = fakeRun((l) =>
      l.startsWith('gh pr list') ? ok('[{"number":3}]') : ok(),
    );
    const host = new GitHubCodeHost({ run, cwd: '/r' });
    await host.rerunFailed('77');
    await host.comment('9', 'hi');
    expect(await host.hasMergedPullRequest('feat/x')).toBe(true);
    expect(calls[0]?.args).toEqual(['run', 'rerun', '77', '--failed']);
  });
});
