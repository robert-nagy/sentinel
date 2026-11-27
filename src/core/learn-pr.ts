import type {
  PullRequestAuthor,
  PullRequestComment,
  PullRequestCommit,
  PullRequestReader,
} from './code-host.js';
import { STORE_DIRS, type LessonStore } from './learn-store.js';
import { LESSON_ID_PATTERN, LearnError, parseLesson } from './learnings.js';
import { ProviderError } from './provider-error.js';

/**
 * Learning from pull requests (ADR-0008, decisions 12 and 13). sentinel only ever learns from
 * the signed-in user's own pull requests: every entry point calls
 * {@link assertOwnPullRequest}, and there is no option, environment variable or config key
 * that skips it. Shared lessons are checked again in CI by {@link verifyLessonChanges}.
 */

export const SUGGEST_LIMIT = 20;
/** How far back `suggest` looks to fill its list after skipping learned PRs. */
export const SUGGEST_LOOKBACK = 100;
export const MAX_PRS_PER_CALL = 10;
const MAX_ITEMS = 50;
const MAX_TEXT = 2000;
const WRITE_ACCESS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** `57`, `#57` or a pull request URL of the current repository. */
export function parsePullRequestRef(ref: string, repository?: string): number {
  const text = ref.trim();
  const plain = /^#?(\d{1,9})$/.exec(text);
  if (plain) return Number(plain[1]);
  const url = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/.exec(text);
  if (url) {
    const repo = `${url[1] ?? ''}/${url[2] ?? ''}`;
    if (repository !== undefined && repo.toLowerCase() !== repository.toLowerCase()) {
      throw new LearnError(
        `${text} belongs to ${repo}, not to this repository (${repository}); lessons come only from this repository's pull requests`,
        'invalid',
      );
    }
    return Number(url[3]);
  }
  throw new LearnError(`"${text}" is not a pull request number or URL`, 'invalid');
}

/**
 * Refuses (kind `forbidden`, exit 6) unless the pull request was opened by the account
 * sentinel runs as. The author comes from the code host, never from commit metadata.
 */
export async function assertOwnPullRequest(
  reader: PullRequestReader,
  pr: number,
  login?: string,
): Promise<PullRequestAuthor> {
  const me = login ?? (await reader.currentLogin());
  const author = await reader.getPullRequestAuthor(pr);
  if (author.login.toLowerCase() !== me.toLowerCase()) {
    throw new LearnError(
      `pull request #${String(pr)} was opened by ${author.login}, not by you (${me}). sentinel learns only from your own pull requests, and no option changes that.`,
      'forbidden',
    );
  }
  return author;
}

export interface Suggestion {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly mergedAt: string;
  /** Commits whose author is someone other than the PR's author (or is unknown). */
  readonly otherCommits: number;
  /** Reviews and conversation comments by people other than the PR's author, without bots. */
  readonly reviewComments: number;
  readonly nothingToLearn: boolean;
}

export interface SuggestOptions {
  readonly limit?: number | undefined;
  /** Only PRs sentinel babysat here, with something to learn, never offered; marks them offered. */
  readonly offer?: boolean | undefined;
  readonly babysat?: ReadonlySet<number> | undefined;
  readonly offerEnabled?: boolean | undefined;
}

const isBotLogin = (login: string) => login.endsWith('[bot]') || login.startsWith('app/');

export async function suggest(
  reader: PullRequestReader,
  store: LessonStore,
  options: SuggestOptions = {},
): Promise<Suggestion[]> {
  const limit = options.limit ?? SUGGEST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SUGGEST_LOOKBACK) {
    throw new LearnError(`--limit must be from 1 to ${String(SUGGEST_LOOKBACK)}`, 'invalid');
  }
  if (options.offer === true && options.offerEnabled === false) return [];
  const login = (await reader.currentLogin()).toLowerCase();
  const learned = await store.learnedPrs();
  const usage = await store.readUsage();
  const rows: Suggestion[] = [];
  for (const pr of await reader.listMyMergedPullRequests(SUGGEST_LOOKBACK)) {
    // `--author @me` is applied by the host; this is the same rule, checked again here.
    if (pr.author.toLowerCase() !== login) continue;
    if (learned.has(pr.number)) continue;
    const otherCommits = pr.commitAuthors.filter((a) => a?.toLowerCase() !== login).length;
    const reviewComments = pr.commentAuthors.filter(
      (a) => a.toLowerCase() !== login && !isBotLogin(a),
    ).length;
    const row: Suggestion = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt,
      otherCommits,
      reviewComments,
      nothingToLearn: otherCommits === 0 && reviewComments === 0,
    };
    if (options.offer === true) {
      if (row.nothingToLearn) continue;
      if (options.babysat?.has(pr.number) !== true) continue;
      if (usage.prs[String(pr.number)]?.offeredAt !== undefined) continue;
    }
    rows.push(row);
    if (rows.length >= limit) break;
  }
  if (options.offer === true && rows.length > 0) {
    await store.markPrs(
      rows.map((r) => r.number),
      'offeredAt',
    );
  }
  return rows;
}

