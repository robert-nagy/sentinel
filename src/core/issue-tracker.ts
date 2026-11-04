import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_FILE_NAME, ConfigError, findRepoConfigPath } from './config.js';
import { TRACKER_SLUG_PATTERN, userConfigSchema, type SentinelConfig } from './config-schema.js';
import type { CommandRunner } from './exec.js';
import type { FileAccess } from './fs.js';

/**
 * Sentinel never talks to remote issue trackers (ADR-0005). The host agent uses the
 * connections it already has (MCP servers, CLIs); this module decides, deterministically,
 * which tracker that should be, and records the decision as intent in the repo config.
 */

/** The tracker sentinel implements itself: Markdown files in the repo. */
export const LOCAL_TRACKER = 'local';

export class TrackerError extends Error {
  constructor(
    message: string,
    /** `unavailable`: the work belongs to a tracker sentinel does not reach (exit code 4). */
    readonly kind: 'invalid' | 'not-found' | 'unavailable' = 'invalid',
  ) {
    super(message);
    this.name = 'TrackerError';
  }
}

/** Common alternative names, mapped to one slug so `--available` and config agree. */
const ALIASES: Readonly<Record<string, string>> = {
  gh: 'github',
  'github-issues': 'github',
  glab: 'gitlab',
  'gitlab-issues': 'gitlab',
  atlassian: 'jira',
  'jira-cloud': 'jira',
  'jira-server': 'jira',
  ado: 'azure-devops',
  azdo: 'azure-devops',
  az: 'azure-devops',
  azure: 'azure-devops',
  'azure-boards': 'azure-devops',
  markdown: LOCAL_TRACKER,
  md: LOCAL_TRACKER,
  files: LOCAL_TRACKER,
};

/** Lower-cases, hyphenates and de-aliases a tracker name (`"Azure Boards"` → `azure-devops`). */
export function normalizeTracker(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const resolved = ALIASES[slug] ?? slug;
  if (!TRACKER_SLUG_PATTERN.test(resolved)) {
    throw new TrackerError(
      `invalid tracker "${raw}": use a lower-case slug such as github, jira, linear or local`,
    );
  }
  return resolved;
}

/** Code forges that also host issues. A remote on one of them is a hint, never a decision. */
export type Forge = 'github' | 'gitlab' | 'azure-devops' | 'bitbucket';

/** Host part of a git remote URL (`https://…`, `ssh://…` or scp-like `git@host:path`). */
export function remoteHost(url: string): string | undefined {
  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : /^[^/@\s]+@[^:/\s]+:/.test(trimmed)
      ? `ssh://${trimmed.replace(':', '/')}`
      : undefined;
  if (withScheme === undefined) return undefined;
  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/** The forge behind a remote URL, recognising self-hosted instances by name. */
export function forgeFromRemote(url: string): Forge | undefined {
  const host = remoteHost(url);
  if (host === undefined) return undefined;
  if (
    host === 'dev.azure.com' ||
    host.endsWith('.visualstudio.com') ||
    host.endsWith('.azure.com')
  ) {
    return 'azure-devops';
  }
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.includes('bitbucket')) return 'bitbucket';
  return undefined;
}

/** Removes credentials (`https://token@host/…`) so a remote URL is safe to print. */
export function redactRemote(url: string): string {
  return url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/i, '$1');
}

export interface TrackerOption {
  readonly tracker: string;
  /** False when the agent reported it cannot reach this tracker. */
  readonly reachable: boolean;
}

export type TrackerDecision =
  | {
      readonly action: 'use';
      readonly tracker: string;
      readonly source: 'config' | 'detected';
      /** True when the choice is not saved yet: offer `sentinel issue use <tracker>`. */
      readonly offerToSave: boolean;
      readonly reason: string;
    }
  | {
      readonly action: 'ask';
      readonly options: readonly TrackerOption[];
      readonly recommended?: string | undefined;
      readonly reason: string;
    }
  | {
      readonly action: 'fallback';
      readonly tracker: typeof LOCAL_TRACKER;
      readonly offerToSave: true;
      readonly reason: string;
    }
  | { readonly action: 'unavailable'; readonly tracker: string; readonly reason: string };

export interface ResolveTrackerInput {
  /** `issueProvider.tracker` from the effective config. */
  readonly configured: string | null;
  /**
   * Trackers the agent can reach right now. `undefined` means the caller did not say, in
   * which case a configured tracker is trusted as-is.
   */
  readonly available?: readonly string[] | undefined;
  /** Forge of the repo's git remote, if recognised. */
  readonly remoteForge?: Forge | undefined;
}

/**
 * The resolution rule (ADR-0005, PLAN §4):
 *
 * 1. configured → use it, or `unavailable` if the agent says it cannot reach it;
 * 2. exactly one reachable that does not conflict with the remote's forge → use it;
 * 3. several reachable, or the only one conflicts with the remote's forge → ask the user;
 * 4. none reachable → fall back to the local markdown tracker.
 */
