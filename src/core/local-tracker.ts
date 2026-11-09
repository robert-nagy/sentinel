import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { slugify } from './branch-namer.js';
import { TrackerError } from './issue-tracker.js';

/**
 * The local markdown tracker (ADR-0005): one Markdown file per issue, with front matter,
 * under `issueProvider.localDir`, committed with the repo. It is the fallback when the agent
 * cannot reach any tracker, and the only tracker sentinel implements itself.
 *
 * ```md
 * ---
 * id: 3
 * title: "Add login page"
 * status: open
 * labels: ["kind/feature"]
 * created: 2026-11-04
 * ---
 *
 * Body.
 *
 * ## Comments
 *
 * ### 2026-11-04T12:00:00.000Z
 *
 * A comment.
 * ```
 */

export type LocalIssueStatus = 'open' | 'closed';

export interface LocalComment {
  readonly at: string;
  readonly body: string;
}

export interface LocalIssue {
  readonly id: number;
  readonly title: string;
  readonly status: LocalIssueStatus;
  readonly labels: readonly string[];
  readonly created: string;
  readonly body: string;
  readonly comments: readonly LocalComment[];
  /** Absolute path of the issue file. */
  readonly path: string;
}

export interface NewLocalIssue {
  readonly title: string;
  readonly body?: string | undefined;
  readonly labels?: readonly string[] | undefined;
}

export interface LocalIssueQuery {
  /** Default `open`. */
  readonly status?: LocalIssueStatus | 'all' | undefined;
  /** Every label listed must be present. */
  readonly labels?: readonly string[] | undefined;
  /** Case-insensitive substring of the title or body. */
  readonly text?: string | undefined;
}

const FILE_PATTERN = /^(\d{1,9})(?:-[a-z0-9-]*)?\.md$/;
const COMMENTS_HEADING = '## Comments';

