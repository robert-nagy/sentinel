import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  ADR_DIR,
  ARCHITECTURE_FILE,
  buildDecision,
  nextAdrPath,
  parseStackOption,
  plannedProjects,
  readDecision,
  renderDecisionAdr,
  validateDecision,
  type ArchitectureDecision,
} from '../core/architecture.js';
import { ExitCode } from '../core/exit-codes.js';
import { ISSUE_KINDS, renderIssueForm } from '../core/issue-format.js';
import { normalizeTracker } from '../core/issue-tracker.js';
import { renderReadme } from '../core/readme-renderer.js';
import { findRepoRoot } from '../core/repo.js';
import { ScaffoldError, resolveInside, writeNewFile } from '../core/scaffold.js';
import {
  DOMAIN_FILE,
  SetupError,
  buildDomain,
  isComplete,
  nextQuestions,
  parseDomain,
  toPublic,
  validateAnswers,
  type Answers,
} from '../core/socratic-engine.js';
import {
  analyze,
  formatStackReport,
  plannedProject,
  type ProjectReport,
} from '../core/stack-analyzer.js';
import { StateStore } from '../core/state.js';
import {
  LEARN_VERIFY_CHECK,
  LEARN_VERIFY_WORKFLOW_PATH,
  SENTINEL_REPO,
  learnVerifyRuleset,
  renderLearnVerifyWorkflow,
  renderWorkflows,
} from '../core/workflows.js';
import { VERSION } from '../version.js';

/** State file holding the ruleset payload for the user to apply. */
export const LEARN_RULESET_STATE = 'learn-ruleset';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

