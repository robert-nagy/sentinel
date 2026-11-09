import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { ExitCode } from '../core/exit-codes.js';
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
  ECOSYSTEMS,
  analyze,
  formatStackReport,
  plannedProject,
  type Ecosystem,
  type ProjectReport,
} from '../core/stack-analyzer.js';
import { renderWorkflows } from '../core/workflows.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

interface SetupOptions {
  answers?: string;
  questions?: boolean;
  stack?: string;
  workflows?: boolean;
  readme?: boolean;
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

async function refuseToOverwrite(root: string, relPath: string, deps: CliDeps): Promise<void> {
  if (await deps.files.exists(join(root, relPath))) {
    throw new ScaffoldError(`${relPath} already exists (use --force to overwrite)`);
  }
}

export function registerSetup(program: Command, deps: CliDeps): void {
  program
    .command('setup')
    .description(
      'Phase 0: record the domain (questions and answers), then write test workflows and a README',
    )
    .option('--questions', 'print the open questions and the stack report, change nothing')
    .option('--answers <file>', 'JSON file of question id to answer; merged into the domain file')
    .option('--stack <ecosystem>', `stack to use in an empty repo: ${ECOSYSTEMS.join(', ')}`)
    .option('--workflows', 'write the GitHub test workflows')
    .option('--readme', 'write README.md from the domain answers')
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

        if (
          options.stack !== undefined &&
          !(ECOSYSTEMS as readonly string[]).includes(options.stack)
        ) {
          throw new SetupError(
            `unknown stack "${options.stack}"; choose one of ${ECOSYSTEMS.join(', ')}`,
          );
        }

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
          options.readme !== true
        ) {
          incoming = await askInTerminal(answers, deps);
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
        if (stack.empty && options.stack !== undefined) {
          projects = [plannedProject(options.stack as Ecosystem)];
        }

        const files: string[] = [];
        if (options.workflows === true) {
          if (projects.length === 0) {
            throw new SetupError(
              stack.empty
                ? 'the repository is empty: confirm a stack with the user and pass --stack <ecosystem>'
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
          });
          if (!dryRun) await writeNewFile(join(root, 'README.md'), content, options.force === true);
          files.push('README.md');
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
            proposal: stack.empty && options.stack === undefined,
          },
          files,
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
            ...files.map((f) => `${prefix}wrote ${f}`),
          ];
          deps.stdout(lines.join('\n'));
        }
        if (!complete && options.questions !== true) deps.setExitCode(ExitCode.Refine);
      }),
    );
}