export function resolveTracker(input: ResolveTrackerInput): TrackerDecision {
  const available =
    input.available === undefined
      ? undefined
      : [...new Set(input.available.map(normalizeTracker))].filter((t) => t !== LOCAL_TRACKER);
  const forge = input.remoteForge;

  if (input.configured !== null) {
    const tracker = normalizeTracker(input.configured);
    if (tracker === LOCAL_TRACKER || available === undefined || available.includes(tracker)) {
      return {
        action: 'use',
        tracker,
        source: 'config',
        offerToSave: false,
        reason: `issueProvider.tracker is set to ${tracker}`,
      };
    }
    return {
      action: 'unavailable',
      tracker,
      reason: `issueProvider.tracker is ${tracker}, but no ${tracker} connection is reachable; ask the user to connect one (MCP server or CLI) or change the tracker with \`sentinel issue use\``,
    };
  }

  const reachable = available ?? [];
  if (reachable.length === 0) {
    return {
      action: 'fallback',
      tracker: LOCAL_TRACKER,
      offerToSave: true,
      reason:
        forge === undefined
          ? 'no tracker is configured or reachable; using the local markdown tracker'
          : `no tracker is configured or reachable (the remote is on ${forge}, but no ${forge} connection is reachable); using the local markdown tracker`,
    };
  }

  const only = reachable.length === 1 ? reachable[0] : undefined;
  if (only !== undefined && (forge === undefined || forge === only)) {
    return {
      action: 'use',
      tracker: only,
      source: 'detected',
      offerToSave: true,
      reason:
        forge === only
          ? `${only} is the only reachable tracker and matches the git remote`
          : `${only} is the only reachable tracker`,
    };
  }

  const ordered = [...reachable].sort((a, b) =>
    a === forge ? -1 : b === forge ? 1 : a.localeCompare(b),
  );
  const options: TrackerOption[] = ordered.map((tracker) => ({ tracker, reachable: true }));
  if (forge !== undefined && !reachable.includes(forge)) {
    options.unshift({ tracker: forge, reachable: false });
  }
  options.push({ tracker: LOCAL_TRACKER, reachable: true });
  return {
    action: 'ask',
    options,
    recommended: forge,
    reason:
      only !== undefined
        ? `${only} is reachable, but the git remote is on ${String(forge)}, which may be where issues live`
        : `several trackers are reachable: ${reachable.join(', ')}`,
  };
}

/** The neutral operations skills use; the agent performs them with its own tools. */
export const TRACKER_VERBS = [
  { verb: 'get', meaning: 'read one issue: id, title, body, labels or type, status' },
  { verb: 'list', meaning: 'find issues by text, label or status' },
  {
    verb: 'dedupe',
    meaning:
      'before create: list likely matches, then rank them with `sentinel issue duplicates <title> --candidates <file>`',
  },
  { verb: 'create', meaning: 'file an issue, mapping labels, type and priority via labelMap' },
  { verb: 'comment', meaning: 'add a comment to an issue' },
  { verb: 'set-status', meaning: 'move an issue to labelMap["status/<name>"], e.g. In Progress' },
  {
    verb: 'link-pr',
    meaning: 'connect a pull request (tracker link, or "Fixes <id>" in the PR body)',
  },
  { verb: 'close', meaning: 'close or resolve an issue' },
] as const;

/** CLI commands for the local tracker, keyed by verb. */
const LOCAL_COMMANDS: Readonly<Record<string, string>> = {
  get: 'sentinel issue get <id>',
  list: 'sentinel issue list [--status open|closed|all] [--label <label>] [--text <text>]',
  dedupe: 'sentinel issue duplicates <title>',
  create: 'sentinel issue create --title <title> [--body <text>] [--label <label>]',
  comment: 'sentinel issue comment <id> --body <text>',
  'set-status': 'sentinel issue label <id> --add <status label> (or close it)',
  'link-pr': 'sentinel issue comment <id> --body "PR: <url>", and "Fixes #<id>" in the PR body',
  close: 'sentinel issue close <id>',
};

export interface TrackerDescription {
  readonly tracker: string | null;
  readonly location: string | null;
  readonly notes: string | null;
  readonly labelMap: Readonly<Record<string, string>>;
  readonly localDir?: string | undefined;
  readonly verbs: readonly {
    readonly verb: string;
    readonly meaning: string;
    readonly command?: string;
  }[];
}

/** Agent-facing description of the configured tracker (`sentinel issue describe`). */
export function describeTracker(section: SentinelConfig['issueProvider']): TrackerDescription {
  const tracker = section.tracker === null ? null : normalizeTracker(section.tracker);
  const isLocal = tracker === LOCAL_TRACKER;
  return {
    tracker,
    location: section.location,
    notes: section.notes,
    labelMap: section.labelMap,
    ...(isLocal ? { localDir: section.localDir } : {}),
    verbs: TRACKER_VERBS.map((v) =>
      isLocal ? { ...v, command: LOCAL_COMMANDS[v.verb] ?? '' } : { ...v },
    ),
  };
}

