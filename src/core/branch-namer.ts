import type { SentinelConfig } from './config-schema.js';

export const BRANCH_TYPES = ['feature', 'bugfix', 'hotfix', 'refactor'] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

/** Placeholders a branch template may use. `{issue_id}` is mandatory. */
export const PLACEHOLDERS = ['issue_id', 'slug', 'type', 'user', 'date'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

export class BranchNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BranchNameError';
  }
}

const PLACEHOLDER_PATTERN = /\{([^{}]*)\}/g;
const MAX_BRANCH_LENGTH = 200;
const MAX_SLUG_LENGTH = 40;
const SAMPLE_VALUES: Record<Placeholder, string> = {
  issue_id: '123',
  slug: 'sample-title',
  type: 'feature',
  user: 'user',
  date: '20260101',
};

/** Letters NFKD does not decompose into base letter + accent. */
const TRANSLITERATIONS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/**
 * Turns free text into a lowercase ASCII slug: accents are folded (`Café` → `cafe`),
 * everything else becomes a single `-`, and the result is cut to `maxLength` at a word
 * boundary where that keeps at least half of the budget. Text with no Latin letters or
 * digits (for example CJK) yields an empty slug.
 */
export function slugify(input: string, maxLength = MAX_SLUG_LENGTH): string {
  const folded = input
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßøłđðæœþ]/g, (letter) => TRANSLITERATIONS[letter] ?? letter);
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug;

  const cut = slug.slice(0, maxLength);
  if (slug[maxLength] === '-') return cut;
  const boundary = cut.lastIndexOf('-');
  return (boundary >= maxLength / 2 ? cut.slice(0, boundary) : cut).replace(/-+$/, '');
}

/**
 * Checks a branch name against git's ref-name rules (`git check-ref-format --branch`),
 * plus a leading `-` (which git would parse as an option) and a length cap.
 */
export function isValidBranchName(name: string): boolean {
  if (name === '' || name === '@' || name.length > MAX_BRANCH_LENGTH) return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(char)) return false;
  }
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.startsWith('-')) {
    return false;
  }
  return name.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'));
}

/** Names of the `{placeholders}` in a template, in order (may include unknown ones). */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

/**
 * Validates a branch template. Returns a problem description, or `undefined` when the
 * template is fine: only known placeholders, `{issue_id}` present, balanced braces, and
 * it renders to a valid git branch name.
 */
export function validateBranchTemplate(template: string): string | undefined {
  if (template.trim() === '') return 'the branch template must not be empty';

  const names = templatePlaceholders(template);
  const unknown = names.find((name) => !(PLACEHOLDERS as readonly string[]).includes(name));
  if (unknown !== undefined) {
    return `unknown placeholder {${unknown}}; allowed: ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`;
  }
  const leftover = template.replace(PLACEHOLDER_PATTERN, '');
  if (leftover.includes('{') || leftover.includes('}')) {
    return 'unbalanced braces in the branch template';
  }
  if (!names.includes('issue_id')) {
    return 'the branch template must contain {issue_id} so branches can be traced to their issue';
  }
  if (!isValidBranchName(renderTemplate(template, SAMPLE_VALUES))) {
    return `"${template}" does not produce a valid git branch name`;
  }
  return undefined;
}

/** Substitutes placeholders, then tidies separators left behind by empty values. */
function renderTemplate(template: string, values: Readonly<Record<Placeholder, string>>): string {
  const filled = template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
    return values[name as Placeholder];
  });
  return filled
    .split('/')
    .map((part) => part.replace(/-{2,}/g, '-').replace(/^[-_.]+|[-_.]+$/g, ''))
    .filter((part) => part !== '')
    .join('/');
}

/** Issue ids may be numeric (`42`, `#42`), Jira keys (`PROJ-123`) or any similar token. */
function normalizeIssueId(id: string | number): string {
  const normalized = String(id).trim().replace(/^#/, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
    throw new BranchNameError(
      `invalid issue id "${String(id)}": use letters, digits, ".", "_" or "-" (for example 42 or PROJ-123)`,
    );
  }
  return normalized;
}

export interface BranchIssue {
  readonly id: string | number;
  readonly title?: string | undefined;
  /** Tracker labels, for example `kind/bug`. */
  readonly labels?: readonly string[] | undefined;
  /** The tracker's own issue type, for example Jira `Bug` or Azure DevOps `User Story`. */
  readonly issueType?: string | undefined;
}

const TYPE_HINTS: readonly (readonly [BranchType, readonly string[]])[] = [
  ['hotfix', ['hotfix', 'incident']],
  ['bugfix', ['bug', 'bugfix', 'defect', 'fix']],
  ['refactor', ['refactor', 'refactoring', 'tech-debt', 'techdebt', 'cleanup']],
  ['feature', ['feature', 'enhancement', 'story', 'user story', 'new feature']],
];

/**
 * Guesses the branch type from tracker labels and the tracker's issue type
 * (`kind/bug`, `Bug`, `hotfix` …). Hotfix beats bugfix beats refactor beats feature;
 * with no hint the answer is `feature`.
 */
export function inferBranchType(issue: Pick<BranchIssue, 'labels' | 'issueType'>): BranchType {
  const tokens = new Set<string>();
  for (const raw of [...(issue.labels ?? []), issue.issueType ?? '']) {
    const lowered = raw.trim().toLowerCase();
    if (lowered === '') continue;
    tokens.add(lowered);
    const afterSlash = lowered.split('/').pop();
    if (afterSlash) tokens.add(afterSlash);
  }
  for (const [type, hints] of TYPE_HINTS) {
    if (hints.some((hint) => tokens.has(hint))) return type;
  }
  return 'feature';
}

export interface ResolveBranchInput {
  readonly issue: BranchIssue;
  /** Branch type; inferred from the issue when omitted. */
  readonly type?: BranchType | undefined;
}

export interface ResolveBranchContext {
  /** Used for `{date}` (UTC, `YYYYMMDD`). Defaults to now. */
  readonly now?: Date | undefined;
  /** Used for `{user}`; slugified. Required only if the template uses `{user}`. */
  readonly user?: string | undefined;
}

export interface ResolvedBranch {
  readonly name: string;
  readonly type: BranchType;
  readonly template: string;
}

/** Resolves the branch name for an issue from the configured templates. */
export function resolveBranchName(
  input: ResolveBranchInput,
  config: Pick<SentinelConfig, 'branches'>,
  context: ResolveBranchContext = {},
): ResolvedBranch {
  const type = input.type ?? inferBranchType(input.issue);
  const template = config.branches[type];

  const problem = validateBranchTemplate(template);
  if (problem !== undefined) {
    throw new BranchNameError(`invalid branch template for ${type}: ${problem}`);
  }

  const user = slugify(context.user ?? '', 20);
  if (templatePlaceholders(template).includes('user') && user === '') {
    throw new BranchNameError(
      `the ${type} branch template uses {user}, but no user name is available (set git config user.name)`,
    );
  }

  const date = (context.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const name = renderTemplate(template, {
    issue_id: normalizeIssueId(input.issue.id),
    slug: slugify(input.issue.title ?? ''),
    type,
    user,
    date,
  });

  if (!isValidBranchName(name)) {
    throw new BranchNameError(`"${name}" is not a valid git branch name (template: ${template})`);
  }
  return { name, type, template };
}
