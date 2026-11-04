export interface PullRequest {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly isDraft: boolean;
  readonly head: string;
  readonly base: string;
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
