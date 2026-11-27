import { z } from 'zod';
import type {
  CheckBucket,
  CheckRun,
  CodeHost,
  NewPullRequest,
  PullRequest,
  PullRequestAuthor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestFile,
  PullRequestReader,
  PullRequestSummary,
  TreeEntry,
  TreeListing,
} from '../code-host.js';
import type { CommandRunner } from '../exec.js';
import { ProviderError } from '../provider-error.js';

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

const PR_FIELDS = 'number,url,title,state,isDraft,headRefName,baseRefName,headRefOid';
const GH_TIMEOUT_MS = 60_000;

/** The user's merged PRs with commit authors, reviews and comments, in GitHub's node limits. */
const MERGED_PRS_QUERY = `query($q: String!, $n: Int!) {
  search(query: $q, type: ISSUE, first: $n) {
    nodes {
      ... on PullRequest {
        number title url mergedAt headRefName
        author { login }
        commits(first: 100) { nodes { commit { authors(first: 1) { nodes { user { login } } } } } }
        reviews(first: 50) { nodes { author { __typename login } body state } }
        comments(first: 50) { nodes { author { __typename login } } }
      }
    }
  }
}`;
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
  headRefOid: z.string().optional(),
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
    headSha: raw.headRefOid,
  };
}

const BUCKETS: readonly CheckBucket[] = ['pass', 'fail', 'pending', 'skipped', 'cancelled'];

function toBucket(value: string): CheckBucket {
  if (value === 'skipping') return 'skipped';
  if (value === 'cancel') return 'cancelled';
  return (BUCKETS as readonly string[]).includes(value) ? (value as CheckBucket) : 'pending';
}

export class GitHubCodeHost implements CodeHost, PullRequestReader {
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

  async currentLogin(): Promise<string> {
    const out = await this.gh(['api', 'user', '--jq', '.login'], 'read the signed-in GitHub user');
    const login = out.trim();
    if (login === '') throw new ProviderError('auth', 'gh returned no user; run `gh auth login`');
    return login;
  }

  async repository(): Promise<string> {
    const out = await this.gh(
      ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
      'read the current repository',
    );
    return out.trim();
  }

  /** `gh api` takes the repository from the path, so `--repo` is not appended. */
  private async api(path: string, action: string, extra: readonly string[] = []): Promise<string> {
    const result = await this.options.run('gh', ['api', ...extra, this.repoPath(path)], {
      cwd: this.options.cwd,
      timeoutMs: GH_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) throw ghError(result, action);
    return result.stdout;
  }

  private repoPath(path: string): string {
    return `repos/${this.options.repo ?? '{owner}/{repo}'}/${path}`;
  }

  /** Paginated list endpoints, one JSON object per line. */
  private async apiLines<T>(
    path: string,
    jq: string,
    schema: z.ZodType<T>,
    action: string,
  ): Promise<T[]> {
    const out = await this.api(path, action, ['--paginate', '--jq', jq]);
    return out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => this.json(schema, line, action));
  }

  async getPullRequestAuthor(pr: number): Promise<PullRequestAuthor> {
    const n = requirePrNumber(pr);
    const out = await this.api(`pulls/${n}`, `read pull request ${n}`, [
      '--jq',
      '{number, login: .user.login, type: .user.type, association: .author_association, headSha: .head.sha, merged, changedFiles: .changed_files}',
    ]);
    const raw = this.json(
      z.object({
        number: z.number(),
        login: z.string(),
        type: z.string().nullish(),
        association: z.string(),
        headSha: z.string(),
        merged: z.boolean().nullish(),
        changedFiles: z.number().nullish(),
      }),
      out,
      `read pull request ${n}`,
    );
    return {
      number: raw.number,
      login: raw.login,
      isBot: isBot(raw.login, raw.type),
      association: raw.association,
      headSha: raw.headSha,
      merged: raw.merged === true,
      changedFiles: raw.changedFiles ?? undefined,
    };
  }

