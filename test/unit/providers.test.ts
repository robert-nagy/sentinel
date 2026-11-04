import { describe, expect, it } from 'vitest';
import type { CommandResult, CommandRunner } from '../../src/core/exec.js';
import { MAX_LOG_CHARS, GitHubCodeHost } from '../../src/core/hosts/github.js';
import { ProviderError } from '../../src/core/issue-provider.js';
import { CustomIssueProvider, customOptionsSchema } from '../../src/core/providers/custom.js';
import { GitHubIssueProvider } from '../../src/core/providers/github.js';
import { createIssueProvider } from '../../src/core/providers/index.js';
import { ConfigError } from '../../src/core/config.js';

const ok = (stdout = ''): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  notFound: false,
  timedOut: false,
});
const fail = (stderr: string, exitCode = 1): CommandResult => ({
  exitCode,
  stdout: '',
  stderr,
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
      responder(line) ?? { exitCode: null, stdout: '', stderr: '', notFound: true, timedOut: false },
    );
  };
  return { run, calls };
}

const ghIssueJson = (n: number, title = 'Add login', extra: object = {}) =>
  JSON.stringify({
    number: n,
    title,
    body: null,
    state: 'OPEN',
    labels: [{ name: 'kind/bug' }],
    url: `https://github.com/o/r/issues/${String(n)}`,
    assignees: [{ login: 'ada' }],
    ...extra,
  });

describe('GitHubIssueProvider', () => {
  it('reads an issue through gh and normalises it', async () => {
    const { run, calls } = fakeRun((l) => (l.startsWith('gh issue view 42 ') ? ok(ghIssueJson(42)) : undefined));
    const issue = await new GitHubIssueProvider({ run, cwd: '/r' }).getIssue('#42');
    expect(issue).toEqual({
      id: '42',
      title: 'Add login',
      body: '',
      state: 'open',
      labels: ['kind/bug'],
      url: 'https://github.com/o/r/issues/42',
      assignees: ['ada'],
    });
    expect(calls[0]?.command).toBe('gh');
  });

  it('targets another repository when configured', async () => {
    const { run, calls } = fakeRun(() => ok(ghIssueJson(1)));
    await new GitHubIssueProvider({ run, cwd: '/r', repo: 'o/x' }).getIssue('1');
    expect(calls[0]?.args.slice(-2)).toEqual(['--repo', 'o/x']);
  });

  it('rejects non-numeric ids before calling gh', async () => {
    const { run, calls } = fakeRun(() => ok());
    await expect(new GitHubIssueProvider({ run, cwd: '/r' }).getIssue('PROJ-1')).rejects.toThrow(
      /numbers/,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['To get started with GitHub CLI, please run:  gh auth login', 'auth'],
    ['GraphQL: Could not resolve to an issue or pull request with the number of 9.', 'not-found'],
    ['boom', 'failed'],
  ])('classifies gh failure %j as %s', async (stderr, kind) => {
    const { run } = fakeRun(() => fail(stderr));
    await expect(new GitHubIssueProvider({ run, cwd: '/r' }).getIssue('9')).rejects.toMatchObject({
      kind,
    });
  });

  it('reports a missing gh as unavailable', async () => {
    const { run } = fakeRun(() => undefined);
    await expect(new GitHubIssueProvider({ run, cwd: '/r' }).getIssue('1')).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('rejects malformed gh output', async () => {
    const { run } = fakeRun(() => ok('not json'));
    await expect(new GitHubIssueProvider({ run, cwd: '/r' }).getIssue('1')).rejects.toThrow(/invalid JSON/);
    const bad = fakeRun(() => ok('{"number":"x"}'));
    await expect(new GitHubIssueProvider({ run: bad.run, cwd: '/r' }).getIssue('1')).rejects.toThrow(
      /unexpected gh output/,
    );
  });

  it('lists with filters and mapped labels', async () => {
    const { run, calls } = fakeRun(() => ok(`[${ghIssueJson(1)}]`));
    const provider = new GitHubIssueProvider({ run, cwd: '/r', labelMap: { bug: 'kind/bug' } });
    const issues = await provider.listIssues({ state: 'all', labels: ['bug'], search: 'login', limit: 5 });
    expect(issues).toHaveLength(1);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining(['--state', 'all', '--limit', '5', '--label', 'kind/bug', '--search', 'login']),
    );
  });

  it('creates an issue and reads it back, passing values as separate arguments', async () => {
    const { run, calls } = fakeRun((l) => {
      if (l.startsWith('gh issue create')) return ok('https://github.com/o/r/issues/7\n');
      if (l.startsWith('gh issue view 7')) return ok(ghIssueJson(7, 'Hi'));
      return undefined;
    });
    const provider = new GitHubIssueProvider({ run, cwd: '/r', labelMap: { bug: 'kind/bug' } });
    const created = await provider.createIssue({ title: 'Hi; rm -rf', body: '--body\nx', labels: ['bug'] });
    expect(created.id).toBe('7');
    expect(calls[0]?.args).toEqual([
      'issue', 'create', '--title', 'Hi; rm -rf', '--body', '--body\nx', '--label', 'kind/bug',
    ]);
  });

  it('comments, links and finds duplicates', async () => {
    const { run, calls } = fakeRun((l) =>
      l.startsWith('gh issue list')
        ? ok(`[${ghIssueJson(1, 'Add login page')}, ${ghIssueJson(2, 'Unrelated thing')}]`)
        : ok(),
    );
    const provider = new GitHubIssueProvider({ run, cwd: '/r' });
    await provider.addComment('3', 'hello');
    await provider.linkPullRequest('3', 'https://github.com/o/r/pull/9');
    expect(calls[1]?.args).toContain('Linked pull request: https://github.com/o/r/pull/9');
    expect((await provider.findDuplicates('Add login page')).map((i) => i.id)).toEqual(['1']);
    expect(provider.capabilities().createIssue).toBe(true);
    expect(provider.describe()).toContain('GitHub Issues');
  });
});

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
        { name: 'Test', bucket: 'fail', workflow: 'CI', link: 'https://github.com/o/r/actions/runs/123/job/4' },
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
    const { run, calls } = fakeRun((l) => (l.startsWith('gh pr list') ? ok('[{"number":3}]') : ok()));
    const host = new GitHubCodeHost({ run, cwd: '/r' });
    await host.rerunFailed('77');
    await host.comment('9', 'hi');
    expect(await host.hasMergedPullRequest('feat/x')).toBe(true);
    expect(calls[0]?.args).toEqual(['run', 'rerun', '77', '--failed']);
  });
});

