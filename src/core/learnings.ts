import { createHash } from 'node:crypto';
import { parseFrontMatter, renderFrontMatter } from './front-matter.js';
import { isGlobalGlob, normalizePath, validateGlob } from './globs.js';
import { findSecrets } from './issue-format.js';

/**
 * Lessons learned from interventions (ADR-0008): one small Markdown file each, written by the
 * host agent and checked here. sentinel never writes lesson text itself.
 */

export const LESSON_SOURCES = ['override', 'ci-signature', 'pr'] as const;
export type LessonSource = (typeof LESSON_SOURCES)[number];

export const LIMITS = {
  summary: 120,
  body: 800,
  scopeGlobs: 8,
  tags: 8,
  tagLength: 32,
  signature: 200,
  from: 100,
} as const;

export const LESSON_ID_PATTERN = /^L-\d{8}-[0-9a-f]{6}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const MANAGED_MARKER = /sentinel:managed/i;

export type LearnErrorKind = 'invalid' | 'forbidden' | 'failed';

export class LearnError extends Error {
  constructor(
    message: string,
    readonly kind: LearnErrorKind = 'failed',
  ) {
    super(message);
    this.name = 'LearnError';
  }
}

export interface Lesson {
  readonly id: string;
  readonly summary: string;
  readonly scope: readonly string[];
  readonly tags: readonly string[];
  readonly signature?: string | undefined;
  readonly source: LessonSource;
  /** The pull request a `pr` lesson came from. */
  readonly pr?: number | undefined;
  /** The commit SHA or comment id a `pr` lesson came from. */
  readonly from?: string | undefined;
  /** `yyyy-mm-dd`. */
  readonly created: string;
  readonly body: string;
}

export interface LessonParse {
  readonly lesson?: Lesson | undefined;
  readonly problems: readonly string[];
}

function normalizeSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** `L-<yyyymmdd>-<6 hex>`: the same summary on the same day always gets the same id. */
export function lessonId(summary: string, created: string): string {
  const hash = createHash('sha256').update(normalizeSummary(summary)).digest('hex').slice(0, 6);
  return `L-${created.replace(/-/g, '')}-${hash}`;
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => String(v).trim()).filter((v) => v !== '');
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

interface Fields {
  readonly fields: Map<string, unknown>;
  readonly body: string;
}