export interface ChangedCommit extends Omit<PullRequestCommit, 'isBot'> {
  /** `other-author`: not the PR's author; `after-agent`: pushed after the last head sentinel saw. */
  readonly reason: 'other-author' | 'after-agent';
}

export interface PrChanges {
  readonly pr: number;
  readonly author: string;
  readonly merged: boolean;
  /** Set when this PR was learned from before. */
  readonly learned?:
    { readonly lessons: readonly string[]; readonly reviewedAt?: string } | undefined;
  /** Whether a head SHA recorded by the babysitter narrowed the commits. */
  readonly recordedHead: boolean;
  readonly commits: readonly ChangedCommit[];
  readonly comments: readonly Omit<PullRequestComment, 'isBot'>[];
  readonly truncated: { readonly commits: number; readonly comments: number };
  readonly note?: string | undefined;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…(cut)` : text;
}

/** What other people (and the user after the agent's last push) changed on the user's PRs. */
export async function prChanges(
  reader: PullRequestReader,
  store: LessonStore,
  prs: readonly number[],
  recordedHeads: ReadonlyMap<number, string> = new Map(),
): Promise<PrChanges[]> {
  if (prs.length === 0) throw new LearnError('name at least one pull request', 'invalid');
  if (prs.length > MAX_PRS_PER_CALL) {
    throw new LearnError(
      `at most ${String(MAX_PRS_PER_CALL)} pull requests at a time; run it again for the rest`,
      'invalid',
    );
  }
  const login = await reader.currentLogin();
  const learned = await store.learnedPrs();
  const unique = [...new Set(prs)];
  // Check every PR before reading anything, so one foreign PR stops the whole call.
  const owned: PullRequestAuthor[] = [];
  for (const pr of unique) owned.push(await assertOwnPullRequest(reader, pr, login));
  const results: PrChanges[] = [];
  for (const author of owned) {
    const pr = author.number;
    const [commits, comments] = await Promise.all([
      reader.listPullRequestCommits(pr),
      reader.listPullRequestComments(pr),
    ]);
    const recorded = recordedHeads.get(pr);
    const recordedIndex =
      recorded === undefined ? -1 : commits.findIndex((c) => c.sha === recorded);
    const selected: ChangedCommit[] = [];
    commits.forEach((commit, index) => {
      if (commit.isBot) return;
      const { isBot: _bot, ...rest } = commit;
      const other = commit.author?.toLowerCase() !== author.login.toLowerCase();
      if (other) selected.push({ ...rest, message: clip(rest.message), reason: 'other-author' });
      else if (recordedIndex !== -1 && index > recordedIndex)
        selected.push({ ...rest, message: clip(rest.message), reason: 'after-agent' });
    });
    const humanComments = comments
      .filter((c) => !c.isBot && c.body.trim() !== '')
      .map(({ isBot: _bot, ...rest }) => ({ ...rest, body: clip(rest.body) }));
    const note =
      recorded === undefined
        ? 'no head SHA was recorded for this pull request on this machine, so only commits by other people are listed'
        : recordedIndex === -1
          ? 'the recorded head SHA is not in this pull request any more, so only commits by other people are listed'
          : undefined;
    results.push({
      pr,
      author: author.login,
      merged: author.merged,
      learned: learned.get(pr),
      recordedHead: recordedIndex !== -1,
      commits: selected.slice(0, MAX_ITEMS),
      comments: humanComments.slice(0, MAX_ITEMS),
      truncated: {
        commits: Math.max(0, selected.length - MAX_ITEMS),
        comments: Math.max(0, humanComments.length - MAX_ITEMS),
      },
      note,
    });
  }
  return results;
}

/** Records the PRs as reviewed on this machine, whatever was kept, so `suggest` skips them. */
export async function markReviewed(
  reader: PullRequestReader,
  store: LessonStore,
  prs: readonly number[],
): Promise<number[]> {
  if (prs.length === 0) throw new LearnError('name at least one pull request', 'invalid');
  const login = await reader.currentLogin();
  const unique = [...new Set(prs)];
  for (const pr of unique) await assertOwnPullRequest(reader, pr, login);
  await store.markPrs(unique, 'reviewedAt');
  return unique;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly pr: number;
  readonly author: string;
  readonly association: string;
  readonly files: readonly string[];
  readonly problems: readonly string[];
}

const SHARED_PREFIX = `${STORE_DIRS.shared}/`;
const PERSONAL_PREFIX = `${STORE_DIRS.personal}/`.toLowerCase();

/**
 * Any path that could become, replace or alias a lesson store. Compared without letter case,
 * since macOS and Windows ignore it, and including `.sentinel` and `.sentinel/learnings`
 * themselves, which a symlink could replace.
 */
function touchesStore(path: string): boolean {
  const p = path.toLowerCase();
  return p === '.sentinel' || p.startsWith('.sentinel/learnings');
}

/**
 * The CI check for shared lessons (ADR-0008, decision 13, gate 2). Reads the PR's changed
 * files through the API at the PR's head commit; it never checks out or runs the PR's code.
 */
export async function verifyLessonChanges(
  reader: PullRequestReader,
  pr: number,
): Promise<VerifyResult> {
  const author = await reader.getPullRequestAuthor(pr);
  const listed = await reader.listPullRequestFiles(pr);
  const touched = listed.filter((f) => touchesStore(f.path) || touchesStore(f.previousPath ?? ''));
  const problems: string[] = [];
  const base = {
    pr,
    author: author.login,
    association: author.association,
    files: touched.map((f) => f.path),
  };
  if (author.changedFiles !== undefined && listed.length < author.changedFiles) {
    // GitHub lists at most 3,000 files; a lesson could hide beyond that, so fail closed.
    problems.push(
      `the host listed only ${String(listed.length)} of ${String(author.changedFiles)} changed files, so lesson changes cannot be verified; split the pull request`,
    );
    return { ...base, ok: false, problems };
  }
  if (touched.length === 0) return { ...base, ok: true, problems };

  if (!WRITE_ACCESS.has(author.association.toUpperCase()) || author.isBot) {
    problems.push(
      `${author.login} (${author.association}) has no write access, so this pull request may not change lessons`,
    );
  }
  for (const file of touched) {
    // Moved out of the store, or deleted: only the write-access rule above applies.
    if (file.status === 'removed' || !touchesStore(file.path)) continue;
    if (file.path.toLowerCase().startsWith(PERSONAL_PREFIX)) {
      problems.push(`${file.path}: personal lessons must never be committed`);
      continue;
    }
    if (!file.path.startsWith(SHARED_PREFIX)) {
      problems.push(
        `${file.path}: lessons belong in ${STORE_DIRS.shared}/ exactly (a real directory, same letter case)`,
      );
      continue;
    }
    const name = file.path.slice(SHARED_PREFIX.length);
    if (name === '.gitignore' || name === 'README.md') continue;
    if (
      name.includes('/') ||
      !LESSON_ID_PATTERN.test(name.replace(/\.md$/, '')) ||
      !name.endsWith('.md')
    ) {
      problems.push(
        `${file.path}: only lesson files named <id>.md belong in ${STORE_DIRS.shared}/`,
      );
      continue;
    }
    const entry = await reader.readFileAtRef(file.path, author.headSha);
    if (entry === undefined) {
      problems.push(`${file.path}: could not be read at ${author.headSha}`);
      continue;
    }
    if (entry.type !== 'file' || entry.text === undefined) {
      problems.push(`${file.path}: must be a regular file, not a ${entry.type}`);
      continue;
    }
    const text = entry.text;
    const parsed = parseLesson(text);
    if (parsed.lesson === undefined) {
      problems.push(...parsed.problems.map((p) => `${file.path}: ${p}`));
      continue;
    }
    if (`${parsed.lesson.id}.md` !== name) {
      problems.push(`${file.path}: the file name must be ${parsed.lesson.id}.md`);
    }
    if (parsed.lesson.source === 'pr' && parsed.lesson.pr !== undefined) {
      try {
        const cited = await reader.getPullRequestAuthor(parsed.lesson.pr);
        if (cited.login.toLowerCase() !== author.login.toLowerCase()) {
          problems.push(
            `${file.path}: learned from pull request #${String(parsed.lesson.pr)} by ${cited.login}, but only the author of a pull request may learn from it (this one is by ${author.login})`,
          );
        }
      } catch (error) {
        if (!(error instanceof ProviderError) || error.kind !== 'not-found') throw error;
        problems.push(
          `${file.path}: cites pull request #${String(parsed.lesson.pr)}, which does not exist`,
        );
      }
    }
  }
  return { ...base, ok: problems.length === 0, problems };
}
