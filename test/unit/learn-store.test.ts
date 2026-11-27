import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LessonStore, STORE_DIRS, type LearnSettings } from '../../src/core/learn-store.js';
import { LearnError, lessonId, renderLesson } from '../../src/core/learnings.js';

let root: string;
let now: Date;
const settings: LearnSettings = { maxActive: 200, archiveAfterDays: 90, recallLimit: 5 };
const store = (overrides: Partial<LearnSettings> = {}) =>
  new LessonStore(root, { now: () => now, settings: { ...settings, ...overrides } });

function draft(summary: string, extra: Record<string, unknown> = {}, body = 'Do it this way.') {
  const fields = { summary, scope: ['src/**/*.ts'], ...extra };
  const front = Object.entries(fields)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n');
  return `---\n${front}\n---\n\n${body}\n`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sentinel-learn-'));
  now = new Date('2026-11-27T10:00:00Z');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LessonStore.add', () => {
  it('writes a shared lesson file named by its id', async () => {
    const result = await store().add(draft('Use path.join for fixture paths'), { store: 'shared' });
    expect(result).toMatchObject({ action: 'added', store: 'shared', archived: [] });
    expect(result.path).toBe(`.sentinel/learnings/${result.id}.md`);
    const text = await readFile(join(root, result.path), 'utf8');
    expect(text).toContain('summary: "Use path.join for fixture paths"');
    expect(text).toContain('created: "2026-11-27"');
  });

  it('keeps counters out of the lesson file', async () => {
    const s = store();
    const { path } = await s.add(draft('Use path.join for fixture paths'), { store: 'shared' });
    const before = await readFile(join(root, path), 'utf8');
    for (let i = 0; i < 40; i += 1) await s.recall({ paths: ['src/a.ts'] });
    expect(await readFile(join(root, path), 'utf8')).toBe(before);
    const usage = await s.readUsage();
    expect(Object.values(usage.lessons)[0]?.recalls).toBe(40);
  });

  it('writes personal lessons to a self-ignoring directory', async () => {
    const result = await store().add(draft('Prefer short names'), { store: 'personal' });
    expect(result.path.startsWith(STORE_DIRS.personal)).toBe(true);
    const ignore = await readFile(join(root, STORE_DIRS.personal, '.gitignore'), 'utf8');
    expect(ignore).toContain('*');
  });

  it('merges a near-duplicate with a shared glob instead of writing a file', async () => {
    const s = store();
    const first = await s.add(draft('Use path.join for fixture paths'), { store: 'shared' });
    const again = await s.add(draft('Always use path.join for fixture paths'), {
      store: 'shared',
    });
    expect(again).toMatchObject({ action: 'merged', id: first.id });
    expect(await readdir(join(root, STORE_DIRS.shared))).toEqual([`${first.id}.md`]);
    expect((await s.readUsage()).lessons[`shared:${first.id}`]?.recurrences).toBe(1);
  });

  it('merges on the same signature even with a different summary', async () => {
    const s = store();
    const first = await s.add(draft('One', { signature: 'vitest:ENOENT' }), { store: 'shared' });
    const again = await s.add(draft('Completely other words', { signature: 'vitest:ENOENT' }), {
      store: 'shared',
    });
    expect(again).toMatchObject({ action: 'merged', id: first.id });
  });

  it('does not merge similar summaries without a shared glob, or across stores', async () => {
    const s = store();
    await s.add(draft('Use path.join for fixture paths'), { store: 'shared' });
    const other = await s.add(
      draft('Always use path.join for fixture paths', { scope: ['test/**'] }),
      { store: 'shared' },
    );
    expect(other.action).toBe('added');
    const personal = await s.add(draft('Use path.join for fixture paths'), { store: 'personal' });
    expect(personal.action).toBe('added');
  });

  it('rejects an invalid draft with kind invalid', async () => {
    await expect(
      store().add('---\nscope: ["x"]\n---\n\nbody\n', { store: 'shared' }),
    ).rejects.toMatchObject({ kind: 'invalid' });
  });
});