  async listMyMergedPullRequests(limit: number): Promise<PullRequestSummary[]> {
    const action = 'list your merged pull requests';
    const repo = this.options.repo ?? (await this.repository());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new ProviderError('failed', `could not ${action}: unexpected repository "${repo}"`);
    }
    // One search with small, explicit page sizes: `gh pr list --json commits` asks for up to
    // a million GraphQL nodes for 100 PRs and GitHub refuses it.
    const out = await this.gh(
      [
        'api',
        'graphql',
        '-f',
        `query=${MERGED_PRS_QUERY}`,
        '-f',
        `q=repo:${repo} is:pr is:merged author:@me sort:updated-desc`,
        '-F',
        `n=${String(Math.max(1, Math.min(limit, 100)))}`,
        '--jq',
        '.data.search.nodes',
      ],
      action,
    );
    const login = z.object({ login: z.string(), __typename: z.string().optional() }).nullish();
    // GraphQL gives bot logins without the `[bot]` suffix REST uses; add it from the type.
    const name = (a: z.infer<typeof login>) =>
      a == null ? undefined : a.__typename === 'Bot' ? `${a.login}[bot]` : a.login;
    const nodes = <T extends z.ZodType>(item: T) =>
      z.object({ nodes: z.array(item).nullish() }).nullish();
    const rows = this.json(
      z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          url: z.string(),
          author: login,
          mergedAt: z.string().nullish(),
          headRefName: z.string(),
          commits: nodes(
            z.object({
              commit: z.object({ authors: nodes(z.object({ user: login })) }),
            }),
          ),
          reviews: nodes(
            z.object({ author: login, body: z.string().nullish(), state: z.string().nullish() }),
          ),
          comments: nodes(z.object({ author: login })),
        }),
      ),
      out,
      action,
    );
    return rows
      .map((r) => ({
        number: r.number,
        title: r.title,
        url: r.url,
        author: r.author?.login ?? '',
        mergedAt: r.mergedAt ?? '',
        head: r.headRefName,
        commitAuthors: (r.commits?.nodes ?? []).map(
          (c) => c.commit.authors?.nodes?.[0]?.user?.login ?? undefined,
        ),
        // An approval without a body says nothing to learn from; a COMMENTED review with an
        // empty body usually carries inline comments, so it counts.
        commentAuthors: [
          ...(r.reviews?.nodes ?? []).filter(
            (v) =>
              (v.body ?? '').trim() !== '' || !['APPROVED', 'DISMISSED'].includes(v.state ?? ''),
          ),
          ...(r.comments?.nodes ?? []),
        ]
          .map((c) => name(c.author))
          .filter((l): l is string => l !== undefined),
      }))
      .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : a.mergedAt > b.mergedAt ? -1 : 0));
  }

  async listPullRequestCommits(pr: number): Promise<PullRequestCommit[]> {
    const n = requirePrNumber(pr);
    const rows = await this.apiLines(
      `pulls/${n}/commits`,
      '.[] | {sha, login: .author.login, type: .author.type, message: .commit.message, url: .html_url}',
      z.object({
        sha: z.string(),
        login: z.string().nullish(),
        type: z.string().nullish(),
        message: z.string(),
        url: z.string().nullish(),
      }),
      `list commits of pull request ${n}`,
    );
    return rows.map((r) => ({
      sha: r.sha,
      author: r.login ?? undefined,
      isBot: r.login != null && isBot(r.login, r.type),
      message: r.message,
      url: r.url ?? '',
    }));
  }

  async listPullRequestComments(pr: number): Promise<PullRequestComment[]> {
    const n = requirePrNumber(pr);
    const row = z.object({
      id: z.union([z.number(), z.string()]),
      login: z.string().nullish(),
      type: z.string().nullish(),
      body: z.string().nullish(),
      path: z.string().nullish(),
      line: z.number().nullish(),
      url: z.string().nullish(),
    });
    const action = `list comments of pull request ${n}`;
    const [inline, reviews, conversation] = await Promise.all([
      this.apiLines(
        `pulls/${n}/comments`,
        '.[] | {id, login: .user.login, type: .user.type, body, path, line: (.line // .original_line), url: .html_url}',
        row,
        action,
      ),
      this.apiLines(
        `pulls/${n}/reviews`,
        '.[] | {id, login: .user.login, type: .user.type, body, url: .html_url}',
        row,
        action,
      ),
      this.apiLines(
        `issues/${n}/comments`,
        '.[] | {id, login: .user.login, type: .user.type, body, url: .html_url}',
        row,
        action,
      ),
    ]);
    const map = (kind: PullRequestComment['kind']) => (r: z.infer<typeof row>) => ({
      id: `${kind}-${String(r.id)}`,
      kind,
      author: r.login ?? '',
      isBot: isBot(r.login ?? '', r.type),
      body: r.body ?? '',
      file: r.path ?? undefined,
      line: r.line ?? undefined,
      url: r.url ?? '',
    });
    return [
      ...inline.map(map('inline')),
      ...reviews.map(map('review')).filter((c) => c.body.trim() !== ''),
      ...conversation.map(map('conversation')),
    ];
  }

  async listPullRequestFiles(pr: number): Promise<PullRequestFile[]> {
    const n = requirePrNumber(pr);
    const rows = await this.apiLines(
      `pulls/${n}/files`,
      '.[] | {filename, status, previous: .previous_filename}',
      z.object({ filename: z.string(), status: z.string(), previous: z.string().nullish() }),
      `list files of pull request ${n}`,
    );
    return rows.map((r) => ({
      path: r.filename,
      status: r.status,
      previousPath: r.previous ?? undefined,
    }));
  }

  async listTreeAt(commit: string, dir: string): Promise<TreeListing> {
    const sha = requireSha(commit);
    const action = `read ${dir} at ${sha}`;
    let tree = (await this.api(`git/commits/${sha}`, action, ['--jq', '.tree.sha'])).trim();
    let walked = '';
    for (const part of dir.split('/').filter((p) => p !== '')) {
      const entries = await this.treeEntries(tree, action);
      const entry = entries.find((e) => e.name === part);
      walked = walked === '' ? part : `${walked}/${part}`;
      if (entry === undefined) return { kind: 'missing' };
      if (entry.mode !== '040000' || entry.type !== 'tree') {
        return { kind: 'not-a-directory', path: walked, mode: entry.mode };
      }
      tree = entry.sha;
    }
    return { kind: 'entries', entries: await this.treeEntries(tree, action) };
  }

  private async treeEntries(tree: string, action: string): Promise<TreeEntry[]> {
    const out = await this.api(`git/trees/${requireSha(tree)}`, action, [
      '--jq',
      '.tree[] | {name: .path, mode, type, sha}',
    ]);
    const entry = z.object({
      name: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: z.string(),
    });
    return out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => this.json(entry, line, action));
  }

  async readBlob(sha: string): Promise<string> {
    const id = requireSha(sha);
    const action = `read blob ${id}`;
    const raw = this.json(
      z.object({ encoding: z.string(), content: z.string() }),
      await this.api(`git/blobs/${id}`, action, ['--jq', '{encoding, content}']),
      action,
    );
    if (raw.encoding !== 'base64') {
      throw new ProviderError('failed', `could not ${action}: unexpected encoding`);
    }
    return Buffer.from(raw.content, 'base64').toString('utf8');
  }

  async getPermission(login: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/.test(login)) {
      throw new ProviderError('failed', `"${login}" is not a GitHub login`);
    }
    const out = await this.api(
      `collaborators/${encodeURIComponent(login)}/permission`,
      `read the permission of ${login}`,
      ['--jq', '.permission'],
    );
    return out.trim().toLowerCase();
  }
}

function requireRunId(value: string): string {
  const id = /^\d+$/.test(value) ? value : /\/runs\/(\d+)/.exec(value)?.[1];
  if (id === undefined)
    throw new ProviderError('failed', `"${value}" is not a workflow run id or run URL`);
  return id;
}

function requireSha(value: string): string {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new ProviderError('failed', `"${value}" is not a git object SHA`);
  }
  return value;
}

function requirePrNumber(pr: number): string {
  if (!Number.isInteger(pr) || pr <= 0)
    throw new ProviderError('failed', `"${String(pr)}" is not a pull request number`);
  return String(pr);
}

/** Bot accounts: `type: Bot`, a `[bot]` login, or gh's `app/<name>` form. */
export function isBot(login: string, type?: string | null): boolean {
  return type === 'Bot' || login.endsWith('[bot]') || login.startsWith('app/');
}
