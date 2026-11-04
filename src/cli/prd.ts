import { createHash } from 'node:crypto';
import { basename, extname, resolve } from 'node:path';
import type { Command } from 'commander';
import { normalizeIssueId, slugify } from '../core/branch-namer.js';
import { ExitCode } from '../core/exit-codes.js';
import { findRepoRoot } from '../core/repo.js';
import { fillTemplate, resolveInside, writeNewFile } from '../core/scaffold.js';
import { PRD_TEMPLATE } from '../templates/prd-template.js';
import { formatRubric } from '../templates/prd-rubric.js';
import { evaluationsBefore, PrdError, recordEvaluation, type PrdState } from '../core/prd-state.js';
import {
  DIMENSIONS,
  scoresSchema,
  validatePrd,
  type NextAction,
  type PrdReport,
  type Scores,
} from '../core/prd-validator.js';
import { StateStore } from '../core/state.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

const EXIT: Record<NextAction, number> = {
  accept: ExitCode.Ok,
  refine: ExitCode.Refine,
  score: ExitCode.Refine,
  escalate: ExitCode.Escalate,
};

function slugFor(file: string, explicit: string | undefined): string {
  const slug = slugify(explicit ?? basename(file, extname(file)), 60);
  if (slug === '') throw new PrdError('cannot derive a slug; pass --slug');
  return slug;
}

async function readScores(path: string, deps: CliDeps): Promise<Scores> {
  const text = await deps.files.readText(resolve(deps.cwd, path));
  if (text === undefined) throw new PrdError(`scores file not found: ${path}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PrdError(`${path} is not valid JSON`);
  }
  const parsed = scoresSchema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new PrdError(
      `${path} must be {${DIMENSIONS.map((d) => `"${d}": 0-100`).join(', ')}}: ${detail.join('; ')}`,
    );
  }
  return parsed.data;
}

function formatReport(report: PrdReport, slug: string): string {
  const lines = [`PRD ${slug}: ${report.nextAction.toUpperCase()}`];
  lines.push(
    `  ${String(report.stats.functionalRequirements)} functional and ${String(report.stats.nonFunctionalRequirements)} non-functional requirements`,
  );
  if (report.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of report.issues) {
      const where = issue.line === undefined ? '' : `line ${String(issue.line)}: `;
      lines.push(`  - ${where}${issue.message}`);
    }
  }
  lines.push('', 'Dimension       cap  score');
  for (const d of DIMENSIONS) {
    const effective = report.effectiveScores?.[d];
    lines.push(
      `  ${d.padEnd(13)} ${String(report.caps[d]).padStart(4)}  ${effective === undefined ? '-' : String(effective)}`,
    );
  }
  if (report.mean !== undefined) {
    lines.push(`  mean ${String(report.mean)}, lowest ${String(report.min ?? 0)}`);
  }
  lines.push('', report.message);
  return lines.join('\n');
}

export function registerPrd(program: Command, deps: CliDeps): void {
  const prd = program.command('prd').description('Product requirements documents');

  prd
    .command('validate')
    .description(
      'Check a PRD: structure, ambiguity, score caps and the accept / refine / escalate decision',
    )
    .argument('<file>', 'PRD markdown file')
    .option('--scores <file>', 'JSON file with the five self-scores (0-100)')
    .option('--slug <slug>', 'name for the iteration state (default: file name)')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (file: string, options: { scores?: string; slug?: string; json?: boolean }) => {
          const markdown = await deps.files.readText(resolve(deps.cwd, file));
          if (markdown === undefined) throw new PrdError(`PRD file not found: ${file}`);
          const scores =
            options.scores === undefined ? undefined : await readScores(options.scores, deps);
          const slug = slugFor(file, options.slug);
          const { config } = await loadCliConfig(deps);
          const store = new StateStore((await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd);
          const stateName = `prd-${slug}`;
          const previous = await store.read<PrdState>(stateName);
          const hash = createHash('sha256')
            .update(markdown)
            .update(JSON.stringify(scores ?? null))
            .digest('hex');

          const report = validatePrd(markdown, {
            scores,
            config,
            evaluationsBefore:
              scores === undefined
                ? (previous?.evaluations ?? 0)
                : evaluationsBefore(previous, hash),
          });
          if (scores !== undefined) {
            await store.write(
              stateName,
              recordEvaluation(previous, slug, hash, report, deps.now()),
            );
          }
          deps.stdout(
            options.json === true
              ? JSON.stringify({ slug, ...report }, null, 2)
              : formatReport(report, slug),
          );
          deps.setExitCode(EXIT[report.nextAction]);
        },
      ),
    );

  prd
    .command('new')
    .description('Create a PRD from the IEEE 29148-aligned template')
    .argument('<slug>', 'short name; also the file name')
    .option('--title <title>', 'PRD title (default: the slug)')
    .option('--issue <id>', 'issue the PRD belongs to')
    .option('--force', 'overwrite an existing PRD')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (
          rawSlug: string,
          options: { title?: string; issue?: string; force?: boolean; json?: boolean },
        ) => {
          const slug = slugify(rawSlug, 60);
          if (slug === '') throw new PrdError(`"${rawSlug}" cannot be turned into a slug`);
          const { config } = await loadCliConfig(deps);
          const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
          const path = resolveInside(root, config.prd.dir, `${slug}.md`);
          const content = fillTemplate(PRD_TEMPLATE, {
            TITLE: options.title?.trim() || rawSlug.trim(),
            SLUG: slug,
            ISSUE: options.issue === undefined ? 'none' : `#${normalizeIssueId(options.issue)}`,
            DATE: deps.now().toISOString().slice(0, 10),
          });
          await writeNewFile(path, content, options.force === true);
          deps.stdout(options.json === true ? JSON.stringify({ path, slug }, null, 2) : path);
        },
      ),
    );

  prd
    .command('rubric')
    .description('Print the scoring rubric for the five dimensions')
    .action(() => {
      deps.stdout(formatRubric());
    });

  prd
    .command('status')
    .description('Show the iteration state of a PRD')
    .argument('<slug>', 'PRD slug')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (slug: string, options: { json?: boolean }) => {
        const store = new StateStore((await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd);
        const state = await store.read<PrdState>(`prd-${slug}`);
        if (state === undefined) throw new PrdError(`no evaluations recorded for "${slug}"`);
        const { config } = await loadCliConfig(deps);
        const last = state.history.at(-1);
        const remaining = Math.max(
          0,
          config.prd.maxRefinements - Math.max(0, state.evaluations - 1),
        );
        if (options.json === true) {
          deps.stdout(JSON.stringify({ ...state, refinementsRemaining: remaining }, null, 2));
          return;
        }
        deps.stdout(
          [
            `PRD ${state.slug}: ${state.evaluations} evaluation(s) in this cycle`,
            last === undefined
              ? 'no result yet'
              : `last: mean ${String(last.mean)}, lowest ${String(last.min)} -> ${last.nextAction}`,
            `refinements remaining: ${String(remaining)}`,
          ].join('\n'),
        );
      }),
    );
}