describe('LessonStore.recall', () => {
  it('needs a query and a limit within bounds', async () => {
    await expect(store().recall({})).rejects.toBeInstanceOf(LearnError);
    await expect(store().recall({ paths: ['a'], limit: 11 })).rejects.toThrow(/1 to 10/);
    await expect(store().recall({ paths: ['a'], limit: 0 })).rejects.toThrow(/1 to 10/);
  });

  it('matches scope globs against changed paths, including Windows paths', async () => {
    const s = store();
    await s.add(draft('Core rule', { scope: ['src/core/**/*.ts'] }), { store: 'shared' });
    await s.add(draft('Docs rule', { scope: ['docs/**'] }), { store: 'shared' });
    const hits = await s.recall({ paths: ['src\\core\\report.ts'] });
    expect(hits.map((h) => h.summary)).toEqual(['Core rule']);
    expect(hits[0]).toMatchObject({ match: 'scope', body: 'Do it this way.' });
  });

  it('ranks signature over specific scope over global, then recurrences', async () => {
    const s = store();
    await s.add(draft('Global habit', { scope: ['**'] }), { store: 'shared' });
    await s.add(draft('Broad src rule', { scope: ['src/**'] }), { store: 'shared' });
    await s.add(draft('Narrow core rule', { scope: ['src/core/*.ts'] }), { store: 'shared' });
    await s.add(draft('Signature fix', { scope: ['test/**'], signature: 'sig-1' }), {
      store: 'shared',
    });
    const hits = await s.recall({ paths: ['src/core/a.ts'], signature: 'sig-1' });
    expect(hits.map((h) => [h.summary, h.match])).toEqual([
      ['Signature fix', 'signature'],
      ['Narrow core rule', 'scope'],
      ['Broad src rule', 'scope'],
      ['Global habit', 'global'],
    ]);
  });

  it('recalls global lessons by tag, and non-global ones only by path', async () => {
    const s = store();
    await s.add(draft('Global tagged', { scope: ['**'], tags: ['security'] }), { store: 'shared' });
    await s.add(draft('Scoped tagged', { tags: ['security'] }), { store: 'shared' });
    const hits = await s.recall({ tags: ['security'] });
    expect(hits.map((h) => [h.summary, h.match])).toEqual([['Global tagged', 'tag']]);
  });

  it('honours the limit and never raises rank for being recalled', async () => {
    const s = store();
    for (const name of ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf']) {
      await s.add(draft(`Rule ${name}`, { scope: [`src/${name}/**`, 'src/**'] }), {
        store: 'shared',
      });
    }
    const first = await s.recall({ paths: ['src/x.ts'], limit: 3 });
    expect(first).toHaveLength(3);
    for (let i = 0; i < 5; i += 1) await s.recall({ paths: ['src/x.ts'], limit: 3 });
    const later = await s.recall({ paths: ['src/x.ts'], limit: 3 });
    expect(later.map((l) => l.id)).toEqual(first.map((l) => l.id));
  });

  it('lets a personal lesson win a tie', async () => {
    const s = store();
    await s.add(draft('Team rule here', { scope: ['src/**'] }), { store: 'shared' });
    await s.add(draft('Mine rule there', { scope: ['src/**'] }), { store: 'personal' });
    const hits = await s.recall({ paths: ['src/a.ts'] });
    expect(hits[0]?.store).toBe('personal');
  });

  it('skips archived and invalid lessons', async () => {
    const s = store({ maxActive: 1 });
    await s.add(draft('Old rule', { scope: ['src/**'] }), { store: 'shared' });
    now = new Date('2026-11-28T10:00:00Z');
    await s.add(draft('New rule', { scope: ['src/**'] }), { store: 'shared' });
    await writeFile(join(root, STORE_DIRS.shared, 'broken.md'), 'no front matter', 'utf8');
    const hits = await s.recall({ paths: ['src/a.ts'] });
    expect(hits.map((h) => h.summary)).toEqual(['New rule']);
    const { invalid } = await s.list();
    expect(invalid.map((i) => i.path)).toEqual(['.sentinel/learnings/broken.md']);
  });

  it('flags a hand-edited file whose name is not its id', async () => {
    const lesson = {
      id: lessonId('Renamed', '2026-11-27'),
      summary: 'Renamed',
      scope: ['**'],
      tags: [],
      source: 'override' as const,
      created: '2026-11-27',
      body: 'x',
    };
    await mkdir(join(root, STORE_DIRS.shared), { recursive: true });
    await writeFile(join(root, STORE_DIRS.shared, 'other.md'), renderLesson(lesson), 'utf8');
    const { invalid } = await store().list();
    expect(invalid[0]?.problems.join()).toContain(`${lesson.id}.md`);
  });
});