/** Accepts `3`, `#3` or `" 3 "`; local ids are positive integers. */
export function parseLocalId(id: string | number): number {
  const text = String(id).trim().replace(/^#/, '');
  if (!/^\d{1,9}$/.test(text) || Number(text) === 0) {
    throw new TrackerError(`invalid local issue id "${String(id)}": use a number such as 3 or #3`);
  }
  return Number(text);
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // Hand-edited flow sequence such as [a, b]: split it ourselves.
      if (value.startsWith('[') && value.endsWith(']')) {
        return value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter((s) => s !== '');
      }
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Splits a document into front matter fields and the Markdown that follows. */
function splitFrontMatter(
  text: string,
  path: string,
): { fields: Map<string, unknown>; rest: string } {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) throw new TrackerError(`${path} has no front matter`, 'invalid');
  const fields = new Map<string, unknown>();
  for (const line of (match[1] ?? '').split('\n')) {
    const kv = /^([A-Za-z][\w-]*):(.*)$/.exec(line);
    if (kv) fields.set(kv[1] ?? '', parseScalar(kv[2] ?? ''));
  }
  return { fields, rest: normalized.slice(match[0].length) };
}

function parseComments(section: string): LocalComment[] {
  const comments: LocalComment[] = [];
  const parts = section.split(/^### (.+)$/m);
  // parts = [preamble, at1, body1, at2, body2, …]
  for (let i = 1; i < parts.length; i += 2) {
    comments.push({ at: (parts[i] ?? '').trim(), body: (parts[i + 1] ?? '').trim() });
  }
  return comments;
}

export function parseLocalIssue(text: string, path: string): LocalIssue {
  const { fields, rest } = splitFrontMatter(text, path);
  const id = Number(fields.get('id'));
  const title = fields.get('title');
  if (!Number.isInteger(id) || id <= 0 || typeof title !== 'string' || title.trim() === '') {
    throw new TrackerError(`${path} needs a numeric id and a title in its front matter`);
  }
  const status = fields.get('status') === 'closed' ? 'closed' : 'open';
  const rawLabels = fields.get('labels');
  const labels = Array.isArray(rawLabels) ? rawLabels.map(String) : [];
  const rawCreated = fields.get('created');
  const created = typeof rawCreated === 'string' ? rawCreated : '';

  const lines = rest.split('\n');
  const headingIndex = lines.findIndex((l) => l.trim() === COMMENTS_HEADING);
  const body = (headingIndex === -1 ? lines : lines.slice(0, headingIndex)).join('\n').trim();
  const comments =
    headingIndex === -1 ? [] : parseComments(lines.slice(headingIndex + 1).join('\n'));
  return { id, title: title.trim(), status, labels, created, body, comments, path };
}

export function renderLocalIssue(issue: Omit<LocalIssue, 'path'>): string {
  const lines = [
    '---',
    `id: ${String(issue.id)}`,
    `title: ${JSON.stringify(issue.title)}`,
    `status: ${issue.status}`,
    `labels: ${JSON.stringify(issue.labels)}`,
    `created: ${issue.created}`,
    '---',
    '',
  ];
  if (issue.body !== '') lines.push(issue.body, '');
  if (issue.comments.length > 0) {
    lines.push(COMMENTS_HEADING, '');
    for (const c of issue.comments) lines.push(`### ${c.at}`, '', c.body, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** Issues as Markdown files under `dir` (absolute). */
export class LocalTracker {
  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async entries(): Promise<{ id: number; file: string }[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return names
      .map((file) => ({ file, match: FILE_PATTERN.exec(file) }))
      .filter((e): e is { file: string; match: RegExpExecArray } => e.match !== null)
      .map(({ file, match }) => ({ id: Number(match[1]), file }))
      .sort((a, b) => a.id - b.id);
  }

  private async pathOf(id: string | number): Promise<string> {
    const wanted = parseLocalId(id);
    const matches = (await this.entries()).filter((e) => e.id === wanted);
    if (matches.length === 0) {
      throw new TrackerError(`no local issue #${String(wanted)} in ${this.dir}`, 'not-found');
    }
    if (matches.length > 1) {
      throw new TrackerError(
        `several files claim local issue #${String(wanted)}: ${matches.map((m) => m.file).join(', ')}`,
      );
    }
    return join(this.dir, matches[0]?.file ?? '');
  }

  async get(id: string | number): Promise<LocalIssue> {
    const path = await this.pathOf(id);
    return parseLocalIssue(await readFile(path, 'utf8'), path);
  }

  async list(query: LocalIssueQuery = {}): Promise<LocalIssue[]> {
    const status = query.status ?? 'open';
    const needle = query.text?.toLowerCase();
    const issues = await Promise.all(
      (await this.entries()).map(async ({ file }) => {
        const path = join(this.dir, file);
        return parseLocalIssue(await readFile(path, 'utf8'), path);
      }),
    );
    return issues.filter(
      (i) =>
        (status === 'all' || i.status === status) &&
        (query.labels ?? []).every((l) => i.labels.includes(l)) &&
        (needle === undefined ||
          i.title.toLowerCase().includes(needle) ||
          i.body.toLowerCase().includes(needle)),
    );
  }

  async create(input: NewLocalIssue): Promise<LocalIssue> {
    const title = input.title.trim();
    if (title === '') throw new TrackerError('an issue needs a title');
    await mkdir(this.dir, { recursive: true });
    const labels = [...new Set(input.labels ?? [])];
    // `wx` fails if the file exists, so a concurrent create retries with the next id.
    for (let attempt = 0; attempt < 5; attempt++) {
      const entries = await this.entries();
      const id = (entries.at(-1)?.id ?? 0) + 1 + attempt;
      const slug = slugify(title);
      const path = join(this.dir, slug === '' ? `${String(id)}.md` : `${String(id)}-${slug}.md`);
      const issue: Omit<LocalIssue, 'path'> = {
        id,
        title,
        status: 'open',
        labels,
        created: this.now().toISOString().slice(0, 10),
        body: (input.body ?? '').trim(),
        comments: [],
      };
      try {
        await writeFile(path, renderLocalIssue(issue), { encoding: 'utf8', flag: 'wx' });
        return { ...issue, path };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new TrackerError(`could not allocate a new issue id in ${this.dir}`);
  }

  private async update(
    id: string | number,
    change: (issue: LocalIssue) => Omit<LocalIssue, 'path'>,
  ): Promise<LocalIssue> {
    const issue = await this.get(id);
    const next = change(issue);
    await writeFile(issue.path, renderLocalIssue(next), 'utf8');
    return { ...next, path: issue.path };
  }

  async comment(id: string | number, body: string): Promise<LocalIssue> {
    const text = body.trim();
    if (text === '') throw new TrackerError('a comment needs a body');
    return this.update(id, (issue) => ({
      ...issue,
      comments: [...issue.comments, { at: this.now().toISOString(), body: text }],
    }));
  }

  label(
    id: string | number,
    change: { add?: readonly string[] | undefined; remove?: readonly string[] | undefined },
  ): Promise<LocalIssue> {
    return this.update(id, (issue) => ({
      ...issue,
      labels: [
        ...new Set(
          [...issue.labels, ...(change.add ?? [])].filter(
            (l) => !(change.remove ?? []).includes(l),
          ),
        ),
      ],
    }));
  }

  setStatus(id: string | number, status: LocalIssueStatus): Promise<LocalIssue> {
    return this.update(id, (issue) => ({ ...issue, status }));
  }
}
