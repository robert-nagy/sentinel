import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PullRequestAuthor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestFile,
  PullRequestReader,
  PullRequestSummary,
} from '../../src/core/code-host.js';
import {
  assertOwnPullRequest,
  markReviewed,
  parsePullRequestRef,
  prChanges,
  suggest,
  verifyLessonChanges,
} from '../../src/core/learn-pr.js';
import { LessonStore } from '../../src/core/learn-store.js';
import { LearnError, lessonId, renderLesson, type Lesson } from '../../src/core/learnings.js';
import { ProviderError } from '../../src/core/provider-error.js';

let root: string;
const now = new Date('2026-11-27T10:00:00Z');
const newStore = () =>
  new LessonStore(root, {
    now: () => now,
    settings: { maxActive: 200, archiveAfterDays: 90, recallLimit: 5 },
  });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sentinel-learn-pr-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface FakeData {
  login?: string;
  authors?: Record<number, Partial<PullRequestAuthor>>;
  merged?: PullRequestSummary[];
  commits?: Record<number, PullRequestCommit[]>;
  comments?: Record<number, PullRequestComment[]>;
  files?: Record<number, PullRequestFile[]>;
  contents?: Record<string, string>;
}

function fakeReader(data: FakeData): PullRequestReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    currentLogin: () => Promise.resolve(data.login ?? 'me'),
    repository: () => Promise.resolve('o/r'),
    getPullRequestAuthor: (pr) => {
      calls.push(`author ${String(pr)}`);
      const a = data.authors?.[pr];
      if (a === undefined) return Promise.reject(new ProviderError('not-found', 'no such PR'));
      return Promise.resolve({
        number: pr,
        login: 'me',
        isBot: false,
        association: 'OWNER',
        headSha: 'abcdef1',
        merged: true,
        ...a,
      });
    },
    listMyMergedPullRequests: () => Promise.resolve(data.merged ?? []),
    listPullRequestCommits: (pr) => {
      calls.push(`commits ${String(pr)}`);
      return Promise.resolve(data.commits?.[pr] ?? []);
    },
    listPullRequestComments: (pr) => Promise.resolve(data.comments?.[pr] ?? []),
    listPullRequestFiles: (pr) => Promise.resolve(data.files?.[pr] ?? []),
    readFileAtRef: (path, ref) => Promise.resolve(data.contents?.[`${ref}:${path}`]),
  };
}

const summary = (n: number, extra: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: n,
  title: `PR ${String(n)}`,
  url: `https://github.com/o/r/pull/${String(n)}`,
  author: 'me',
  mergedAt: `2026-11-${String(10 + (n % 15)).padStart(2, '0')}T00:00:00Z`,
  head: `feat/${String(n)}`,
  commitAuthors: ['me'],
  commentAuthors: [],
  ...extra,
});

function lessonText(extra: Partial<Lesson> = {}): { id: string; text: string } {
  const summaryText = extra.summary ?? 'Use path.join';
  const lesson: Lesson = {
    id: lessonId(summaryText, '2026-11-27'),
    summary: summaryText,
    scope: ['src/**'],
    tags: [],
    source: 'override',
    created: '2026-11-27',
    body: 'Do this instead.',
    ...extra,
  };
  return { id: lesson.id, text: renderLesson(lesson) };
}

describe('parsePullRequestRef', () => {
  it('accepts numbers, #numbers and URLs of this repository', () => {
    expect(parsePullRequestRef('57')).toBe(57);
    expect(parsePullRequestRef('#61')).toBe(61);
    expect(parsePullRequestRef('https://github.com/o/r/pull/57/files', 'o/r')).toBe(57);
  });

  it("rejects other repositories' URLs and junk", () => {
    expect(() => parsePullRequestRef('https://github.com/x/y/pull/1', 'o/r')).toThrow(/x\/y/);
    expect(() => parsePullRequestRef('57; rm -rf /')).toThrow(LearnError);
  });
});

