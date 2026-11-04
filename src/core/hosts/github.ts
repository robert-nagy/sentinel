import { z } from 'zod';
import type { CheckBucket, CheckRun, CodeHost, NewPullRequest, PullRequest } from '../code-host.js';
import type { CommandRunner } from '../exec.js';
import { ProviderError } from '../issue-provider.js';
import { ghError } from '../providers/github.js';

const PR_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName';
const GH_TIMEOUT_MS = 60_000;
/** Failed logs can be huge; the failure is almost always at the end. */
export const MAX_LOG_CHARS = 100_000;

const ghPr = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  isDraft: z.boolean().default(false),
  headRefName: z.string(),
  baseRefName: z.string(),
});

const ghCheck = z.object({
  name: z.string(),
  bucket: z.string().default('pending'),
  workflow: z.string().nullish(),
  link: z.string().nullish(),
});

function toPullRequest(raw: z.infer<typeof ghPr>): PullRequest {
  const state = raw.state.toUpperCase();
  return {
    number: raw.number,
    url: raw.url,
    title: raw.title,
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    isDraft: raw.isDraft,
    head: raw.headRefName,
    base: raw.baseRefName,
  };
}

const BUCKETS: readonly CheckBucket[] = ['pass', 'fail', 'pending', 'skipped', 'cancelled'];

function toBucket(value: string): CheckBucket {
  if (value === 'skipping') return 'skipped';
  if (value === 'cancel') return 'cancelled';
  return (BUCKETS as readonly string[]).includes(value) ? (value as CheckBucket) : 'pending';
}

export class GitHubCodeHost implements CodeHost {
  readonly type = 'github';

  constructor(
    private readonly options: { run: CommandRunner; cwd: string; repo?: string | undefined },
  ) {}

  private async gh(
    args: readonly string[],
    action: string,
    acceptExitCodes: readonly number[] = [0],
  ): Promise<string> {
    const repoArgs = this.options.repo === undefined ? [] : ['--repo', this.options.repo];
    const result = await this.options.run('gh', [...args, ...repoArgs], {
      cwd: this.options.cwd,
      timeoutMs: GH_TIMEOUT_MS,
    });
    if (result.exitCode === null || !acceptExitCodes.includes(result.exitCode)) {
      throw ghError(result, action);
    }
    return result.stdout;
  }

  private json<T>(schema: z.ZodType<T>, text: string, action: string): T {
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // fall through
    }
    throw new ProviderError('failed', `could not ${action}: unexpected gh output`);
  }

  async createPullRequest(pr: NewPullRequest): Promise<PullRequest> {
    const args = [
      'pr',
      'create',
      '--title',
      pr.title,
      '--body',
      pr.body,
      '--head',
      pr.head,
      '--base',
      pr.base,
    ];
    if (pr.draft === true) args.push('--draft');
    const out = await this.gh(args, 'create the pull request');
    const url = /https:\/\/\S+\/pull\/\d+/.exec(out)?.[0];
    if (url === undefined) {
      throw new ProviderError(
        'failed',
        `pull request created but gh printed no URL: ${out.trim()}`,
      );
    }
    return this.getPullRequest(url);
  }

  async getPullRequest(ref: string): Promise<PullRequest> {
    const out = await this.gh(['pr', 'view', ref, '--json', PR_FIELDS], `read pull request ${ref}`);
    return toPullRequest(this.json(ghPr, out, `read pull request ${ref}`));
  }

  async listChecks(ref: string): Promise<CheckRun[]> {
    // `gh pr checks` exits 8 while checks are pending and 1 when some failed; both still print JSON.
    const out = await this.gh(
      ['pr', 'checks', ref, '--json', 'name,bucket,workflow,link'],
      `list checks of ${ref}`,
      [0, 1, 8],
    );
    if (out.trim() === '') return [];
    return this.json(z.array(ghCheck), out, `list checks of ${ref}`).map((c) => ({
      name: c.name,
      bucket: toBucket(c.bucket),
      workflow: c.workflow ?? '',
      link: c.link ?? '',
      runId: /\/runs\/(\d+)/.exec(c.link ?? '')?.[1],
    }));
  }

  async getFailedLogs(runId: string): Promise<string> {
    const id = requireRunId(runId);
    const out = await this.gh(['run', 'view', id, '--log-failed'], `read failed logs of run ${id}`);
    return out.length > MAX_LOG_CHARS ? `…(truncated)\n${out.slice(-MAX_LOG_CHARS)}` : out;
  }

  async rerunFailed(runId: string): Promise<void> {
    const id = requireRunId(runId);
    await this.gh(['run', 'rerun', id, '--failed'], `re-run failed jobs of run ${id}`);
  }

  async comment(ref: string, body: string): Promise<void> {
    await this.gh(['pr', 'comment', ref, '--body', body], `comment on ${ref}`);
  }

  async hasMergedPullRequest(branch: string): Promise<boolean> {
    const out = await this.gh(
      ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number', '--limit', '1'],
      `look up merged pull requests of ${branch}`,
    );
    return (
      this.json(z.array(z.object({ number: z.number() })), out, 'parse merged pull requests')
        .length > 0
    );
  }
}

function requireRunId(value: string): string {
  const id = /^\d+$/.test(value) ? value : /\/runs\/(\d+)/.exec(value)?.[1];
  if (id === undefined)
    throw new ProviderError('failed', `"${value}" is not a workflow run id or run URL`);
  return id;
}