describe('CustomIssueProvider', () => {
  const options = customOptionsSchema.parse({
    commands: {
      getIssue: 'linear issue view {id} --json',
      listIssues: 'linear issue list --search {query} --limit {limit}',
      createIssue: 'linear issue create --title {title} --body {body} --labels {labels}',
    },
  });
  const json = (n: number, title = 'Task') =>
    JSON.stringify({ id: `ENG-${String(n)}`, title, state: 'Done', labels: ['x'], url: 'u' });

  it('runs templates without a shell and maps the JSON contract', async () => {
    const { run, calls } = fakeRun(() => ok(json(1)));
    const issue = await new CustomIssueProvider({ run, cwd: '/r', options }).getIssue('ENG-1');
    expect(issue).toMatchObject({ id: 'ENG-1', state: 'closed', body: '', labels: ['x'] });
    expect(calls[0]).toEqual({ command: 'linear', args: ['issue', 'view', 'ENG-1', '--json'] });
  });

  it('accepts numeric ids and lists', async () => {
    const { run } = fakeRun(() => ok(JSON.stringify([{ id: 5, title: 'A' }])));
    const issues = await new CustomIssueProvider({ run, cwd: '/r', options }).listIssues({ search: 'a b' });
    expect(issues[0]).toMatchObject({ id: '5', state: 'open' });
  });

  it('keeps hostile values as single arguments', async () => {
    const { run, calls } = fakeRun(() => ok(json(2)));
    await new CustomIssueProvider({ run, cwd: '/r', options, labelMap: { bug: 'Bug' } }).createIssue({
      title: 'x" ; echo pwned',
      body: '$(whoami)',
      labels: ['bug', 'other'],
    });
    expect(calls[0]?.args).toEqual([
      'issue', 'create', '--title', 'x" ; echo pwned', '--body', '$(whoami)', '--labels', 'Bug,other',
    ]);
  });

  it('reports unsupported operations, bad output and command failures', async () => {
    const { run } = fakeRun(() => ok('nope'));
    const provider = new CustomIssueProvider({ run, cwd: '/r', options });
    await expect(provider.addComment('1', 'x')).rejects.toMatchObject({ kind: 'unsupported' });
    await expect(provider.getIssue('1')).rejects.toThrow(/valid JSON/);
    const bad = fakeRun(() => ok('{"title":"no id"}'));
    await expect(
      new CustomIssueProvider({ run: bad.run, cwd: '/r', options }).getIssue('1'),
    ).rejects.toThrow(/contract/);
    const failing = fakeRun(() => fail('denied', 3));
    await expect(
      new CustomIssueProvider({ run: failing.run, cwd: '/r', options }).getIssue('1'),
    ).rejects.toThrow(/exit 3/);
    const missing = fakeRun(() => undefined);
    await expect(
      new CustomIssueProvider({ run: missing.run, cwd: '/r', options }).getIssue('1'),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('describes its capabilities and skips duplicates without a list command', async () => {
    const minimal = customOptionsSchema.parse({ commands: { getIssue: 'tool {id}' } });
    const { run } = fakeRun(() => ok());
    const provider = new CustomIssueProvider({ run, cwd: '/r', options: minimal });
    expect(await provider.findDuplicates('x')).toEqual([]);
    expect(provider.capabilities()).toMatchObject({ listIssues: false, createIssue: false });
    expect(provider.describe()).toContain('Not available');
  });

  it('validates its options', () => {
    expect(customOptionsSchema.safeParse({ commands: {} }).success).toBe(false);
    expect(customOptionsSchema.safeParse({ commands: { getIssue: 'tool {bad}' } }).success).toBe(false);
    expect(customOptionsSchema.safeParse({ commands: { getIssue: 'tool' }, extra: 1 }).success).toBe(false);
  });
});

describe('createIssueProvider', () => {
  const context = { run: fakeRun(() => ok()).run, cwd: '/r' };
  it('builds github and custom providers', () => {
    expect(createIssueProvider({ type: 'github', options: {} }, context).type).toBe('github');
    expect(
      createIssueProvider(
        { type: 'custom', options: { commands: { getIssue: 'tool {id}' } } },
        context,
      ).type,
    ).toBe('custom');
  });
  it('rejects bad options as configuration errors', () => {
    expect(() => createIssueProvider({ type: 'github', options: { repo: 'nope' } }, context)).toThrow(ConfigError);
    expect(() => createIssueProvider({ type: 'custom', options: {} }, context)).toThrow(ConfigError);
  });
  it('reports providers that are not implemented yet', () => {
    expect(() => createIssueProvider({ type: 'jira', options: {} }, context)).toThrow(ProviderError);
  });
});