export function formatTrackerDescription(d: TrackerDescription): string {
  const lines: string[] = [];
  if (d.tracker === null) {
    lines.push(
      'No issue tracker is configured. Run `sentinel issue resolve --available <trackers you can reach>` first.',
    );
  } else if (d.tracker === LOCAL_TRACKER) {
    lines.push(`Issues are tracked locally as Markdown files in ${d.localDir ?? 'docs/issues'}/.`);
  } else {
    lines.push(
      `Issues are tracked in ${d.tracker}. Use your own ${d.tracker} tools (MCP server or CLI); sentinel does not call ${d.tracker}.`,
    );
  }
  if (d.location !== null) lines.push(`Location: ${d.location}`);
  if (d.notes !== null) lines.push(`Notes: ${d.notes}`);
  const labels = Object.entries(d.labelMap);
  if (labels.length > 0) {
    lines.push('', 'Label map (neutral → tracker):');
    for (const [neutral, native] of labels) lines.push(`  ${neutral} → ${native}`);
  }
  lines.push('', 'Operations:');
  for (const v of d.verbs) {
    lines.push(`  ${v.verb.padEnd(10)} ${v.meaning}`);
    if (v.command !== undefined && v.command !== '')
      lines.push(`  ${''.padEnd(10)} $ ${v.command}`);
  }
  return lines.join('\n');
}

/** Tracker CLIs sentinel can see on PATH. Installed is a hint, not proof of authentication. */
export const TRACKER_CLIS = [
  { tracker: 'github', command: 'gh' },
  { tracker: 'gitlab', command: 'glab' },
  { tracker: 'azure-devops', command: 'az' },
  { tracker: 'jira', command: 'jira' },
  { tracker: 'linear', command: 'linear' },
] as const;

export interface TrackerHints {
  readonly remote?: { readonly url: string; readonly forge?: Forge | undefined } | undefined;
  readonly clis: readonly {
    readonly tracker: string;
    readonly command: string;
    readonly installed: boolean;
  }[];
}

const HINT_TIMEOUT_MS = 10_000;

/** What sentinel itself can observe: the git remote and tracker CLIs on PATH. */
export async function detectTrackerHints(run: CommandRunner, cwd: string): Promise<TrackerHints> {
  const remoteUrl = async (): Promise<string | undefined> => {
    const origin = await run('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeoutMs: HINT_TIMEOUT_MS,
    });
    if (origin.exitCode === 0 && origin.stdout.trim() !== '') return origin.stdout.trim();
    const names = await run('git', ['remote'], { cwd, timeoutMs: HINT_TIMEOUT_MS });
    const first = names.exitCode === 0 ? names.stdout.split('\n')[0]?.trim() : undefined;
    if (first === undefined || first === '') return undefined;
    const url = await run('git', ['remote', 'get-url', first], { cwd, timeoutMs: HINT_TIMEOUT_MS });
    return url.exitCode === 0 && url.stdout.trim() !== '' ? url.stdout.trim() : undefined;
  };
  const [url, clis] = await Promise.all([
    remoteUrl(),
    Promise.all(
      TRACKER_CLIS.map(async ({ tracker, command }) => {
        const result = await run(command, ['--version'], { cwd, timeoutMs: HINT_TIMEOUT_MS });
        return { tracker, command, installed: !result.notFound && result.exitCode === 0 };
      }),
    ),
  ]);
  return {
    remote: url === undefined ? undefined : { url: redactRemote(url), forge: forgeFromRemote(url) },
    clis,
  };
}

export interface SaveTrackerChoice {
  readonly tracker: string;
  readonly location?: string | undefined;
  readonly notes?: string | undefined;
  readonly labelMap?: Readonly<Record<string, string>> | undefined;
}

/**
 * Records the tracker in the repo's `sentinel.config.json` (created at `repoRoot` if there
 * is none), leaving every other key untouched. Returns the file written.
 */
export async function saveTrackerChoice(
  cwd: string,
  repoRoot: string,
  files: FileAccess,
  choice: SaveTrackerChoice,
): Promise<string> {
  const path = (await findRepoConfigPath(cwd, files)) ?? join(repoRoot, CONFIG_FILE_NAME);
  let existing: Record<string, unknown> = {};
  let text: string | undefined;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`${path} is not valid JSON: ${reason}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ConfigError(`${path} must contain a JSON object`);
    }
    existing = parsed as Record<string, unknown>;
  }

  const previous =
    typeof existing.issueProvider === 'object' && existing.issueProvider !== null
      ? (existing.issueProvider as Record<string, unknown>)
      : {};
  const previousLabels =
    typeof previous.labelMap === 'object' && previous.labelMap !== null
      ? (previous.labelMap as Record<string, unknown>)
      : {};
  const issueProvider: Record<string, unknown> = {
    ...previous,
    tracker: normalizeTracker(choice.tracker),
  };
  if (choice.location !== undefined) issueProvider.location = choice.location;
  if (choice.notes !== undefined) issueProvider.notes = choice.notes;
  if (choice.labelMap !== undefined && Object.keys(choice.labelMap).length > 0) {
    issueProvider.labelMap = { ...previousLabels, ...choice.labelMap };
  }
  const next = { ...existing, issueProvider };

  const check = userConfigSchema.safeParse(next);
  if (!check.success) {
    const problems = check.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`refusing to write ${path}: ${problems}`);
  }
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return path;
}
