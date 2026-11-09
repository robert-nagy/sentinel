import { z } from 'zod';
import { rankDuplicates } from './duplicates.js';

export const GAP_FILE_MARKER = '<!-- sentinel:mine v1 -->';
export const NEUTRAL_FEATURE_LABEL = 'kind/feature';

export class MiningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiningError';
  }
}

const finding = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  sources: z.array(z.string().trim().min(1)).default([]),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
export const findingsSchema = z.array(finding).min(1);
export type Finding = z.infer<typeof finding>;

export interface Repo {
  readonly fullName: string;
  readonly url: string;
  readonly stars: number;
  readonly description: string;
  readonly language: string;
  readonly license: string;
}

const ghRepo = z.object({
  fullName: z.string(),
  url: z.string(),
  stargazersCount: z.number(),
  description: z.string().nullish(),
  language: z.string().nullish(),
  license: z.object({ key: z.string().nullish() }).nullish(),
});

/** Parses `gh search repos --json …` output, keeping repos with at least `minStars`. */
export function parseRepoSearch(text: string, minStars: number): Repo[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MiningError('gh printed output that is not JSON');
  }
  const parsed = z.array(ghRepo).safeParse(json);
  if (!parsed.success) throw new MiningError('gh printed an unexpected search result');
  return parsed.data
    .filter((repo) => repo.stargazersCount >= minStars)
    .map((repo) => ({
      fullName: repo.fullName,
      url: repo.url,
      stars: repo.stargazersCount,
      description: repo.description ?? '',
      language: repo.language ?? '',
      license: repo.license?.key ?? '',
    }));
}

/** Drops findings whose title is a near-duplicate of an earlier one, merging their sources. */
export function mergeFindings(findings: readonly Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const item of findings) {
    const match = rankDuplicates(item.title, kept)[0];
    if (match === undefined) {
      kept.push({ ...item, sources: [...new Set(item.sources)] });
    } else {
      const index = kept.indexOf(match);
      kept[index] = { ...match, sources: [...new Set([...match.sources, ...item.sources])] };
    }
  }
  return kept;
}

/** The approval file: one checkbox per gap, to be ticked by a human. */
export function renderGapFile(findings: readonly Finding[]): string {
  const lines = [
    '# Feature gaps',
    '',
    GAP_FILE_MARKER,
    '',
    'Approve a gap by changing `[ ]` to `[x]`, then run `sentinel mine create --approved <this file>`.',
    'Delete the gaps you do not want. Nothing is filed until you approve it.',
    '',
    '## Gaps',
    '',
  ];
  for (const item of findings) {
    const priority = item.priority === undefined ? '' : ` (priority: ${item.priority})`;
    lines.push(`- [ ] **${item.title.replace(/\*\*/g, '')}**${priority}`);
    lines.push(`  - ${item.summary.replace(/\r?\n/g, ' ')}`);
    if (item.sources.length > 0) lines.push(`  - Seen in: ${item.sources.join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface Gap {
  readonly title: string;
  readonly summary: string;
  readonly sources: readonly string[];
  readonly priority: string | undefined;
  readonly approved: boolean;
  /** Id of the issue already filed for this gap, if any. */
  readonly created: string | undefined;
  /** Zero-based index of the gap's checkbox line, for rewriting. */
  readonly lineIndex: number;
}

/** Reads the approval file back. Lines it does not understand are ignored. */
export function parseGapFile(markdown: string): Gap[] {
  const lines = markdown.split(/\r?\n/);
  const gaps: Gap[] = [];
  lines.forEach((line, index) => {
    if (!line.startsWith('- [')) return;
    const checkbox = line.slice(3, 4);
    if ((checkbox !== ' ' && checkbox.toLowerCase() !== 'x') || line.slice(4, 6) !== '] ') return;
    const rest = line.slice(6).trim();
    if (!rest.startsWith('**')) return;
    const close = rest.indexOf('**', 2);
    if (close === -1) return;
    const title = rest.slice(2, close).trim();
    const priority = /\(priority: (high|medium|low)\)/.exec(rest.slice(close))?.[1];
    let summary = '';
    let sources: string[] = [];
    let created: string | undefined;
    for (let next = index + 1; next < lines.length; next += 1) {
      const detail = lines[next] ?? '';
      if (!detail.startsWith('  - ')) break;
      const text = detail.slice(4).trim();
      if (text.startsWith('Seen in:')) {
        sources = text
          .slice('Seen in:'.length)
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
      } else if (text.startsWith('Created:')) {
        created = text.slice('Created:'.length).trim();
      } else if (summary === '') {
        summary = text;
      }
    }
    if (title !== '') {
      gaps.push({
        title,
        summary,
        sources,
        priority,
        approved: checkbox !== ' ',
        created,
        lineIndex: index,
      });
    }
  });
  return gaps;
}

/** Adds a `Created:` line under the gap at `lineIndex` (after its detail lines). */
export function markCreated(markdown: string, lineIndex: number, id: string): string {
  const lines = markdown.split('\n');
  let at = lineIndex + 1;
  while ((lines[at] ?? '').startsWith('  - ')) at += 1;
  lines.splice(at, 0, `  - Created: ${id}`);
  return lines.join('\n');
}

export interface IssueDraft {
  readonly title: string;
  readonly body: string;
  /** Neutral labels; map them with the tracker's `labelMap`. */
  readonly labels: readonly string[];
}

export function issueDraftFor(gap: Gap): IssueDraft {
  const body = [
    gap.summary,
    gap.sources.length > 0 ? `Seen in: ${gap.sources.join(', ')}` : '',
    '_Found by `sentinel mine` and approved by a human._',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  return { title: gap.title, body, labels: [NEUTRAL_FEATURE_LABEL] };
}