interface SetupOptions {
  answers?: string;
  architecture?: string;
  questions?: boolean;
  stack?: string;
  workflows?: boolean;
  readme?: boolean;
  issueForms?: boolean;
  learnVerify?: boolean;
  name?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

async function readAnswersFile(path: string, deps: CliDeps): Promise<Answers> {
  const text = await deps.files.readText(resolve(deps.cwd, path));
  if (text === undefined) throw new SetupError(`answers file not found: ${path}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SetupError(`${path} is not valid JSON`);
  }
  const checked = validateAnswers(json);
  if (!checked.ok) throw new SetupError(`${path}: ${checked.errors.join('; ')}`);
  return checked.answers;
}

/** Asks the open questions in the terminal; a blank reply skips a question. */
async function askInTerminal(known: Answers, deps: CliDeps): Promise<Answers> {
  const ask = deps.ask;
  if (ask === undefined) return {};
  const collected: Record<string, string> = {};
  const asked = new Set<string>();
  for (;;) {
    const open = nextQuestions({ ...known, ...collected }).filter((q) => !asked.has(q.id));
    if (open.length === 0) break;
    for (const question of open) {
      asked.add(question.id);
      const hint = question.hint === undefined ? '' : ` (${question.hint})`;
      const reply = await ask(`${question.prompt}${hint}\n> `);
      if (reply.trim() !== '') collected[question.id] = reply.trim();
    }
  }
  const checked = validateAnswers(collected);
  return checked.ok ? checked.answers : {};
}

async function readDecisionFile(path: string, deps: CliDeps): Promise<unknown> {
  const text = await deps.files.readText(resolve(deps.cwd, path));
  if (text === undefined) throw new SetupError(`architecture file not found: ${path}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SetupError(`${path} is not valid JSON`);
  }
}

async function refuseToOverwrite(root: string, relPath: string, deps: CliDeps): Promise<void> {
  if (await deps.files.exists(join(root, relPath))) {
    throw new ScaffoldError(`${relPath} already exists (use --force to overwrite)`);
  }
}

function architectureState(decision: ArchitectureDecision | undefined): {
  path: string;
  recorded: boolean;
  adr: string | null;
} {
  return { path: ARCHITECTURE_FILE, recorded: decision !== undefined, adr: decision?.adr ?? null };
}

export function registerSetup(program: Command, deps: CliDeps): void {
  program
    .command('setup')
    .description(
      'Phase 0: record the domain (questions and answers), then write test workflows and a README',
    )
    .option('--questions', 'print the open questions and the stack report, change nothing')
    .option('--answers <file>', 'JSON file of question id to answer; merged into the domain file')
    .option(
      '--architecture <file>',
      `JSON file of the stack and architecture decision; recorded as ${ARCHITECTURE_FILE} and an ADR`,
    )
    .option(
      '--stack <list>',
      'stack to plan before there is code: one ecosystem, or <ecosystem>:<path> entries separated by commas',
    )
    .option('--workflows', 'write the GitHub test workflows')
    .option('--readme', 'write README.md from the domain answers')
    .option(
      '--issue-forms',
      'write GitHub issue forms (.github/ISSUE_TEMPLATE/feature.yml and bug.yml) in the sentinel issue format',
    )
    .option(
      '--learn-verify',
      'write the CI check for lesson changes (own-PR rule) and the ruleset that requires it',
    )
    .option('--name <name>', 'project name for the README (default: the folder name)')
    .option('--force', 'overwrite files that already exist')
    .option('--dry-run', 'report what would be written without writing')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: SetupOptions) => {
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        const { config } = await loadCliConfig(deps);
        const dryRun = options.dryRun === true;
        const domainPath = join(root, DOMAIN_FILE);

        const plannedStack =
          options.stack === undefined ? undefined : parseStackOption(options.stack);
        let decision: ArchitectureDecision | undefined = await readDecision(root, deps.files);

        const existingText = await deps.files.readText(domainPath);
        const existing =
          existingText === undefined ? undefined : parseDomain(existingText, DOMAIN_FILE);
        let answers: Answers = existing?.answers ?? {};

        let incoming: Answers = {};
        if (options.answers !== undefined) {
          incoming = await readAnswersFile(options.answers, deps);
        } else if (
          deps.interactive === true &&
          options.questions !== true &&
          options.workflows !== true &&
          options.readme !== true &&
          options.issueForms !== true &&
          options.learnVerify !== true &&
          options.architecture === undefined
        ) {
          incoming = await askInTerminal(answers, deps);
        }
        const files: string[] = [];
        if (options.architecture !== undefined) {
          const checked = validateDecision(await readDecisionFile(options.architecture, deps));
          if (!checked.ok) {
            const problems = [...checked.problems];
            if (options.json === true) {
              deps.stdout(
                JSON.stringify(
                  { dryRun, problems, files, architecture: architectureState(decision) },
                  null,
                  2,
                ),
              );
            } else {
              deps.stdout(
                [
                  `${options.architecture} is not a valid decision:`,
                  ...problems.map((p) => `  - ${p}`),
                ].join('\n'),
              );
            }
            deps.setExitCode(ExitCode.Refine);
            return;
          }
          const adr = decision?.adr ?? nextAdrPath(await deps.files.listDir(join(root, ADR_DIR)));
          if (options.force !== true) {
            await refuseToOverwrite(root, ARCHITECTURE_FILE, deps);
            await refuseToOverwrite(root, adr, deps);
          }
          const recorded = buildDecision(checked.decision, deps.now(), adr);
          if (!dryRun) {
            await writeNewFile(
              resolveInside(root, '.', ARCHITECTURE_FILE),
              `${JSON.stringify(recorded, null, 2)}\n`,
              options.force === true,
            );
            await writeNewFile(
              resolveInside(root, '.', adr),
              renderDecisionAdr(recorded),
              options.force === true,
            );
          }
          files.push(ARCHITECTURE_FILE, adr);
          // A dry run still plans the workflows and README from the decision it would record.
          decision = recorded;
        }

        const changed = Object.keys(incoming).length > 0;
        answers = { ...answers, ...incoming };

        let domainWritten = false;
        if (changed && options.questions !== true) {
          if (!dryRun) {
            await mkdir(dirname(domainPath), { recursive: true });
            await writeFile(
              domainPath,
              `${JSON.stringify(buildDomain(answers, deps.now()), null, 2)}\n`,
              'utf8',
            );
          }
          domainWritten = true;
        }

        const stack = await analyze(root, deps.files);
        let projects: readonly ProjectReport[] = stack.projects;
        // No code yet (or only docs and config): plan the projects from --stack or the decision.
        if (stack.projects.length === 0 && plannedStack !== undefined) {
          projects = plannedStack.map((entry) => plannedProject(entry.ecosystem, entry.path));
        } else if (stack.projects.length === 0 && decision !== undefined) {
          projects = plannedProjects(decision);
        }

        if (options.workflows === true) {
          if (projects.length === 0) {
            throw new SetupError(
              stack.empty
                ? 'the repository is empty: record the stack with --architecture <file>, or pass --stack <ecosystem>'
                : 'no recognised project found to build workflows for',
            );
          }
          const workflows = renderWorkflows(projects, config);
          if (options.force !== true) {
            for (const workflow of workflows) await refuseToOverwrite(root, workflow.path, deps);
          }
          for (const workflow of workflows) {
            if (!dryRun) {
              await writeNewFile(
                resolveInside(root, '.', workflow.path),
                workflow.content,
                options.force === true,
              );
            }
            files.push(workflow.path);
          }
        }
        if (options.readme === true) {
          if (answers.problem === undefined) {
            throw new SetupError('answer the core questions first: the README is built from them');
          }
          if (options.force !== true) await refuseToOverwrite(root, 'README.md', deps);
          const content = renderReadme({
            name: options.name ?? basename(root),
            answers,
            projects,
            architecture: decision,
          });
          if (!dryRun) await writeNewFile(join(root, 'README.md'), content, options.force === true);
          files.push('README.md');
        }

        if (options.issueForms === true) {
          const tracker = config.issueProvider.tracker;
          if (tracker !== null && normalizeTracker(tracker) !== 'github') {
            throw new SetupError(
              `issue forms are for GitHub Issues, but issueProvider.tracker is ${normalizeTracker(tracker)}`,
            );
          }
          const forms = ISSUE_KINDS.map((kind) =>
            renderIssueForm(kind, config.issueProvider.labelMap),
          );
          if (options.force !== true) {
            for (const form of forms) await refuseToOverwrite(root, form.path, deps);
          }
          for (const form of forms) {
            if (!dryRun) {
              await writeNewFile(
                resolveInside(root, '.', form.path),
                form.content,
                options.force === true,
              );
            }
            files.push(form.path);
          }
        }

        let ruleset: string | undefined;
        const warnings: string[] = [];
        if (options.learnVerify === true) {
          const path = LEARN_VERIFY_WORKFLOW_PATH;
          if (options.force !== true) await refuseToOverwrite(root, path, deps);
          // Pin the download to the commit behind the release tag: a tag can be moved.
          const resolved = await deps.run(
            'gh',
            ['api', `repos/${SENTINEL_REPO}/commits/v${VERSION}`, '--jq', '.sha'],
            { cwd: root, timeoutMs: 30_000 },
          );
          const commit = resolved.exitCode === 0 ? resolved.stdout.trim() : '';
          const pinned = /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
          if (pinned === undefined) {
            warnings.push(
              `could not resolve the commit of sentinel v${VERSION}, so the lesson check downloads by tag; re-run \`sentinel setup --learn-verify --force\` once gh can reach GitHub`,
            );
          }
          if (!dryRun) {
            await writeNewFile(
              resolveInside(root, '.', path),
              renderLearnVerifyWorkflow(VERSION, 'release', pinned),
              options.force === true,
            );
            // The ruleset is applied by the user (or the skill, after approval), never here.
            await new StateStore(root).write(LEARN_RULESET_STATE, learnVerifyRuleset());
          }
          files.push(path);
          ruleset = `.sentinel/state/${LEARN_RULESET_STATE}.json`;
        }

        const complete = isComplete(answers);
        const next = nextQuestions(answers).map(toPublic);
        const result = {
          dryRun,
          domain: { path: DOMAIN_FILE, written: domainWritten, complete },
          next,
          stack: {
            empty: stack.empty,
            projects,
            proposal: projects.length === 0,
          },
          architecture: architectureState(dryRun ? await readDecision(root, deps.files) : decision),
          files,
          ruleset,
          warnings,
        };
        if (options.json === true) {
          deps.stdout(JSON.stringify(result, null, 2));
        } else {
          const prefix = dryRun ? '(dry run) ' : '';
          const lines = [
            `${prefix}domain: ${complete ? 'complete' : `${String(next.length)} open question(s)`}${domainWritten ? ` (saved to ${DOMAIN_FILE})` : ''}`,
            ...next.map((q) => `  - [${q.branch}] ${q.id}: ${q.prompt}`),
            '',
            formatStackReport(stack),
            decision === undefined
              ? `architecture: not recorded (${ARCHITECTURE_FILE})`
              : `architecture: ${decision.architecture.style} (${ARCHITECTURE_FILE}, ${decision.adr})`,
            ...files.map((f) => `${prefix}wrote ${f}`),
            ...warnings.map((w) => `warning: ${w}`),
            ...(ruleset === undefined
              ? []
              : [
                  `${prefix}ruleset to require "${LEARN_VERIFY_CHECK}": ${ruleset} (apply it with gh api --method POST repos/{owner}/{repo}/rulesets --input ${ruleset})`,
                ]),
          ];
          deps.stdout(lines.join('\n'));
        }
        if (!complete && options.questions !== true) deps.setExitCode(ExitCode.Refine);
      }),
    );
}
