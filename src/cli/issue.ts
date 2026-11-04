import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { SentinelConfig } from '../core/config-schema.js';
import { ExitCode } from '../core/exit-codes.js';
import {
  LOCAL_TRACKER,
  TrackerError,
  describeTracker,
  detectTrackerHints,
  formatTrackerDescription,
  normalizeTracker,
  resolveTracker,
  saveTrackerChoice,
  type TrackerDecision,
  type TrackerHints,
} from '../core/issue-tracker.js';
import { rankDuplicates } from '../core/duplicates.js';
import { LocalTracker, type LocalIssue, type LocalIssueStatus } from '../core/local-tracker.js';
import { findRepoRoot } from '../core/repo.js';
import { collect, loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

/** `--available github,linear --available jira` → `['github', 'linear', 'jira']`. */
export function splitList(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** `--label kind/bug=Bug` → `{ 'kind/bug': 'Bug' }`. */
export function parseLabelPairs(values: readonly string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of values ?? []) {
    const index = pair.indexOf('=');
    const neutral = index === -1 ? '' : pair.slice(0, index).trim();
    const native = index === -1 ? '' : pair.slice(index + 1).trim();
    if (neutral === '' || native === '') {
      throw new TrackerError(`invalid --label "${pair}": use neutral=native, e.g. kind/bug=Bug`);
    }
    map[neutral] = native;
  }
  return map;
}

/** Candidates for `issue duplicates`: `[{"id": "PROJ-1", "title": "…"}]` or `["…"]`. */
export function parseCandidates(text: string, source: string): { id: string; title: string }[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new TrackerError(`${source} is not valid JSON`);
  }
  if (!Array.isArray(json)) throw new TrackerError(`${source} must contain a JSON array`);
  return json.map((item: unknown, index) => {
    if (typeof item === 'string') return { id: String(index + 1), title: item };
    if (typeof item === 'object' && item !== null) {
      const { id, title } = item as { id?: unknown; title?: unknown };
      if (typeof title === 'string' && (typeof id === 'string' || typeof id === 'number')) {
        return { id: String(id), title };
      }
    }
    throw new TrackerError(
      `${source}[${String(index)}] must be a title or an object with "id" and "title"`,
    );
  });
}

async function repoRootOf(deps: CliDeps): Promise<string> {
  const root = await findRepoRoot(deps.cwd, deps.files);
  if (root === undefined) throw new TrackerError('not inside a git repository');
  return root;
}

function formatDecision(decision: TrackerDecision): string {
  switch (decision.action) {
    case 'use':
      return [
        `use ${decision.tracker}`,
        `  ${decision.reason}`,
        ...(decision.offerToSave
          ? [`  not saved yet: offer \`sentinel issue use ${decision.tracker}\``]
          : []),
      ].join('\n');
    case 'ask':
      return [
        'ask the user which tracker to use, then save it with `sentinel issue use <tracker>`',
        `  ${decision.reason}`,
        ...decision.options.map(
          (o) =>
            `  - ${o.tracker}${o.tracker === decision.recommended ? ' (recommended)' : ''}${o.reachable ? '' : ' (not reachable yet)'}`,
        ),
      ].join('\n');
    case 'fallback':
      return [
        `fallback ${decision.tracker}`,
        `  ${decision.reason}`,
        '  offer `sentinel issue use local` to save it',
      ].join('\n');
    case 'unavailable':
      return [`unavailable ${decision.tracker}`, `  ${decision.reason}`].join('\n');
  }
}

/** The local tracker, or an error telling the agent to use its own tools for this tracker. */
async function localTracker(deps: CliDeps, config: SentinelConfig): Promise<LocalTracker> {
  const configured = config.issueProvider.tracker;
  if (configured !== null && normalizeTracker(configured) !== LOCAL_TRACKER) {
    throw new TrackerError(
      `issues for this repo live in ${normalizeTracker(configured)}; use your own ${normalizeTracker(configured)} tools (see \`sentinel issue describe\`). These commands only manage the local tracker.`,
      'unavailable',
    );
  }
  const dir = config.issueProvider.localDir;
  const root = await repoRootOf(deps);
  return new LocalTracker(isAbsolute(dir) ? dir : join(root, dir), deps.now);
}

function printIssue(deps: CliDeps, issue: LocalIssue, json: boolean | undefined): void {
  if (json === true) {
    deps.stdout(JSON.stringify(issue, null, 2));
    return;
  }
  const lines = [
    `#${String(issue.id)} ${issue.title}`,
    `status: ${issue.status}${issue.labels.length > 0 ? `  labels: ${issue.labels.join(', ')}` : ''}`,
  ];
  if (issue.body !== '') lines.push('', issue.body);
  for (const c of issue.comments) lines.push('', `— ${c.at}`, c.body);
  deps.stdout(lines.join('\n'));
}