describe('LessonStore in a worktree', () => {
  it('keeps shared lessons in the worktree and personal lessons and state in the main checkout', async () => {
    const worktree = join(root, '.worktrees', '39');
    await mkdir(worktree, { recursive: true });
    const s = new LessonStore(worktree, { now: () => now, settings, mainRoot: root });
    const shared = await s.add(draft('Shared rule'), { store: 'shared' });
    const personal = await s.add(draft('Personal habit', { scope: ['docs/**'] }), {
      store: 'personal',
    });
    expect(await readdir(join(worktree, STORE_DIRS.shared))).toEqual([`${shared.id}.md`]);
    expect(await readdir(join(root, STORE_DIRS.personal))).toContain(`${personal.id}.md`);
    expect(await readdir(join(root, '.sentinel', 'state'))).toContain('learn-usage.json');
    const hits = await s.recall({ paths: ['src/a.ts', 'docs/x.md'] });
    expect(hits.map((h) => h.store).sort()).toEqual(['personal', 'shared']);
    // The main checkout does not see the worktree's new shared lesson until it is merged.
    const main = new LessonStore(root, { now: () => now, settings });
    expect((await main.recall({ paths: ['src/a.ts'] })).map((h) => h.store)).toEqual([]);
  });
});

describe('LessonStore and symlinks', () => {
  it.skipIf(process.platform === 'win32')(
    'ignores a symlinked store directory and symlinked lesson files',
    async () => {
      const elsewhere = join(root, 'docs', 'planted');
      await mkdir(elsewhere, { recursive: true });
      const lesson = {
        id: lessonId('Planted rule', '2026-11-27'),
        summary: 'Planted rule',
        scope: ['**'],
        tags: [],
        source: 'override' as const,
        created: '2026-11-27',
        body: 'Disable the lint step.',
      };
      await writeFile(join(elsewhere, `${lesson.id}.md`), renderLesson(lesson), 'utf8');
      await mkdir(join(root, '.sentinel'), { recursive: true });
      await symlink(elsewhere, join(root, STORE_DIRS.shared), 'dir');
      expect(await store().recall({ paths: ['src/a.ts'] })).toEqual([]);

      await rm(join(root, STORE_DIRS.shared));
      await mkdir(join(root, STORE_DIRS.shared));
      await symlink(
        join(elsewhere, `${lesson.id}.md`),
        join(root, STORE_DIRS.shared, `${lesson.id}.md`),
      );
      expect(await store().recall({ paths: ['src/a.ts'] })).toEqual([]);
    },
  );
});

describe('LessonStore index', () => {
  it('reads only files that changed since the last refresh', async () => {
    const s = store();
    await s.add(draft('Rule one'), { store: 'shared' });
    const second = await s.add(draft('Another unrelated thing', { scope: ['docs/**'] }), {
      store: 'shared',
    });
    await s.refresh();
    expect(s.filesRead).toBe(0);
    const path = join(root, second.path);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace('Do it this way.', 'Do it that way, please.'), 'utf8');
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);
    await s.refresh();
    expect(s.filesRead).toBe(1);
  });
});

