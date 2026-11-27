import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { titleSimilarity, DUPLICATE_THRESHOLD } from './duplicates.js';
import { compileGlob, globSpecificity, isGlobalGlob, normalizePath } from './globs.js';
import {
  LearnError,
  parseLesson,
  parseLessonDraft,
  renderLesson,
  type Lesson,
} from './learnings.js';
import { StateStore } from './state.js';

/**
 * The lesson store (ADR-0008). Lesson files hold content only and live in two directories:
 * shared (committed) and personal (git-ignored). Everything that changes on use (recall
 * counts, dates, the archived flag) and the derived index live in `.sentinel/state/`, so a
 * recall never changes a committed file.
 */

export type StoreName = 'shared' | 'personal';

export const STORE_DIRS: Readonly<Record<StoreName, string>> = {
  shared: '.sentinel/learnings',
  personal: '.sentinel/learnings.local',
};

/** The hard upper bound on lessons per recall, whatever the config says. */
export const MAX_RECALL_LIMIT = 10;
const INDEX_NAME = 'learn-index';
const USAGE_NAME = 'learn-usage';
const INDEX_VERSION = 1;
const DAY_MS = 86_400_000;

export interface LearnSettings {
  readonly maxActive: number;
  readonly archiveAfterDays: number;
  readonly recallLimit: number;
}

export type LessonMeta = Omit<Lesson, 'body'>;

export interface IndexEntry {
  /** Repo-relative path with `/` separators. */
  readonly file: string;
  readonly store: StoreName;
  readonly size: number;
  readonly mtimeMs: number;
  readonly meta?: LessonMeta | undefined;
  readonly problems?: readonly string[] | undefined;
}

interface IndexFile {
  readonly version: number;
  readonly entries: Record<string, IndexEntry>;
}

export interface UsageEntry {
  readonly recurrences: number;
  readonly recalls: number;
  readonly lastUsed?: string | undefined;
  readonly lastReinforced?: string | undefined;
  /** The date the lesson was archived on this machine. */
  readonly archived?: string | undefined;
}

export interface PrUsage {
  readonly reviewedAt?: string | undefined;
  readonly offeredAt?: string | undefined;
}

export interface UsageFile {
  readonly version: number;
  readonly lessons: Record<string, UsageEntry>;
  readonly prs: Record<string, PrUsage>;
}

export interface AddResult {
  readonly action: 'added' | 'merged';
  readonly id: string;
  readonly store: StoreName;
  readonly path: string;
  /** Lessons archived by the prune that follows every add. */
  readonly archived: readonly string[];
}

export interface RecallQuery {
  readonly paths?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly signature?: string | undefined;
  readonly limit?: number | undefined;
}

export interface RecalledLesson extends Lesson {
  readonly store: StoreName;
  readonly path: string;
  /** Why it matched: `signature`, `scope`, `global` or `tag`. */
  readonly match: 'signature' | 'scope' | 'global' | 'tag';
}

export interface ListedLesson extends LessonMeta {
  readonly store: StoreName;
  readonly path: string;
  readonly usage: UsageEntry;
}

export interface InvalidLesson {
  readonly path: string;
  readonly problems: readonly string[];
}

const EMPTY_USAGE: UsageEntry = { recurrences: 0, recalls: 0 };
const READ_BATCH = 64;
/** `O_NOFOLLOW` is missing on Windows, where `lstat` in `refresh` is the only guard. */
const NO_FOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

/**
 * Reads a lesson file without following a symlink at the last path component (`O_NOFOLLOW`,
 * where the platform has it) and only if it is a regular file, so a file swapped for a symlink
 * after `refresh` checked it is still refused.
 */
