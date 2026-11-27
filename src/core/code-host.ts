export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly isDraft: boolean;
  readonly head: string;
  readonly base: string;
  /** SHA of the head commit, when the host reports it. */
  readonly headSha?: string | undefined;
}

export interface NewPullRequest {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly base: string;
  readonly draft?: boolean | undefined;
}

export type CheckBucket = 'pass' | 'fail' | 'pending' | 'skipped' | 'cancelled';

export interface CheckRun {
  readonly name: string;
  readonly bucket: CheckBucket;
  readonly workflow: string;
  readonly link: string;
  /** Workflow run id parsed from `link`, when it points at a GitHub Actions run. */
  readonly runId: string | undefined;
}

/** Pull requests and CI of the hosting platform (GitHub only in v0.1). */
export interface CodeHost {
  readonly type: string;
  createPullRequest(pr: NewPullRequest): Promise<PullRequest>;
  getPullRequest(ref: string): Promise<PullRequest>;
  listChecks(ref: string): Promise<CheckRun[]>;
  /** Failed-step log text of a workflow run, truncated to its tail. */
  getFailedLogs(runId: string): Promise<string>;
  rerunFailed(runId: string): Promise<void>;
  comment(ref: string, body: string): Promise<void>;
  /** Whether a pull request from `branch` has been merged. */
  hasMergedPullRequest(branch: string): Promise<boolean>;
}

/** Who opened a pull request, as the code host records it (never commit metadata). */
export interface PullRequestAuthor {
  readonly number: number;
  readonly login: string;
  readonly isBot: boolean;
  /** GitHub's `author_association`: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE… */
  readonly association: string;
  readonly headSha: string;
  readonly merged: boolean;
  /** How many files the PR changes, as the host counts them. */
  readonly changedFiles?: number | undefined;
}

/** One entry of a git tree: `mode` is git's (100644 file, 100755 executable, 120000 symlink…). */
export interface TreeEntry {
  readonly name: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

/** A directory at a commit: its entries, or why it is not a plain directory there. */
export type TreeListing =
  | { readonly kind: 'entries'; readonly entries: readonly TreeEntry[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-directory'; readonly path: string; readonly mode: string };

export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly mergedAt: string;
  readonly head: string;
  /** Primary author login of each commit (`undefined` when the email is not linked). */
  readonly commitAuthors: readonly (string | undefined)[];
  /** Author logins of reviews and conversation comments. */
  readonly commentAuthors: readonly string[];
}

export interface PullRequestCommit {
  readonly sha: string;
  readonly author: string | undefined;
  readonly isBot: boolean;
  readonly message: string;
  readonly url: string;
}

export interface PullRequestComment {
  readonly id: string;
  readonly kind: 'inline' | 'review' | 'conversation';
  readonly author: string;
  readonly isBot: boolean;
  readonly body: string;
  readonly file?: string | undefined;
  readonly line?: number | undefined;
  readonly url: string;
}

export interface PullRequestFile {
  readonly path: string;
  readonly status: string;
  readonly previousPath?: string | undefined;
}

/**
 * Read-only access to pull requests for learning from them (ADR-0008). Separate from
 * {@link CodeHost} so hosts that cannot do this yet still babysit and open PRs.
 */
export interface PullRequestReader {
  /** The login of the account sentinel's token belongs to. */
  currentLogin(): Promise<string>;
  /** `owner/repo` of the current repository. */
  repository(): Promise<string>;
  getPullRequestAuthor(pr: number): Promise<PullRequestAuthor>;
  /** The current user's merged pull requests, newest first. */
  listMyMergedPullRequests(limit: number): Promise<PullRequestSummary[]>;
  listPullRequestCommits(pr: number): Promise<PullRequestCommit[]>;
  listPullRequestComments(pr: number): Promise<PullRequestComment[]>;
  listPullRequestFiles(pr: number): Promise<PullRequestFile[]>;
  /**
   * The entries of a directory at a commit, walked through git trees so every component's
   * mode is known (a symlink is never followed). Never a checkout.
   */
  listTreeAt(commit: string, dir: string): Promise<TreeListing>;
  /** A blob's text by its SHA. */
  readBlob(sha: string): Promise<string>;
  /** The user's permission on the repository: `admin`, `write`, `read` or `none`. */
  getPermission(login: string): Promise<string>;
}