describe('assertOwnPullRequest', () => {
  it("passes for the user's own PR, case-insensitively", async () => {
    const reader = fakeReader({ login: 'Robert', authors: { 5: { login: 'robert' } } });
    await expect(assertOwnPullRequest(reader, 5)).resolves.toMatchObject({ login: 'robert' });
  });

  it("refuses a teammate's or a bot's PR with kind forbidden, naming both logins", async () => {
    const reader = fakeReader({
      authors: { 6: { login: 'dana' }, 36: { login: 'app/github-actions', isBot: true } },
    });
    await expect(assertOwnPullRequest(reader, 6)).rejects.toMatchObject({
      kind: 'forbidden',
      message: expect.stringMatching(/dana.*me/) as unknown,
    });
    await expect(assertOwnPullRequest(reader, 36)).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('suggest', () => {
  it('lists up to 20 of the newest unlearned merged PRs with counts', async () => {
    const store = newStore();
    const { text } = lessonText({ source: 'pr', pr: 3, from: 'abc1234' });
    await store.add(text.replace(/^id:.*\n/m, '').replace(/^created:.*\n/m, ''), {
      store: 'shared',
    });
    await store.markPrs([4], 'reviewedAt');
    const merged = Array.from({ length: 30 }, (_, i) => summary(i + 1));
    merged[1] = summary(2, {
      commitAuthors: ['me', 'dana', undefined],
      commentAuthors: ['dana', 'me', 'renovate[bot]'],
    });
    merged[5] = summary(6, { author: 'dana' }); // not mine: dropped even if the host returned it
    const rows = await suggest(fakeReader({ merged }), store);
    expect(rows).toHaveLength(20);
    expect(rows.map((r) => r.number)).not.toEqual(expect.arrayContaining([3, 4, 6]));
    expect(rows.find((r) => r.number === 2)).toMatchObject({
      otherCommits: 2,
      reviewComments: 1,
      nothingToLearn: false,
    });
    expect(rows.find((r) => r.number === 1)).toMatchObject({ nothingToLearn: true });
  });

  it('offers only babysat PRs with something to learn, once', async () => {
    const store = newStore();
    const merged = [
      summary(7, { commentAuthors: ['dana'] }),
      summary(8, { commentAuthors: ['dana'] }),
      summary(9),
    ];
    const reader = fakeReader({ merged });
    const babysat = new Set([7, 9]);
    const first = await suggest(reader, store, { offer: true, babysat });
    expect(first.map((r) => r.number)).toEqual([7]);
    expect(await suggest(reader, store, { offer: true, babysat })).toEqual([]);
    expect(await suggest(reader, store, { offer: true, babysat, offerEnabled: false })).toEqual([]);
  });
});

describe('prChanges', () => {
  const commits: PullRequestCommit[] = [
    { sha: 'a1', author: 'me', isBot: false, message: 'feat: agent work', url: '' },
    { sha: 'b2', author: 'me', isBot: false, message: 'fix: my own correction', url: '' },
    { sha: 'c3', author: 'dana', isBot: false, message: 'fix: use path.join', url: '' },
    { sha: 'd4', author: 'renovate[bot]', isBot: true, message: 'chore: bump', url: '' },
  ];
  const comments: PullRequestComment[] = [
    {
      id: 'inline-1',
      kind: 'inline',
      author: 'dana',
      isBot: false,
      body: 'use path.join',
      file: 'a.ts',
      line: 3,
      url: '',
    },
    {
      id: 'conversation-2',
      kind: 'conversation',
      author: 'bot[bot]',
      isBot: true,
      body: 'coverage',
      url: '',
    },
  ];

  it("lists other people's commits and human comments, and the user's commits after the recorded head", async () => {
    const reader = fakeReader({
      authors: { 57: {} },
      commits: { 57: commits },
      comments: { 57: comments },
    });
    const [changes] = await prChanges(reader, newStore(), [57], new Map([[57, 'a1']]));
    expect(changes?.commits.map((c) => [c.sha, c.reason])).toEqual([
      ['b2', 'after-agent'],
      ['c3', 'other-author'],
    ]);
    expect(changes?.comments.map((c) => c.id)).toEqual(['inline-1']);
    expect(changes).toMatchObject({ recordedHead: true, note: undefined });
  });

  it('says so when no head was recorded', async () => {
    const reader = fakeReader({ authors: { 57: {} }, commits: { 57: commits } });
    const [changes] = await prChanges(reader, newStore(), [57]);
    expect(changes?.commits.map((c) => c.sha)).toEqual(['c3']);
    expect(changes?.note).toMatch(/no head SHA/);
  });

  it('refuses before reading anything when one PR is not the user’s', async () => {
    const reader = fakeReader({
      authors: { 57: {}, 36: { login: 'app/github-actions', isBot: true } },
    });
    await expect(prChanges(reader, newStore(), [36])).rejects.toMatchObject({ kind: 'forbidden' });
    expect(reader.calls).not.toContain('commits 36');
  });

  it('reports a PR that was learned from before', async () => {
    const store = newStore();
    await store.markPrs([57], 'reviewedAt');
    const [changes] = await prChanges(fakeReader({ authors: { 57: {} } }), store, [57]);
    expect(changes?.learned).toEqual({ lessons: [], reviewedAt: '2026-11-27' });
  });

  it('takes at most 10 PRs', async () => {
    await expect(
      prChanges(
        fakeReader({}),
        newStore(),
        Array.from({ length: 11 }, (_, i) => i + 1),
      ),
    ).rejects.toThrow(/at most 10/);
  });
});

describe('markReviewed', () => {
  it('records own PRs and refuses others', async () => {
    const store = newStore();
    const reader = fakeReader({ authors: { 1: {}, 2: { login: 'dana' } } });
    expect(await markReviewed(reader, store, [1, 1])).toEqual([1]);
    expect((await store.readUsage()).prs['1']?.reviewedAt).toBe('2026-11-27');
    await expect(markReviewed(reader, store, [2])).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('verifyLessonChanges', () => {
  const sha = 'abcdef1';

  it('passes a PR that touches no lessons, whoever opened it', async () => {
    const reader = fakeReader({
      authors: { 9: { login: 'stranger', association: 'NONE' } },
      files: { 9: [{ path: 'src/a.ts', status: 'modified' }] },
    });
    expect(await verifyLessonChanges(reader, 9)).toMatchObject({ ok: true, files: [] });
  });

  it('passes an own-PR lesson added by an owner', async () => {
    const { id, text } = lessonText({ source: 'pr', pr: 57, from: 'c3' });
    const path = `.sentinel/learnings/${id}.md`;
    const reader = fakeReader({
      authors: { 60: {}, 57: {} },
      files: { 60: [{ path, status: 'added' }] },
      contents: { [`${sha}:${path}`]: text },
    });
    expect(await verifyLessonChanges(reader, 60)).toMatchObject({ ok: true, problems: [] });
  });

  it("fails a lesson learned from someone else's PR", async () => {
    const { id, text } = lessonText({ source: 'pr', pr: 36, from: 'x1' });
    const path = `.sentinel/learnings/${id}.md`;
    const reader = fakeReader({
      authors: { 60: {}, 36: { login: 'app/github-actions', isBot: true } },
      files: { 60: [{ path, status: 'added' }] },
      contents: { [`${sha}:${path}`]: text },
    });
    const result = await verifyLessonChanges(reader, 60);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/#36 by app\/github-actions/);
  });

  it('fails any lesson change from an author without write access', async () => {
    const { id, text } = lessonText();
    const path = `.sentinel/learnings/${id}.md`;
    const reader = fakeReader({
      authors: { 61: { login: 'stranger', association: 'CONTRIBUTOR' } },
      files: { 61: [{ path, status: 'added' }] },
      contents: { [`${sha}:${path}`]: text },
    });
    const result = await verifyLessonChanges(reader, 61);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toMatch(/no write access/);
  });

  it('fails invalid lessons, wrong names, stray files and personal lessons', async () => {
    const { id, text } = lessonText();
    const reader = fakeReader({
      authors: { 62: {} },
      files: {
        62: [
          { path: `.sentinel/learnings/L-20261127-000000.md`, status: 'added' },
          { path: '.sentinel/learnings/notes.txt', status: 'added' },
          { path: '.sentinel/learnings.local/x.md', status: 'added' },
          { path: `.sentinel/learnings/L-20261127-111111.md`, status: 'added' },
          { path: `.sentinel/learnings/${id}.md`, status: 'removed' },
        ],
      },
      contents: {
        [`${sha}:.sentinel/learnings/L-20261127-000000.md`]: text,
        [`${sha}:.sentinel/learnings/L-20261127-111111.md`]: 'garbage',
      },
    });
    const result = await verifyLessonChanges(reader, 62);
    expect(result.ok).toBe(false);
    const all = result.problems.join('\n');
    expect(all).toMatch(/file name must be/);
    expect(all).toMatch(/notes\.txt: only lesson files/);
    expect(all).toMatch(/personal lessons must never be committed/);
    expect(all).toMatch(/111111\.md: the lesson needs front matter/);
    expect(result.problems).toHaveLength(4);
  });
});