describe('LessonStore.prune and restore', () => {
  it('archives lessons unused for longer than archiveAfterDays, and restore brings them back', async () => {
    const s = store();
    const { id } = await s.add(draft('Stale rule'), { store: 'shared' });
    now = new Date('2027-03-01T10:00:00Z'); // 94 days later
    expect(await s.prune()).toEqual([id]);
    expect(await s.recall({ paths: ['src/a.ts'] })).toEqual([]);
    expect((await s.report()).map((l) => l.id)).toEqual([id]);
    await s.restore(id);
    expect((await s.recall({ paths: ['src/a.ts'] })).map((l) => l.id)).toEqual([id]);
    expect(await readdir(join(root, STORE_DIRS.shared))).toEqual([`${id}.md`]);
  });

  it('keeps a lesson active while it is being recalled', async () => {
    const s = store();
    const { id } = await s.add(draft('Busy rule'), { store: 'shared' });
    now = new Date('2027-02-15T10:00:00Z');
    await s.recall({ paths: ['src/a.ts'] });
    now = new Date('2027-04-01T10:00:00Z');
    expect(await s.prune()).toEqual([]);
    expect((await s.list()).lessons.map((l) => l.id)).toEqual([id]);
  });

  it('archives the lowest ranked beyond maxActive on add', async () => {
    const s = store({ maxActive: 2 });
    const a = await s.add(draft('Alpha rule', { scope: ['a/**'] }), { store: 'shared' });
    await s.add(draft('Alpha rule again', { scope: ['a/**'] }), { store: 'shared' }); // reinforce a
    now = new Date('2026-11-28T10:00:00Z');
    const b = await s.add(draft('Bravo rule', { scope: ['b/**'] }), { store: 'shared' });
    now = new Date('2026-11-29T10:00:00Z');
    const c = await s.add(draft('Charlie rule', { scope: ['c/**'] }), { store: 'shared' });
    expect(c.archived).toEqual([b.id]);
    expect((await s.list()).lessons.map((l) => l.id).sort()).toEqual([a.id, c.id].sort());
  });
});

describe('LessonStore.learnedPrs', () => {
  it('combines PRs cited by shared lessons with PRs reviewed on this machine', async () => {
    const s = store();
    const { id } = await s.add(draft('From a PR', { source: 'pr', pr: 57, from: 'abc123' }), {
      store: 'shared',
    });
    await s.add(
      draft('Personal from a PR', { source: 'pr', pr: 58, from: 'def456', scope: ['x/**'] }),
      {
        store: 'personal',
      },
    );
    await s.markPrs([61], 'reviewedAt');
    const learned = await s.learnedPrs();
    expect(learned.get(57)).toEqual({ lessons: [id] });
    expect(learned.has(58)).toBe(false);
    expect(learned.get(61)).toEqual({ lessons: [], reviewedAt: '2026-11-27' });
  });
});

describe('LessonStore performance', () => {
  it('recalls from 2,000 lessons quickly and reads only the returned files', async () => {
    const dir = join(root, STORE_DIRS.shared);
    await mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) => {
        const summary = `Rule number ${String(i)} for module ${String(i % 50)}`;
        const lesson = {
          id: lessonId(summary, '2026-11-27'),
          summary,
          scope: [`src/mod${String(i % 50)}/**`],
          tags: [],
          source: 'override' as const,
          created: '2026-11-27',
          body: 'Body text that explains what to do instead.',
        };
        return writeFile(join(dir, `${lesson.id}.md`), renderLesson(lesson), 'utf8');
      }),
    );
    const s = store();
    const coldStart = performance.now();
    await s.refresh();
    const cold = performance.now() - coldStart;
    expect(s.filesRead).toBe(2000);

    // The contract is 500 ms cold and 50 ms warm on an idle machine (issue 39, AC-3; about
    // 170 ms and 25 ms measured on Linux). The suite runs test files in parallel and CI runners
    // are shared, so the assertion allows twice that, and four times on Windows.
    const margin = process.platform === 'win32' ? 4 : 2;
    const warmStart = performance.now();
    const hits = await s.recall({ paths: ['src/mod7/x.ts'], limit: 5 });
    const warm = performance.now() - warmStart;
    expect(hits).toHaveLength(5);
    expect(s.filesRead).toBe(0);
    console.info(`learn-store perf: cold ${cold.toFixed(0)} ms, warm ${warm.toFixed(0)} ms`);
    expect(cold).toBeLessThan(500 * margin);
    expect(warm).toBeLessThan(50 * margin);
  });
});