function check(
  { fields, body }: Fields,
  id: string | undefined,
  created: string,
): { lesson?: Lesson; problems: string[] } {
  const problems: string[] = [];
  const summary = optionalString(fields.get('summary'));
  if (summary === undefined) problems.push('summary is required');
  else if (summary.includes('\n')) problems.push('summary must be one line');
  else if (summary.length > LIMITS.summary)
    problems.push(`summary is longer than ${String(LIMITS.summary)} characters`);

  if (body === '') problems.push('the body (what went wrong and what to do instead) is empty');
  else if (body.length > LIMITS.body)
    problems.push(`the body is longer than ${String(LIMITS.body)} characters`);

  const rawScope = stringList(fields.get('scope'));
  const scope =
    rawScope === undefined
      ? undefined
      : rawScope.length === 0
        ? ['**']
        : rawScope.map(normalizePath);
  if (scope === undefined) problems.push('scope must be a list of globs');
  else {
    if (scope.length > LIMITS.scopeGlobs)
      problems.push(`scope has more than ${String(LIMITS.scopeGlobs)} globs`);
    for (const glob of scope) {
      const problem = validateGlob(glob);
      if (problem !== undefined) problems.push(problem);
    }
    if (scope.length > 1 && scope.some(isGlobalGlob))
      problems.push('scope "**" (global) cannot be combined with other globs');
  }

  const tags = stringList(fields.get('tags'));
  if (tags === undefined) problems.push('tags must be a list');
  else {
    if (tags.length > LIMITS.tags) problems.push(`more than ${String(LIMITS.tags)} tags`);
    for (const tag of tags) {
      if (!TAG_PATTERN.test(tag) || tag.length > LIMITS.tagLength)
        problems.push(`tag "${tag.slice(0, 40)}" must be lower-case letters, digits, . _ / -`);
    }
  }

  const signature = optionalString(fields.get('signature'));
  if (signature !== undefined && signature.length > LIMITS.signature)
    problems.push(`signature is longer than ${String(LIMITS.signature)} characters`);

  const source = optionalString(fields.get('source')) ?? 'override';
  if (!(LESSON_SOURCES as readonly string[]).includes(source))
    problems.push(`source must be one of ${LESSON_SOURCES.join(', ')}`);

  const rawPr = optionalString(fields.get('pr'));
  const pr = rawPr === undefined ? undefined : Number(rawPr.replace(/^#/, ''));
  const from = optionalString(fields.get('from'));
  if (source === 'pr') {
    if (pr === undefined || !Number.isInteger(pr) || pr <= 0)
      problems.push('a lesson with source "pr" needs pr: the pull request number');
    if (from === undefined)
      problems.push('a lesson with source "pr" needs from: the commit SHA or comment id');
  }
  if (from !== undefined && !/^[\w.:/-]{1,100}$/.test(from))
    problems.push('from must be a commit SHA or comment id');

  const text = [summary ?? '', body, signature ?? '', ...(tags ?? [])].join('\n');
  if (MANAGED_MARKER.test(text))
    problems.push('lessons must not contain a sentinel:managed marker');
  const secrets = findSecrets(text);
  if (secrets.length > 0)
    problems.push(
      `the lesson looks like it contains a secret (${[...new Set(secrets.map((s) => s.pattern))].join(', ')}); remove it`,
    );

  if (!/^\d{4}-\d{2}-\d{2}$/.test(created)) problems.push('created must be a yyyy-mm-dd date');
  if (problems.length > 0 || summary === undefined || scope === undefined || tags === undefined)
    return { problems };

  const lesson: Lesson = {
    id: id ?? lessonId(summary, created),
    summary,
    scope,
    tags,
    signature,
    source: source as LessonSource,
    pr: source === 'pr' ? pr : undefined,
    from: source === 'pr' ? from : undefined,
    created,
    body,
  };
  return { lesson, problems };
}

function split(text: string): Fields | undefined {
  const parsed = parseFrontMatter(text);
  if (parsed === undefined) return undefined;
  return { fields: parsed.fields, body: parsed.rest.trim() };
}

/**
 * A lesson as the agent writes it: `summary`, `scope`, `tags`, optional `signature`, `source`
 * (`pr` with `pr` and `from`) and a body. `id` and `created` are set here, never by the agent.
 */
export function parseLessonDraft(text: string, options: { created: string }): LessonParse {
  const parts = split(text);
  if (parts === undefined) return { problems: ['the lesson needs front matter between --- lines'] };
  return check(parts, undefined, options.created);
}

/** A stored lesson file: the draft fields plus `id` and `created`. */
export function parseLesson(text: string): LessonParse {
  const parts = split(text);
  if (parts === undefined) return { problems: ['the lesson needs front matter between --- lines'] };
  const id = optionalString(parts.fields.get('id'));
  const created = optionalString(parts.fields.get('created')) ?? '';
  const result = check(parts, id, created);
  if (id === undefined || !LESSON_ID_PATTERN.test(id))
    return { problems: [...result.problems, 'id must look like L-yyyymmdd-abcdef'] };
  return result;
}

export function renderLesson(lesson: Lesson): string {
  return `${renderFrontMatter([
    ['id', lesson.id],
    ['summary', lesson.summary],
    ['scope', lesson.scope],
    ['tags', lesson.tags],
    ['signature', lesson.signature],
    ['source', lesson.source],
    ['pr', lesson.pr],
    ['from', lesson.from],
    ['created', lesson.created],
  ])}\n${lesson.body}\n`;
}
