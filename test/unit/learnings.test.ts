import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  lessonId,
  parseLesson,
  parseLessonDraft,
  renderLesson,
} from '../../src/core/learnings.js';

const draft = (front: string, body = 'Use path.join; the Windows leg fails on "/".') =>
  `---\n${front}\n---\n\n${body}\n`;

const good = draft(
  [
    'summary: "Use path.join for fixture paths"',
    'scope: ["test/**/*.ts"]',
    'tags: ["tests", "windows"]',
    'source: "override"',
  ].join('\n'),
);

describe('lessonId', () => {
  it('is the date plus a hash of the normalised summary', () => {
    const id = lessonId('Use path.join for fixture paths', '2026-11-27');
    expect(id).toMatch(/^L-20261127-[0-9a-f]{6}$/);
    expect(lessonId('  use PATH.join for   fixture paths ', '2026-11-27')).toBe(id);
    expect(lessonId('Something else', '2026-11-27')).not.toBe(id);
  });
});

describe('parseLessonDraft', () => {
  it('accepts a valid draft and fills id and created', () => {
    const result = parseLessonDraft(good, { created: '2026-11-27' });
    expect(result.problems).toEqual([]);
    expect(result.lesson).toMatchObject({
      summary: 'Use path.join for fixture paths',
      scope: ['test/**/*.ts'],
      tags: ['tests', 'windows'],
      source: 'override',
      created: '2026-11-27',
      id: lessonId('Use path.join for fixture paths', '2026-11-27'),
    });
  });

  it('defaults source to override, tags to none and scope to global', () => {
    const result = parseLessonDraft(draft('summary: "A rule"'), { created: '2026-11-27' });
    expect(result.problems).toEqual([]);
    expect(result.lesson).toMatchObject({ source: 'override', tags: [], scope: ['**'] });
  });

  it.each([
    ['no front matter', 'just text', 'front matter'],
    ['no summary', draft('scope: ["a/*"]'), 'summary'],
    ['long summary', draft(`summary: "${'x'.repeat(LIMITS.summary + 1)}"`), 'summary'],
    ['empty body', draft('summary: "A"', ''), 'body'],
    ['long body', draft('summary: "A"', 'y'.repeat(LIMITS.body + 1)), 'body'],
    ['bad glob', draft('summary: "A"\nscope: ["../x"]'), '..'],
    [
      'too many globs',
      draft(
        `summary: "A"\nscope: ${JSON.stringify(Array.from({ length: 9 }, (_, i) => `a${String(i)}/*`))}`,
      ),
      'scope',
    ],
    ['bad tag', draft('summary: "A"\ntags: ["Has Space"]'), 'tag'],
    ['bad source', draft('summary: "A"\nsource: "review"'), 'source'],
    ['pr without from', draft('summary: "A"\nsource: "pr"\npr: 12'), 'from'],
    ['managed marker', draft('summary: "A"', 'x <!-- sentinel:managed --> y'), 'sentinel:managed'],
    ['secret', draft('summary: "A"', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'secret'],
    ['long signature', draft(`summary: "A"\nsignature: "${'s'.repeat(201)}"`), 'signature'],
  ])('rejects %s', (_name, text, word) => {
    const result = parseLessonDraft(text, { created: '2026-11-27' });
    expect(result.lesson).toBeUndefined();
    expect(result.problems.join('\n')).toContain(word);
  });

  it('never repeats a found secret in the problem text', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const result = parseLessonDraft(draft('summary: "A"', `x ${secret}`), {
      created: '2026-11-27',
    });
    expect(result.problems.join('\n')).not.toContain(secret);
  });

  it('accepts a pr lesson with pr and from', () => {
    const result = parseLessonDraft(
      draft('summary: "A"\nsource: "pr"\npr: "57"\nfrom: "abc1234"'),
      { created: '2026-11-27' },
    );
    expect(result.problems).toEqual([]);
    expect(result.lesson).toMatchObject({ source: 'pr', pr: 57, from: 'abc1234' });
  });
});

describe('renderLesson / parseLesson', () => {
  it('round-trips', () => {
    const { lesson } = parseLessonDraft(good, { created: '2026-11-27' });
    if (lesson === undefined) throw new Error('expected a lesson');
    const text = renderLesson(lesson);
    expect(text.startsWith('---\nid: "L-20261127-')).toBe(true);
    expect(parseLesson(text)).toEqual({ lesson, problems: [] });
  });

  it('requires source in a stored lesson, though a draft may leave it out', () => {
    const stored = renderLesson(
      parseLessonDraft(good, { created: '2026-11-27' }).lesson ?? (undefined as never),
    );
    expect(parseLesson(stored.replace(/^source:.*\n/m, '')).problems.join()).toContain(
      'source is required',
    );
  });

  it('flags a stored lesson whose id is missing', () => {
    expect(parseLesson(good).problems.join('\n')).toContain('id');
  });
});
