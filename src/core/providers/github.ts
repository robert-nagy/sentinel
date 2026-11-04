import { z } from 'zod';
import type { CommandRunner } from '../exec.js';
import {
  ProviderError,
  rankDuplicates,
  resolveLabels,
  type Issue,
  type IssueProvider,
  type IssueQuery,
  type NewIssue,
  type ProviderCapabilities,
} from '../issue-provider.js';

const ISSUE_FIELDS = 'number,title,body,state,labels,url,assignees';
const GH_TIMEOUT_MS = 60_000;

const ghIssue = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  url: z.string(),
  assignees: z.array(z.object({ login: z.string() })).default([]),
});

export interface GitHubProviderOptions {
  readonly run: CommandRunner;
  readonly cwd: string;
  /** `owner/name`; defaults to the repository of the working directory. */
  readonly repo?: string | undefined;
  readonly labelMap?: Readonly<Record<string, string>> | undefined;
}

export const githubOptionsSchema = z.strictObject({
  repo: z
    .string()
    .regex(/^[^/\s]+\/[^/\s]+$/)
    .optional(),
});

function toIssue(raw: z.infer<typeof ghIssue>): Issue {
  return {
    id: String(raw.number),
    title: raw.title,
    body: raw.body ?? '',
    state: raw.state.toUpperCase() === 'CLOSED' ? 'closed' : 'open',
    labels: raw.labels.map((l) => l.name),
    url: raw.url,
    assignees: raw.assignees.map((a) => a.login),
  };
}

function issueNumber(id: string): string {
  const normalized = id.trim().replace(/^#/, '');
  if (!/^\d+$/.test(normalized)) {
    throw new ProviderError('failed', `GitHub issue ids are numbers (got "${id}")`);
  }
  return normalized;
}

/** Turns a failed `gh` invocation into a {@link ProviderError}. */
export function ghError(
  result: {
    exitCode: number | null;
    stderr: string;
    stdout: string;
    notFound: boolean;
    timedOut: boolean;
  },
  action: string,
): ProviderError {
  if (result.notFound) {
    return new ProviderError(
      'unavailable',
      'the GitHub CLI (gh) was not found; install it from https://cli.github.com',
    );
  }
  if (result.timedOut)
    return new ProviderError('unavailable', `gh timed out while trying to ${action}`);
  const detail = (result.stderr || result.stdout).trim();
  if (
    /gh auth login|not logged in|authentication|GH_TOKEN|HTTP 401|bad credentials/i.test(detail)
  ) {
    return new ProviderError(
      'auth',
      `GitHub authentication failed: run \`gh auth login\` (${detail.split('\n')[0] ?? ''})`,
    );
  }
  if (/could not resolve|not found|HTTP 404|no pull requests? found/i.test(detail)) {
    return new ProviderError(
      'not-found',
      `could not ${action}: ${detail.split('\n')[0] ?? 'not found'}`,
    );
  }
  return new ProviderError('failed', `could not ${action}: ${detail || 'gh exited with an error'}`);
}

export class GitHubIssueProvider implements IssueProvider {
  readonly type = 'github';

  constructor(private readonly options: GitHubProviderOptions) {}

  private async gh(args: readonly string[], action: string): Promise<string> {
    const repoArgs = this.options.repo === undefined ? [] : ['--repo', this.options.repo];
    const result = await this.options.run('gh', [...args, ...repoArgs], {
      cwd: this.options.cwd,
      timeoutMs: GH_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) throw ghError(result, action);
    return result.stdout;
  }

  private parse<T>(schema: z.ZodType<T>, text: string, action: string): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ProviderError('failed', `could not ${action}: gh returned invalid JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(
        'failed',
        `could not ${action}: unexpected gh output (${parsed.error.issues[0]?.message ?? 'invalid'})`,
      );
    }
    return parsed.data;
  }

  async getIssue(id: string): Promise<Issue> {
    const number = issueNumber(id);
    const out = await this.gh(
      ['issue', 'view', number, '--json', ISSUE_FIELDS],
      `read issue #${number}`,
    );
    return toIssue(this.parse(ghIssue, out, `read issue #${number}`));
  }

  async listIssues(query: IssueQuery = {}): Promise<Issue[]> {
    const args = [
      'issue',
      'list',
      '--json',
      ISSUE_FIELDS,
      '--state',
      query.state ?? 'open',
      '--limit',
      String(query.limit ?? 30),
    ];
    for (const label of resolveLabels(query.labels, this.options.labelMap))
      args.push('--label', label);
    if (query.search !== undefined && query.search.trim() !== '')
      args.push('--search', query.search);
    const out = await this.gh(args, 'list issues');
    return this.parse(z.array(ghIssue), out, 'list issues').map(toIssue);
  }

  async createIssue(issue: NewIssue): Promise<Issue> {
    const args = ['issue', 'create', '--title', issue.title, '--body', issue.body];
    for (const label of resolveLabels(issue.labels, this.options.labelMap))
      args.push('--label', label);
    const out = await this.gh(args, 'create the issue');
    const number = /\/issues\/(\d+)\s*$/.exec(out.trim())?.[1];
    if (number === undefined) {
      throw new ProviderError(
        'failed',
        `issue was created but gh printed no issue URL: ${out.trim()}`,
      );
    }
    return this.getIssue(number);
  }

  async addComment(id: string, body: string): Promise<void> {
    const number = issueNumber(id);
    await this.gh(['issue', 'comment', number, '--body', body], `comment on issue #${number}`);
  }

  async linkPullRequest(id: string, prUrl: string): Promise<void> {
    await this.addComment(id, `Linked pull request: ${prUrl}`);
  }

  async findDuplicates(title: string): Promise<Issue[]> {
    const candidates = await this.listIssues({ state: 'all', search: title, limit: 10 });
    return rankDuplicates(title, candidates);
  }

  capabilities(): ProviderCapabilities {
    return {
      createIssue: true,
      addComment: true,
      linkPullRequest: true,
      listIssues: true,
      transitions: false,
    };
  }

  describe(): string {
    return [
      'Issue tracker: GitHub Issues (via the gh CLI).',
      '- Read an issue: sentinel issue get <number> --json',
      '- Search before creating: sentinel issue list --search "<title>" --state all --json',
      '- Create: sentinel issue create --title "..." --body "..." --label <name>',
      '- Comment: sentinel issue comment <number> --body "..."',
      '- Pull requests close issues with "Closes #<number>" in the PR body (sentinel pr create adds it).',
      '- Authentication: `gh auth login` (exit code 4 means it is missing or expired).',
    ].join('\n');
  }
}