async function readLessonFile(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new LearnError(`${path} is not a regular file`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function indexEntry(
  store: StoreName,
  item: { name: string; file: string; size: number; mtimeMs: number },
  text: string,
): IndexEntry {
  const parsed = parseLesson(text);
  const problems = [...parsed.problems];
  if (parsed.lesson !== undefined && `${parsed.lesson.id}.md` !== item.name) {
    problems.push(`the file name must be ${parsed.lesson.id}.md`);
  }
  let meta: LessonMeta | undefined;
  if (parsed.lesson !== undefined && problems.length === 0) {
    const { body: _body, ...rest } = parsed.lesson;
    meta = rest;
  }
  return {
    file: item.file,
    store,
    size: item.size,
    mtimeMs: item.mtimeMs,
    meta,
    problems: problems.length > 0 ? problems : undefined,
  };
}

function key(store: StoreName, id: string): string {
  return `${store}:${id}`;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.floor((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const temp = `${path}.${String(process.pid)}.${String(Date.now())}.tmp`;
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

function compare(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export class LessonStore {
  private readonly state: StateStore;
  /** Files read and parsed by the last `refresh` (for tests and `--json` diagnostics). */
  filesRead = 0;

  /**
   * @param root the checkout whose shared lessons are read and written (an issue worktree
   *   during an SDLC run, so new lessons ride on its PR).
   * @param options.mainRoot the main checkout, home of the personal lessons and the local
   *   state (index and usage), so both survive when a worktree is removed. Defaults to `root`.
   */
  constructor(
    readonly root: string,
    private readonly options: {
      readonly now: () => Date;
      readonly settings: LearnSettings;
      readonly mainRoot?: string | undefined;
    },
  ) {
    this.mainRoot = options.mainRoot ?? root;
    this.state = new StateStore(this.mainRoot);
    // One index per checkout: each worktree has its own shared lessons.
    this.indexName =
      this.mainRoot === root
        ? INDEX_NAME
        : `${INDEX_NAME}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  }

  private readonly indexName: string;

  readonly mainRoot: string;

  private today(): string {
    return day(this.options.now());
  }

  dir(store: StoreName): string {
    return join(store === 'shared' ? this.root : this.mainRoot, ...STORE_DIRS[store].split('/'));
  }

  private pathOf(entry: Pick<IndexEntry, 'store' | 'file'>): string {
    return join(this.dir(entry.store), entry.file.slice(STORE_DIRS[entry.store].length + 1));
  }

  /**
   * Brings the derived index up to date: one directory listing per store and one `stat` per
   * lesson file. Only files whose size or modification time changed are read.
   */
  async refresh(): Promise<IndexEntry[]> {
    this.filesRead = 0;
    const previous = await this.readIndex();
    const entries: Record<string, IndexEntry> = {};
    for (const store of ['shared', 'personal'] as const) {
      // A store reached through a symlink is ignored: it could point anywhere (ADR-0008).
      if (!(await this.realDirectory(store))) continue;
      let names: string[];
      try {
        names = await readdir(this.dir(store));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const files = names.filter((n) => n.endsWith('.md')).sort();
      const stats = await Promise.all(
        files.map(async (name) => {
          const path = join(this.dir(store), name);
          try {
            // lstat: a symlinked lesson file is not a regular file, so it is skipped.
            return { name, path, info: await lstat(path) };
          } catch {
            return undefined;
          }
        }),
      );
      const stale: { name: string; path: string; file: string; size: number; mtimeMs: number }[] =
        [];
      for (const item of stats) {
        if (!item?.info.isFile()) continue;
        const file = `${STORE_DIRS[store]}/${item.name}`;
        const old = previous.entries[file];
        if (old?.size === item.info.size && old.mtimeMs === item.info.mtimeMs) {
          entries[file] = old;
        } else {
          stale.push({
            name: item.name,
            path: item.path,
            file,
            size: item.info.size,
            mtimeMs: item.info.mtimeMs,
          });
        }
      }
      // Read changed files a batch at a time: fast on a cold index, bounded open files.
      for (let i = 0; i < stale.length; i += READ_BATCH) {
        const batch = stale.slice(i, i + READ_BATCH);
        const texts = await Promise.all(
          batch.map((item) => readLessonFile(item.path).catch(() => '')),
        );
        batch.forEach((item, j) => {
          this.filesRead += 1;
          entries[item.file] = indexEntry(store, item, texts[j] ?? '');
        });
      }
    }
    const changed =
      this.filesRead > 0 ||
      Object.keys(entries).length !== Object.keys(previous.entries).length ||
      Object.keys(entries).some((file) => previous.entries[file] === undefined);
    if (changed) await this.state.write(this.indexName, { version: INDEX_VERSION, entries });
    return Object.values(entries);
  }

  /** Whether every component of the store's directory below its root is a real directory. */
  private async realDirectory(store: StoreName): Promise<boolean> {
    let dir = store === 'shared' ? this.root : this.mainRoot;
    for (const part of STORE_DIRS[store].split('/')) {
      dir = join(dir, part);
      try {
        const info = await lstat(dir);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    }
    return true;
  }

  private async readIndex(): Promise<IndexFile> {
    const index = await this.state.read<IndexFile>(this.indexName);
    if (index?.version !== INDEX_VERSION || typeof index.entries !== 'object') {
      return { version: INDEX_VERSION, entries: {} };
    }
    return index;
  }

  async readUsage(): Promise<UsageFile> {
    const usage = await this.state.read<UsageFile>(USAGE_NAME);
    return {
      version: 1,
      lessons: usage?.lessons ?? {},
      prs: usage?.prs ?? {},
    };
  }

  async writeUsage(usage: UsageFile): Promise<void> {
    await this.state.write(USAGE_NAME, usage);
  }

  private static valid(entries: readonly IndexEntry[]): (IndexEntry & { meta: LessonMeta })[] {
    return entries.filter((e): e is IndexEntry & { meta: LessonMeta } => e.meta !== undefined);
  }

  /** Validates an agent-written draft, then stores it or reinforces the lesson it duplicates. */
  async add(text: string, options: { store: StoreName }): Promise<AddResult> {
    const parsed = parseLessonDraft(text, { created: this.today() });
    if (parsed.lesson === undefined) {
      throw new LearnError(
        `the lesson is not valid:\n- ${parsed.problems.join('\n- ')}`,
        'invalid',
      );
    }
    const lesson = parsed.lesson;
    const entries = LessonStore.valid(await this.refresh()).filter(
      (e) => e.store === options.store,
    );
    const duplicate = entries.find(({ meta }) => {
      if (meta.id === lesson.id) return true;
      if (lesson.signature !== undefined && meta.signature === lesson.signature) return true;
      return (
        titleSimilarity(meta.summary, lesson.summary) >= DUPLICATE_THRESHOLD &&
        meta.scope.some((glob) => lesson.scope.includes(glob))
      );
    });

    const usage = await this.readUsage();
    if (duplicate !== undefined) {
      const k = key(options.store, duplicate.meta.id);
      const current = usage.lessons[k] ?? EMPTY_USAGE;
      usage.lessons[k] = {
        ...current,
        recurrences: current.recurrences + 1,
        lastReinforced: this.today(),
        archived: undefined,
      };
      await this.writeUsage(usage);
      const archived = await this.prune();
      return {
        action: 'merged',
        id: duplicate.meta.id,
        store: options.store,
        path: duplicate.file,
        archived,
      };
    }

    const dir = this.dir(options.store);
    await mkdir(dir, { recursive: true });
    if (options.store === 'personal') await this.ensureIgnored(dir);
    await writeAtomic(join(dir, `${lesson.id}.md`), renderLesson(lesson));
    usage.lessons[key(options.store, lesson.id)] = {
      ...EMPTY_USAGE,
      lastReinforced: this.today(),
    };
    await this.writeUsage(usage);
    const archived = await this.prune();
    return {
      action: 'added',
      id: lesson.id,
      store: options.store,
      path: `${STORE_DIRS[options.store]}/${lesson.id}.md`,
      archived,
    };
  }

  private async ensureIgnored(dir: string): Promise<void> {
    const path = join(dir, '.gitignore');
    try {
      await stat(path);
    } catch {
      await writeFile(
        path,
        '# Personal sentinel lessons: never committed (ADR-0008).\n*\n',
        'utf8',
      );
    }
  }

  /**
   * The few lessons that matter for a change, best first. Reads only the index and the
   * returned lesson files, whatever the size of the store.
   */
  async recall(query: RecallQuery): Promise<RecalledLesson[]> {
    const limit = query.limit ?? this.options.settings.recallLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
      throw new LearnError(
        `--limit must be a whole number from 1 to ${String(MAX_RECALL_LIMIT)}`,
        'invalid',
      );
    }
    const paths = (query.paths ?? []).map(normalizePath).filter((p) => p !== '');
    const tags = new Set((query.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    const trimmed = query.signature?.trim();
    const signature = trimmed === '' ? undefined : trimmed;
    if (paths.length === 0 && tags.size === 0 && signature === undefined) {
      throw new LearnError('give --paths, --tags or --signature to recall lessons', 'invalid');
    }

    const entries = LessonStore.valid(await this.refresh());
    const usage = await this.readUsage();
    const scored: {
      entry: IndexEntry & { meta: LessonMeta };
      rank: (number | string)[];
      match: RecalledLesson['match'];
    }[] = [];
    for (const entry of entries) {
      const { meta } = entry;
      const use = usage.lessons[key(entry.store, meta.id)] ?? EMPTY_USAGE;
      if (use.archived !== undefined) continue;
      const tagHit = meta.tags.some((t) => tags.has(t)) ? 1 : 0;
      let tier = 0;
      let specificity = 0;
      let match: RecalledLesson['match'] = 'scope';
      if (signature !== undefined && meta.signature === signature) {
        tier = 3;
        match = 'signature';
      } else if (meta.scope.some(isGlobalGlob)) {
        if (paths.length > 0 || tagHit === 1) {
          tier = 1;
          match = tagHit === 1 ? 'tag' : 'global';
        }
      } else {
        for (const glob of meta.scope) {
          const re = compileGlob(glob);
          if (paths.some((p) => re.test(p))) {
            tier = 2;
            specificity = Math.max(specificity, globSpecificity(glob));
          }
        }
      }
      if (tier === 0) continue;
      const recency = use.lastReinforced ?? meta.created;
      scored.push({
        entry,
        match,
        // Higher is better for every element; recall counts never raise rank (ADR-0008).
        rank: [
          tier,
          tagHit,
          specificity,
          Math.log2(1 + use.recurrences),
          recency,
          entry.store === 'personal' ? 1 : 0,
        ],
      });
    }
    scored.sort((a, b) => compare(b.rank, a.rank) || (a.entry.meta.id < b.entry.meta.id ? -1 : 1));

    const results: RecalledLesson[] = [];
    for (const { entry, match } of scored) {
      if (results.length >= limit) break;
      let text: string;
      try {
        text = await readLessonFile(this.pathOf(entry));
      } catch {
        continue;
      }
      const parsed = parseLesson(text);
      if (parsed.lesson === undefined) continue;
      results.push({ ...parsed.lesson, store: entry.store, path: entry.file, match });
    }

    if (results.length > 0) {
      const today = this.today();
      for (const lesson of results) {
        const k = key(lesson.store, lesson.id);
        const current = usage.lessons[k] ?? EMPTY_USAGE;
        usage.lessons[k] = { ...current, recalls: current.recalls + 1, lastUsed: today };
      }
      await this.writeUsage(usage);
    }
    return results;
  }

  /**
   * Archives, on this machine only, lessons unused for `archiveAfterDays` and the lowest
   * ranked beyond `maxActive`. Nothing is deleted. Returns the ids archived now.
   */
  async prune(): Promise<string[]> {
    const { archiveAfterDays, maxActive } = this.options.settings;
    const entries = LessonStore.valid(await this.refresh());
    const usage = await this.readUsage();
    const today = this.today();
    const known = new Set(entries.map((e) => key(e.store, e.meta.id)));
    const lessons = Object.fromEntries(Object.entries(usage.lessons).filter(([k]) => known.has(k)));
    Object.assign(usage, { lessons });

    const archivedNow: string[] = [];
    const active: { k: string; id: string; rank: (number | string)[] }[] = [];
    for (const { store, meta } of entries) {
      const k = key(store, meta.id);
      const use = usage.lessons[k] ?? EMPTY_USAGE;
      if (use.archived !== undefined) continue;
      const last = [use.lastUsed, use.lastReinforced]
        .filter((d): d is string => d !== undefined)
        .reduce((a, b) => (b > a ? b : a), meta.created);
      if (daysBetween(last, today) > archiveAfterDays) {
        usage.lessons[k] = { ...use, archived: today };
        archivedNow.push(meta.id);
      } else {
        active.push({ k, id: meta.id, rank: [Math.log2(1 + use.recurrences), last, meta.id] });
      }
    }
    if (active.length > maxActive) {
      active.sort((a, b) => compare(a.rank, b.rank));
      for (const item of active.slice(0, active.length - maxActive)) {
        usage.lessons[item.k] = { ...(usage.lessons[item.k] ?? EMPTY_USAGE), archived: today };
        archivedNow.push(item.id);
      }
    }
    await this.writeUsage(usage);
    return archivedNow;
  }

  /** Every lesson with its local usage; archived ones only when asked. */
  async list(options: { archived?: boolean } = {}): Promise<{
    lessons: ListedLesson[];
    invalid: InvalidLesson[];
  }> {
    const entries = await this.refresh();
    const usage = await this.readUsage();
    const lessons: ListedLesson[] = [];
    const invalid: InvalidLesson[] = [];
    for (const entry of entries) {
      if (entry.meta === undefined) {
        invalid.push({ path: entry.file, problems: entry.problems ?? [] });
        continue;
      }
      const use = usage.lessons[key(entry.store, entry.meta.id)] ?? EMPTY_USAGE;
      if ((use.archived !== undefined) !== (options.archived === true)) continue;
      lessons.push({ ...entry.meta, store: entry.store, path: entry.file, usage: use });
    }
    lessons.sort((a, b) => (a.id < b.id ? -1 : 1));
    return { lessons, invalid };
  }

  private async find(id: string): Promise<IndexEntry & { meta: LessonMeta }> {
    const matches = LessonStore.valid(await this.refresh()).filter((e) => e.meta.id === id);
    const found = matches.find((e) => e.store === 'personal') ?? matches[0];
    if (found === undefined) throw new LearnError(`no lesson with id ${id}`);
    return found;
  }

  async show(id: string): Promise<RecalledLesson & { usage: UsageEntry }> {
    const entry = await this.find(id);
    const text = await readLessonFile(this.pathOf(entry));
    const parsed = parseLesson(text);
    if (parsed.lesson === undefined) throw new LearnError(`${entry.file} is not a valid lesson`);
    const usage = await this.readUsage();
    return {
      ...parsed.lesson,
      store: entry.store,
      path: entry.file,
      match: 'scope',
      usage: usage.lessons[key(entry.store, id)] ?? EMPTY_USAGE,
    };
  }

  /** Brings an archived lesson back; it counts as used today. */
  async restore(id: string): Promise<{ id: string; store: StoreName }> {
    const entry = await this.find(id);
    const usage = await this.readUsage();
    const k = key(entry.store, id);
    usage.lessons[k] = {
      ...(usage.lessons[k] ?? EMPTY_USAGE),
      archived: undefined,
      lastUsed: this.today(),
    };
    await this.writeUsage(usage);
    return { id, store: entry.store };
  }

  /** Shared lessons archived on this machine: candidates for a human to delete in a PR. */
  async report(): Promise<ListedLesson[]> {
    return (await this.list({ archived: true })).lessons.filter((l) => l.store === 'shared');
  }

  /** PRs already learned from: cited by a shared lesson, or reviewed on this machine. */
  async learnedPrs(): Promise<Map<number, { lessons: string[]; reviewedAt?: string }>> {
    const learned = new Map<number, { lessons: string[]; reviewedAt?: string }>();
    for (const { store, meta } of LessonStore.valid(await this.refresh())) {
      if (store !== 'shared' || meta.source !== 'pr' || meta.pr === undefined) continue;
      const item = learned.get(meta.pr) ?? { lessons: [] };
      item.lessons.push(meta.id);
      learned.set(meta.pr, item);
    }
    const usage = await this.readUsage();
    for (const [pr, info] of Object.entries(usage.prs)) {
      if (info.reviewedAt === undefined) continue;
      const n = Number(pr);
      const item = learned.get(n) ?? { lessons: [] };
      learned.set(n, { ...item, reviewedAt: info.reviewedAt });
    }
    return learned;
  }

  /** Records PRs as reviewed (`reviewedAt`) or offered (`offeredAt`) today. */
  async markPrs(prs: readonly number[], field: keyof PrUsage): Promise<void> {
    const usage = await this.readUsage();
    for (const pr of prs) {
      usage.prs[String(pr)] = { ...(usage.prs[String(pr)] ?? {}), [field]: this.today() };
    }
    await this.writeUsage(usage);
  }

  /** Lessons carrying a failure signature (any store, archived or not). */
  async withSignature(signature: string): Promise<LessonMeta[]> {
    return LessonStore.valid(await this.refresh())
      .filter((e) => e.meta.signature === signature)
      .map((e) => e.meta);
  }
}
