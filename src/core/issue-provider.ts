export type IssueState = 'open' | 'closed';

export interface Issue {
  /** Tracker-specific identifier as users write it (`42`, `PROJ-123`). */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly state: IssueState;
  readonly labels: readonly string[];
  readonly url: string;
  /** The tracker's own issue type (Jira `Bug`, …) when it has one. */
  readonly issueType?: string | undefined;
  readonly assignees: readonly string[];
}

export interface IssueQuery {
  readonly state?: IssueState | 'all' | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly search?: string | undefined;
  readonly limit?: number | undefined;
}

export interface NewIssue {
  readonly title: string;
  readonly body: string;
  /** Logical label names; mapped to tracker labels through `labelMap`. */
  readonly labels?: readonly string[] | undefined;
}

export interface ProviderCapabilities {
  readonly createIssue: boolean;
  readonly addComment: boolean;
  readonly linkPullRequest: boolean;
  readonly listIssues: boolean;
  /** Can move issues between workflow states (for example Jira *In Progress*). */
  readonly transitions: boolean;
}

export interface IssueProvider {
  readonly type: string;
  getIssue(id: string): Promise<Issue>;
  listIssues(query?: IssueQuery): Promise<Issue[]>;
  createIssue(issue: NewIssue): Promise<Issue>;
  addComment(id: string, body: string): Promise<void>;
  linkPullRequest(id: string, prUrl: string): Promise<void>;
  findDuplicates(title: string): Promise<Issue[]>;
  capabilities(): ProviderCapabilities;
  /** Agent-facing usage notes for this tracker. */
  describe(): string;
}

export type ProviderErrorKind = 'auth' | 'not-found' | 'unavailable' | 'unsupported' | 'failed';

/** Any tracker or code-host failure; the CLI maps it to exit code 4. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

/** Maps logical label names through `labelMap`; unmapped names pass through unchanged. */
export function resolveLabels(
  labels: readonly string[] | undefined,
  labelMap: Readonly<Record<string, string>> | undefined,
): string[] {
  const resolved = (labels ?? []).map((label) => labelMap?.[label] ?? label);
  return [...new Set(resolved)];
}

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 1),
  );
}

/** Jaccard similarity of the word sets of two titles, 0–1. */
export function titleSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export const DUPLICATE_THRESHOLD = 0.5;

/** Candidates whose title is similar enough to `title`, most similar first. */
export function rankDuplicates(title: string, candidates: readonly Issue[]): Issue[] {
  return candidates
    .map((issue) => ({ issue, score: titleSimilarity(title, issue.title) }))
    .filter(({ score }) => score >= DUPLICATE_THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .map(({ issue }) => issue);
}
