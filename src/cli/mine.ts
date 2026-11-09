import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { rankDuplicates } from '../core/duplicates.js';
import { ghError } from '../core/hosts/github.js';
import { LOCAL_TRACKER, normalizeTracker } from '../core/issue-tracker.js';
import { LocalTracker } from '../core/local-tracker.js';
import {
  MiningError,
  findingsSchema,
  issueDraftFor,
  markCreated,
  mergeFindings,
  parseGapFile,
  parseRepoSearch,
  renderGapFile,
} from '../core/mining.js';
import { findRepoRoot } from '../core/repo.js';
import { resolveInside, writeNewFile } from '../core/scaffold.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { parseCandidates } from './issue.js';
import { guarded } from './safe.js';

const DEFAULT_OUT = 'docs/feature-gaps.md';
const GH_TIMEOUT_MS = 60_000;

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new MiningError(`${name} must be a whole number`);
  return n;
}

export function registerMine(program: Command, deps: CliDeps): void {
  const mine = program.command('mine').description('Find feature gaps in comparable projects');

  mine
    .command('search')
    .description('Find popular comparable repositories with gh (sorted by stars)')
    .argument('<query...>', 'search terms')
    .option('--min-stars <n>', 'drop repositories with fewer stars', '500')
    .option('--limit <n>', 'how many repositories to ask gh for', '10')
    .option('--language <name>', 'only this language')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (
          query: string[],
          options: { minStars: string; limit: string; language?: string; json?: boolean },
        ) => {
          const minStars = positiveInt(options.minStars, '--min-stars');
          const limit = positiveInt(options.limit, '--limit');
          const args = [
            'search',
            'repos',
            ...query,
            '--sort',
            'stars',
            '--order',
            'desc',
            '--limit',
            String(Math.min(Math.max(limit, 1), 50)),
            '--json',
            'fullName,description,stargazersCount,url,language,license',
          ];
          if (options.language !== undefined) args.push('--language', options.language);
          const result = await deps.run('gh', args, { cwd: deps.cwd, timeoutMs: GH_TIMEOUT_MS });
          if (result.exitCode !== 0) throw ghError(result, 'search repositories');
          const repos = parseRepoSearch(result.stdout, minStars);
          deps.stdout(
            options.json === true
              ? JSON.stringify(repos, null, 2)
              : repos.length === 0
                ? 'no repositories matched'
                : repos.map((r) => `${String(r.stars)}\t${r.fullName}\t${r.description}`).join('\n'),
          );
        },
      ),
    );

  mine
    .command('draft')
    .description('Write the gap list that a human approves, from findings you collected')
    .requiredOption(
      '--findings <file>',
      'JSON array of {"title","summary","sources"?,"priority"?} objects',
    )
    .option('--out <file>', 'where to write the gap list', DEFAULT_OUT)
    .option('--force', 'overwrite an existing gap list')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (options: { findings: string; out: string; force?: boolean; json?: boolean }) => {
          let json: unknown;
          try {
            json = JSON.parse(await readFile(resolve(deps.cwd, options.findings), 'utf8'));
          } catch {
            throw new MiningError(`${options.findings} is missing or not valid JSON`);
          }
          const parsed = findingsSchema.safeParse(json);
          if (!parsed.success) {
            const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
            throw new MiningError(`${options.findings} is not a list of findings: ${detail.join('; ')}`);
          }
          const findings = mergeFindings(parsed.data);
          const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
          const path = resolveInside(root, '.', options.out);
          await writeNewFile(path, renderGapFile(findings), options.force === true);
          deps.stdout(
            options.json === true
              ? JSON.stringify({ path, gaps: findings.length }, null, 2)
              : `${path}\n${String(findings.length)} gaps written; tick the ones to file, then run mine create`,
          );
        },
      ),
    );

  mine
    .command('create')
    .description('File the approved gaps as issues, skipping likely duplicates')
    .requiredOption('--approved <file>', 'the gap list, with approved gaps ticked [x]')
    .option('--candidates <file>', 'JSON of existing issues ({"id","title"}), listed with your own tracker tools')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { approved: string; candidates?: string; json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const gapPath = resolve(deps.cwd, options.approved);
        let markdown = await deps.files.readText(gapPath);
        if (markdown === undefined) throw new MiningError(`gap list not found: ${options.approved}`);

        const tracker = config.issueProvider.tracker;
        const isLocal = tracker !== null && normalizeTracker(tracker) === LOCAL_TRACKER;
        const localDir = config.issueProvider.localDir;
        const local = isLocal
          ? new LocalTracker(isAbsolute(localDir) ? localDir : join(root, localDir), deps.now)
          : undefined;

        let candidates: { id: string; title: string }[] = [];
        if (options.candidates !== undefined) {
          candidates = parseCandidates(
            await readFile(resolve(deps.cwd, options.candidates), 'utf8'),
            options.candidates,
          );
        } else if (local !== undefined) {
          candidates = (await local.list({ status: 'all' })).map((i) => ({
            id: String(i.id),
            title: i.title,
          }));
        } else {
          deps.stderr(
            'sentinel: no --candidates given, so duplicates cannot be checked; list the existing issues with your tracker tools and pass them',
          );
        }

        const gaps = parseGapFile(markdown);
        const toCreate: ReturnType<typeof issueDraftFor>[] = [];
        const skipped: { title: string; duplicateOf: { id: string; title: string }[] }[] = [];
        const created: { title: string; id: string }[] = [];
        // Highest line first, so inserting a `Created:` line does not shift the others.
        for (const gap of [...gaps].sort((a, b) => b.lineIndex - a.lineIndex)) {
          if (!gap.approved || gap.created !== undefined) continue;
          const duplicates = rankDuplicates(gap.title, candidates);
          if (duplicates.length > 0) {
            skipped.push({ title: gap.title, duplicateOf: duplicates });
            continue;
          }
          const draft = issueDraftFor(gap);
          if (local === undefined) {
            toCreate.push(draft);
          } else {
            const made = await local.create({ title: draft.title, body: draft.body, labels: [...draft.labels] });
            created.push({ title: draft.title, id: String(made.id) });
            markdown = markCreated(markdown, gap.lineIndex, `#${String(made.id)}`);
          }
        }
        if (created.length > 0) await writeFile(gapPath, markdown, 'utf8');

        const result = {
          tracker: tracker ?? null,
          toCreate: toCreate.reverse(),
          created: created.reverse(),
          skippedDuplicates: skipped.reverse(),
        };
        if (options.json === true) {
          deps.stdout(JSON.stringify(result, null, 2));
        } else {
          for (const item of result.created) deps.stdout(`created #${item.id}: ${item.title}`);
          for (const item of result.toCreate) deps.stdout(`to file with your tracker tools: ${item.title}`);
          for (const item of result.skippedDuplicates) {
            deps.stdout(`skipped (similar to ${item.duplicateOf.map((d) => d.id).join(', ')}): ${item.title}`);
          }
          if (gaps.every((g) => !g.approved)) deps.stdout('nothing approved: tick a gap with [x] first');
        }
      }),
    );
}