async function readBody(
  deps: CliDeps,
  options: { body?: string | undefined; bodyFile?: string | undefined },
): Promise<string | undefined> {
  if (options.bodyFile !== undefined) {
    return readFile(resolve(deps.cwd, options.bodyFile), 'utf8');
  }
  return options.body;
}

export function registerIssue(program: Command, deps: CliDeps): void {
  const issue = program
    .command('issue')
    .description(
      'Issue tracker: decide which tracker to use (your agent reaches it with its own tools), or manage the local tracker',
    );

  issue
    .command('resolve')
    .description('Decide which tracker to use, from the config and the trackers you can reach')
    .option(
      '--available <trackers>',
      'trackers the agent can reach, comma-separated or repeated (default: tracker CLIs on PATH)',
      collect,
    )
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { available?: string[]; json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const hints = await detectTrackerHints(deps.run, deps.cwd);
        const reported = splitList(options.available);
        const available = reported ?? hints.clis.filter((c) => c.installed).map((c) => c.tracker);
        const decision = resolveTracker({
          configured: config.issueProvider.tracker,
          available:
            reported === undefined && config.issueProvider.tracker !== null ? undefined : available,
          remoteForge: hints.remote?.forge,
        });
        const availableSource = reported === undefined ? 'detected-clis' : 'reported';
        deps.stdout(
          options.json === true
            ? JSON.stringify({ ...decision, availableSource, available }, null, 2)
            : formatDecision(decision),
        );
        if (decision.action === 'unavailable') deps.setExitCode(ExitCode.Provider);
      }),
    );

  issue
    .command('detect')
    .description('Show what sentinel can see: the git remote and tracker CLIs on PATH')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { json?: boolean }) => {
        const hints: TrackerHints = await detectTrackerHints(deps.run, deps.cwd);
        if (options.json === true) {
          deps.stdout(JSON.stringify(hints, null, 2));
          return;
        }
        const lines = [
          hints.remote === undefined
            ? 'remote: none'
            : `remote: ${hints.remote.url}${hints.remote.forge === undefined ? '' : ` (${hints.remote.forge})`}`,
          ...hints.clis.map(
            (c) =>
              `${c.command.padEnd(7)} ${c.installed ? 'installed' : 'not found'}  → ${c.tracker}`,
          ),
        ];
        deps.stdout(lines.join('\n'));
      }),
    );

  issue
    .command('use')
    .description("Save the repo's tracker to sentinel.config.json")
    .argument('<tracker>', 'github, gitlab, jira, linear, azure-devops, local, …')
    .option('--location <text>', 'where the work lives, e.g. "Jira project PROJ" or "team ENG"')
    .option('--notes <text>', 'free-form guidance for the agent')
    .option('--label <neutral=native>', 'label mapping, e.g. kind/bug=Bug (repeatable)', collect)
    .action(
      guarded(
        deps,
        async (
          tracker: string,
          options: { location?: string; notes?: string; label?: string[] },
        ) => {
          const root = await repoRootOf(deps);
          const path = await saveTrackerChoice(deps.cwd, root, deps.files, {
            tracker,
            location: options.location,
            notes: options.notes,
            labelMap: parseLabelPairs(options.label),
          });
          deps.stdout(`saved issueProvider.tracker = ${normalizeTracker(tracker)} in ${path}`);
        },
      ),
    );

  issue
    .command('describe')
    .description('Agent-facing instructions for the configured tracker')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const description = describeTracker(config.issueProvider);
        deps.stdout(
          options.json === true
            ? JSON.stringify(description, null, 2)
            : formatTrackerDescription(description),
        );
      }),
    );

  issue
    .command('duplicates')
    .description(
      'Rank existing issues whose title looks like <title> (candidates from a file, or the local tracker)',
    )
    .argument('<title>', 'title of the issue you are about to create')
    .option(
      '--candidates <file>',
      'JSON array of {"id","title"} objects (or plain titles), listed with your own tracker tools',
    )
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (title: string, options: { candidates?: string; json?: boolean }) => {
        let candidates: { id: string; title: string }[];
        if (options.candidates !== undefined) {
          candidates = parseCandidates(
            await readFile(resolve(deps.cwd, options.candidates), 'utf8'),
            options.candidates,
          );
        } else {
          const { config } = await loadCliConfig(deps);
          const open = await (await localTracker(deps, config)).list({ status: 'open' });
          candidates = open.map((i) => ({ id: String(i.id), title: i.title }));
        }
        const ranked = rankDuplicates(title, candidates);
        deps.stdout(
          options.json === true
            ? JSON.stringify(ranked, null, 2)
            : ranked.length === 0
              ? 'no similar issues found'
              : ranked.map((c) => `${c.id}\t${c.title}`).join('\n'),
        );
      }),
    );

  // Local tracker commands.

  issue
    .command('create')
    .description('Create a local issue')
    .requiredOption('--title <title>', 'issue title')
    .option('--body <text>', 'issue body (Markdown)')
    .option('--body-file <path>', 'read the body from a file')
    .option('--label <label>', 'label (repeatable)', collect)
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (options: {
          title: string;
          body?: string;
          bodyFile?: string;
          label?: string[];
          json?: boolean;
        }) => {
          const { config } = await loadCliConfig(deps);
          const tracker = await localTracker(deps, config);
          const created = await tracker.create({
            title: options.title,
            body: await readBody(deps, options),
            labels: options.label,
          });
          deps.stdout(
            options.json === true
              ? JSON.stringify(created, null, 2)
              : `created #${String(created.id)} ${created.path}`,
          );
        },
      ),
    );

  issue
    .command('get')
    .description('Show a local issue')
    .argument('<id>', 'issue number, e.g. 3 or #3')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (id: string, options: { json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        printIssue(deps, await (await localTracker(deps, config)).get(id), options.json);
      }),
    );

  issue
    .command('list')
    .description('List local issues')
    .option('--status <status>', 'open, closed or all', 'open')
    .option('--label <label>', 'only issues with this label (repeatable)', collect)
    .option('--text <text>', 'only issues whose title or body contains this text')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (options: { status: string; label?: string[]; text?: string; json?: boolean }) => {
          if (!['open', 'closed', 'all'].includes(options.status)) {
            throw new TrackerError(`invalid --status "${options.status}": use open, closed or all`);
          }
          const { config } = await loadCliConfig(deps);
          const issues = await (
            await localTracker(deps, config)
          ).list({
            status: options.status as LocalIssueStatus | 'all',
            labels: options.label,
            text: options.text,
          });
          deps.stdout(
            options.json === true
              ? JSON.stringify(issues, null, 2)
              : issues
                  .map(
                    (i) =>
                      `#${String(i.id)}  ${i.status.padEnd(6)}  ${i.title}${i.labels.length > 0 ? `  [${i.labels.join(', ')}]` : ''}`,
                  )
                  .join('\n'),
          );
        },
      ),
    );

  issue
    .command('comment')
    .description('Comment on a local issue')
    .argument('<id>', 'issue number')
    .option('--body <text>', 'comment (Markdown)')
    .option('--body-file <path>', 'read the comment from a file')
    .action(
      guarded(deps, async (id: string, options: { body?: string; bodyFile?: string }) => {
        const body = await readBody(deps, options);
        if (body === undefined) throw new TrackerError('pass --body or --body-file');
        const { config } = await loadCliConfig(deps);
        const updated = await (await localTracker(deps, config)).comment(id, body);
        deps.stdout(`commented on #${String(updated.id)}`);
      }),
    );

  issue
    .command('label')
    .description('Add or remove labels on a local issue (statuses are labels here)')
    .argument('<id>', 'issue number')
    .option('--add <label>', 'label to add (repeatable)', collect)
    .option('--remove <label>', 'label to remove (repeatable)', collect)
    .action(
      guarded(deps, async (id: string, options: { add?: string[]; remove?: string[] }) => {
        const { config } = await loadCliConfig(deps);
        const updated = await (
          await localTracker(deps, config)
        ).label(id, { add: options.add, remove: options.remove });
        deps.stdout(`#${String(updated.id)} labels: ${updated.labels.join(', ') || '(none)'}`);
      }),
    );

  for (const [name, status] of [
    ['close', 'closed'],
    ['reopen', 'open'],
  ] as const) {
    issue
      .command(name)
      .description(`${name === 'close' ? 'Close' : 'Reopen'} a local issue`)
      .argument('<id>', 'issue number')
      .action(
        guarded(deps, async (id: string) => {
          const { config } = await loadCliConfig(deps);
          const updated = await (await localTracker(deps, config)).setStatus(id, status);
          deps.stdout(`#${String(updated.id)} is ${updated.status}`);
        }),
      );
  }
}
