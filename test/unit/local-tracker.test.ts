import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrackerError } from '../../src/core/issue-tracker.js';
import {
  LocalTracker,
  parseLocalId,
  parseLocalIssue,
  renderLocalIssue,
} from '../../src/core/local-tracker.js';

let dir: string;
let tracker: LocalTracker;
let clock = new Date('2026-11-04T10:00:00Z');

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'sentinel-local-')), 'docs', 'issues');
  clock = new Date('2026-11-04T10:00:00Z');
  tracker = new LocalTracker(dir, () => clock);
});
afterEach(async () => {
  await rm(join(dir, '..', '..'), { recursive: true, force: true });
});

describe('parseLocalId', () => {
  it('accepts numbers and #numbers', () => {
    expect(parseLocalId('3')).toBe(3);
    expect(parseLocalId(' #12 ')).toBe(12);
    expect(parseLocalId(4)).toBe(4);
  });
  it.each(['0', 'PROJ-1', '1.5', '', '../1'])('rejects %j', (id) => {
    expect(() => parseLocalId(id)).toThrow(TrackerError);
  });
});

describe('render / parse', () => {
  it('round-trips an issue with comments', () => {
    const issue = {
      id: 2,
      title: 'Quote "this": and that',
      status: 'open' as const,
      labels: ['kind/bug', 'priority/p1'],
      created: '2026-11-04',
      body: 'Steps:\n\n1. Open\n2. Crash',
      comments: [
        { at: '2026-11-04T10:00:00.000Z', body: 'First' },
        { at: '2026-11-05T10:00:00.000Z', body: 'Second\n\nwith paragraphs' },
      ],
    };
    expect(parseLocalIssue(renderLocalIssue(issue), '/x.md')).toEqual({ ...issue, path: '/x.md' });
  });

  it('reads hand-written front matter with CRLF and bare values', () => {
    const text =
      "---\r\nid: 5\r\ntitle: Fix the build\r\nstatus: closed\r\nlabels: [kind/bug, 'ci']\r\ncreated: 2026-01-02\r\n---\r\n\r\nBody\r\n";
    expect(parseLocalIssue(text, '/5.md')).toMatchObject({
      id: 5,
      title: 'Fix the build',
      status: 'closed',
      labels: ['kind/bug', 'ci'],
      body: 'Body',
      comments: [],
    });
  });

  it('rejects files without front matter or a title', () => {
    expect(() => parseLocalIssue('# just markdown', '/a.md')).toThrow(/no front matter/);
    expect(() => parseLocalIssue('---\nid: 1\n---\n', '/a.md')).toThrow(/title/);
  });
});

describe('LocalTracker', () => {
  it('lists nothing before the directory exists', async () => {
    expect(await tracker.list({ status: 'all' })).toEqual([]);
  });

  it('creates issues with sequential ids and slugged file names', async () => {
    const a = await tracker.create({ title: 'Add login page', labels: ['kind/feature'] });
    const b = await tracker.create({ title: '日本語', body: 'unicode only title' });
    expect(a).toMatchObject({ id: 1, status: 'open', created: '2026-11-04' });
    expect(a.path).toBe(join(dir, '1-add-login-page.md'));
    expect(b.path).toBe(join(dir, '2.md'));
    expect((await tracker.get('#2')).body).toBe('unicode only title');
  });

  it('continues numbering after the highest existing id', async () => {
    await tracker.create({ title: 'one' });
    await writeFile(
      join(dir, '9-manual.md'),
      renderLocalIssue({
        id: 9,
        title: 'manual',
        status: 'open',
        labels: [],
        created: '2026-01-01',
        body: '',
        comments: [],
      }),
    );
    expect((await tracker.create({ title: 'next' })).id).toBe(10);
  });

  it('ignores unrelated files in the directory', async () => {
    await tracker.create({ title: 'one' });
    await writeFile(join(dir, 'README.md'), '# Issues');
    expect((await tracker.list()).map((i) => i.id)).toEqual([1]);
  });

  it('filters by status, label and text', async () => {
    await tracker.create({ title: 'Login bug', labels: ['kind/bug'] });
    await tracker.create({ title: 'Dark mode', body: 'theme toggle', labels: ['kind/feature'] });
    await tracker.create({ title: 'Old', labels: ['kind/bug'] });
    await tracker.setStatus(3, 'closed');
    expect((await tracker.list()).map((i) => i.id)).toEqual([1, 2]);
    expect((await tracker.list({ status: 'closed' })).map((i) => i.id)).toEqual([3]);
    expect((await tracker.list({ status: 'all', labels: ['kind/bug'] })).map((i) => i.id)).toEqual([
      1, 3,
    ]);
    expect((await tracker.list({ text: 'THEME' })).map((i) => i.id)).toEqual([2]);
  });

  it('appends comments and edits labels without touching the body', async () => {
    await tracker.create({ title: 'Task', body: 'Do it', labels: ['a'] });
    await tracker.comment(1, 'first');
    clock = new Date('2026-11-05T09:00:00Z');
    await tracker.comment(1, 'second');
    const updated = await tracker.label(1, { add: ['b', 'a'], remove: ['a'] });
    expect(updated.labels).toEqual(['b']);
    const issue = await tracker.get(1);
    expect(issue.body).toBe('Do it');
    expect(issue.comments).toEqual([
      { at: '2026-11-04T10:00:00.000Z', body: 'first' },
      { at: '2026-11-05T09:00:00.000Z', body: 'second' },
    ]);
    expect(await readFile(issue.path, 'utf8')).toContain('## Comments');
  });

  it('reopens closed issues', async () => {
    await tracker.create({ title: 'x' });
    await tracker.setStatus(1, 'closed');
    expect((await tracker.setStatus(1, 'open')).status).toBe('open');
  });

  it('rejects empty titles, empty comments and unknown ids', async () => {
    await expect(tracker.create({ title: '  ' })).rejects.toThrow(TrackerError);
    await tracker.create({ title: 'x' });
    await expect(tracker.comment(1, ' ')).rejects.toThrow(TrackerError);
    await expect(tracker.get(42)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('refuses ambiguous ids', async () => {
    await tracker.create({ title: 'a' });
    await writeFile(join(dir, '1-dup.md'), await readFile(join(dir, '1-a.md'), 'utf8'));
    await expect(tracker.get(1)).rejects.toThrow(/several files/);
  });
});
