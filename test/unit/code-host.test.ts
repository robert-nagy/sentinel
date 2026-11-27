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

describe('GitHubCodeHost as a PullRequestReader', () => {
  const fail = (stderr: string): CommandResult => ({
    exitCode: 1,
    stdout: '',
    stderr,
    notFound: false,
    timedOut: false,
  });

  it('reads the signed-in login', async () => {
    const { run, calls } = fakeRun((l) =>
      l === 'gh api user --jq .login' ? ok('octo\n') : undefined,
    );
    expect(await new GitHubCodeHost({ run, cwd: '/r' }).currentLogin()).toBe('octo');
    expect(calls[0]?.args).toEqual(['api', 'user', '--jq', '.login']);
  });

  it('reads who opened a pull request from the API, flagging bots', async () => {
    const { run, calls } = fakeRun((l) =>
      l.includes('repos/{owner}/{repo}/pulls/36')
        ? ok(
            JSON.stringify({
              number: 36,
              login: 'github-actions[bot]',
              type: 'Bot',
              association: 'NONE',
              headSha: 'abc1234',
              merged: true,
            }),
          )
        : undefined,
    );
    const author = await new GitHubCodeHost({ run, cwd: '/r' }).getPullRequestAuthor(36);
    expect(author).toEqual({
      number: 36,
      login: 'github-actions[bot]',
      isBot: true,
      association: 'NONE',
      headSha: 'abc1234',
      merged: true,
    });
    expect(calls[0]?.args.at(-1)).toBe('repos/{owner}/{repo}/pulls/36');
  });

  it('rejects a pull request number that is not a positive integer', async () => {
    const { run } = fakeRun(() => ok('{}'));
    await expect(new GitHubCodeHost({ run, cwd: '/r' }).getPullRequestAuthor(0)).rejects.toThrow(
      ProviderError,
    );
  });

  it("lists only the user's merged PRs, newest first, with commit and comment authors", async () => {
    const rows = [
      {
        number: 1,
        title: 'old',
        url: 'u1',
        author: { login: 'me' },
        mergedAt: '2026-01-01T00:00:00Z',
        headRefName: 'feat/1',
        commits: [{ authors: [{ login: 'me' }, { login: 'claude' }] }, { authors: [] }],
        reviews: [
          { author: { login: 'dana' }, body: 'use path.join here', state: 'COMMENTED' },
          { author: { login: 'erin' }, body: '', state: 'APPROVED' },
          { author: { login: 'finn' }, body: '', state: 'COMMENTED' },
        ],
        comments: [{ author: null }],
      },
      {
        number: 2,
        title: 'new',
        url: 'u2',
        author: { login: 'me' },
        mergedAt: '2026-02-01T00:00:00Z',
        headRefName: 'feat/2',
      },
    ];
    const { run, calls } = fakeRun((l) =>
      l.startsWith('gh pr list') ? ok(JSON.stringify(rows)) : undefined,
    );
    const prs = await new GitHubCodeHost({ run, cwd: '/r' }).listMyMergedPullRequests(100);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--author', '@me', '--state', 'merged']),
    );
    expect(prs.map((p) => p.number)).toEqual([2, 1]);
    expect(prs[1]).toMatchObject({
      commitAuthors: ['me', undefined],
      commentAuthors: ['dana', 'finn'],
    });
  });

  it('reads paginated commits as one JSON object per line', async () => {
    const lines = [
      { sha: 'a1', login: 'me', type: 'User', message: 'feat: x', url: 'c1' },
      { sha: 'b2', login: null, type: null, message: 'fix: y', url: 'c2' },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n');
    const { run, calls } = fakeRun((l) =>
      l.includes('pulls/5/commits') ? ok(`${lines}\n`) : undefined,
    );
    const commits = await new GitHubCodeHost({ run, cwd: '/r' }).listPullRequestCommits(5);
    expect(commits).toEqual([
      { sha: 'a1', author: 'me', isBot: false, message: 'feat: x', url: 'c1' },
      { sha: 'b2', author: undefined, isBot: false, message: 'fix: y', url: 'c2' },
    ]);
    expect(calls[0]?.args).toContain('--paginate');
  });

  it('merges inline, review and conversation comments, dropping empty review bodies', async () => {
    const { run } = fakeRun((l) => {
      if (l.includes('pulls/5/comments'))
        return ok(
          JSON.stringify({
            id: 1,
            login: 'dana',
            type: 'User',
            body: 'use path.join',
            path: 'a.ts',
            line: 3,
            url: 'x',
          }),
        );
      if (l.includes('pulls/5/reviews'))
        return ok(
          [
            JSON.stringify({ id: 2, login: 'dana', type: 'User', body: '', url: 'y' }),
            JSON.stringify({
              id: 3,
              login: 'dana',
              type: 'User',
              body: 'LGTM after fix',
              url: 'y',
            }),
          ].join('\n'),
        );
      if (l.includes('issues/5/comments'))
        return ok(
          JSON.stringify({ id: 4, login: 'renovate[bot]', type: 'Bot', body: 'bump', url: 'z' }),
        );
      return undefined;
    });
    const comments = await new GitHubCodeHost({ run, cwd: '/r' }).listPullRequestComments(5);
    expect(comments.map((c) => [c.id, c.kind, c.isBot])).toEqual([
      ['inline-1', 'inline', false],
      ['review-3', 'review', false],
      ['conversation-4', 'conversation', true],
    ]);
    expect(comments[0]).toMatchObject({ file: 'a.ts', line: 3 });
  });

  it('walks git trees to a directory, reporting a symlinked component, and reads blobs', async () => {
    const tree = (entries: object[]) => ok(entries.map((e) => JSON.stringify(e)).join('\n'));
    const { run } = fakeRun((l) => {
      if (l.includes('git/commits/abcdef1')) return ok('aaaaaaa\n');
      if (l.includes('git/trees/aaaaaaa'))
        return tree([{ name: '.sentinel', mode: '040000', type: 'tree', sha: 'bbbbbbb' }]);
      if (l.includes('git/trees/bbbbbbb'))
        return tree([{ name: 'learnings', mode: '040000', type: 'tree', sha: 'ccccccc' }]);
      if (l.includes('git/trees/ccccccc'))
        return tree([{ name: 'L-1.md', mode: '120000', type: 'blob', sha: 'ddddddd' }]);
      if (l.includes('git/blobs/ddddddd'))
        return ok(
          JSON.stringify({ encoding: 'base64', content: Buffer.from('x\n').toString('base64') }),
        );
      if (l.includes('git/commits/eeeeeee')) return ok('fffffff\n');
      if (l.includes('git/trees/fffffff'))
        return tree([{ name: '.sentinel', mode: '120000', type: 'blob', sha: '1111111' }]);
      return undefined;
    });
    const host = new GitHubCodeHost({ run, cwd: '/r' });
    expect(await host.listTreeAt('abcdef1', '.sentinel/learnings')).toEqual({
      kind: 'entries',
      entries: [{ name: 'L-1.md', mode: '120000', type: 'blob', sha: 'ddddddd' }],
    });
    expect(await host.listTreeAt('eeeeeee', '.sentinel/learnings')).toEqual({
      kind: 'not-a-directory',
      path: '.sentinel',
      mode: '120000',
    });
    expect(await host.readBlob('ddddddd')).toBe('x\n');
    await expect(host.listTreeAt('main; rm -rf /', '.sentinel')).rejects.toThrow(ProviderError);
  });

  it("reads a user's permission and rejects a login that is not one", async () => {
    const { run, calls } = fakeRun((l) =>
      l.includes('collaborators/dana/permission') ? ok('write\n') : undefined,
    );
    const host = new GitHubCodeHost({ run, cwd: '/r' });
    expect(await host.getPermission('dana')).toBe('write');
    expect(calls[0]?.args).toContain('repos/{owner}/{repo}/collaborators/dana/permission');
    await expect(host.getPermission('../../x')).rejects.toThrow(ProviderError);
  });

  it('turns an authentication failure into a ProviderError', async () => {
    const { run } = fakeRun(() => fail('HTTP 401: Bad credentials'));
    await expect(
      new GitHubCodeHost({ run, cwd: '/r' }).listPullRequestFiles(5),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});
