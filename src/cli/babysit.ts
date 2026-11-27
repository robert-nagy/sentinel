import type { Command } from 'commander';
import { ExitCode } from '../core/exit-codes.js';
import { GitHubCodeHost } from '../core/hosts/github.js';
import { prChanges } from '../core/learn-pr.js';
import { LessonStore, type LearnSettings, type RecalledLesson } from '../core/learn-store.js';
import { LearnError } from '../core/learnings.js';
import { ProviderError } from '../core/provider-error.js';
import { babysatPullRequests, babysit, type BabysitAction } from '../core/pr-babysitter.js';
import { findMainRoot, findRepoRoot } from '../core/repo.js';
import { StateStore } from '../core/state.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

const EXIT: Record<BabysitAction, number> = {
  done: ExitCode.Ok,
  wait: ExitCode.Ok,
  rerun: ExitCode.Ok,
  patch: ExitCode.Refine,
  'give-up': ExitCode.Escalate,
};

export function registerBabysit(program: Command, deps: CliDeps): void {
  program
    .command('babysit')
    .description('Watch a pull request until CI is green, needs a fix, or sentinel gives up')
    .argument('<pr>', 'pull request number or URL')
    .option('--once', 'evaluate once and return, even while checks are running')
    .option('--watch', 'poll until there is something to do (the default)')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (ref: string, options: { once?: boolean; json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
        // State lives in the main checkout, so it survives worktree removal and other PRs'
        // failure signatures are visible (ADR-0008).
        const mainRoot = await findMainRoot(deps.run, deps.cwd, root);
        const state = new StateStore(mainRoot);
        const host = new GitHubCodeHost({ run: deps.run, cwd: deps.cwd });
        const result = await babysit(host, ref, state, {
          settings: { maxAttempts: config.babysit.maxAttempts },
          pollIntervalSec: config.babysit.pollIntervalSec,
          timeoutMin: config.babysit.timeoutMin,
          once: options.once === true,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => deps.now().getTime(),
          onProgress: (message) => {
            deps.stderr(`sentinel: ${message}`);
          },
        });
        // A failure seen before, on another PR or in a lesson, is worth a lesson once fixed.
        let recurringPrs: number[] = [];
        let lessons: RecalledLesson[] = [];
        let knownSignature = false;
        if (result.packet !== undefined && result.action === 'patch') {
          const signature = result.packet.signature;
          recurringPrs = [...(await babysatPullRequests(state))]
            .filter(([pr, info]) => pr !== result.pr.number && info.signatures.includes(signature))
            .map(([pr]) => pr);
          if (config.learn.enabled) {
            const lessonStore = new LessonStore(root, {
              now: deps.now,
              settings: config.learn,
              mainRoot,
            });
            // Archived lessons still make a failure recurring; recall gives the active bodies.
            // Lessons are a hint: a broken store must never hide the failure packet.
            try {
              knownSignature = (await lessonStore.withSignature(signature)).length > 0;
              lessons = (await lessonStore.recall({ signature, limit: 3 })).filter(
                (l) => l.match === 'signature',
              );
            } catch (error) {
              deps.stderr(
                `sentinel: lessons could not be read (${error instanceof Error ? error.message : String(error)}); continuing without them`,
              );
            }
          }
        }
        // A merged PR of the user's own with changes by others is worth offering to
        // sentinel-learn-pr right away (ADR-0008, decision 12). Never fails the babysit run.
        let learnable = false;
        if (
          result.action === 'done' &&
          result.pr.state === 'merged' &&
          config.learn.enabled &&
          config.learn.offerPrLessons
        ) {
          learnable = await offerable(
            host,
            root,
            mainRoot,
            state,
            result.pr.number,
            deps,
            config.learn,
          );
        }
        const output = {
          action: result.action,
          reason: result.reason,
          pr: result.pr.url,
          attempts: result.attempts,
          packet: result.packet,
          recurring: recurringPrs.length > 0 || knownSignature,
          recurringPrs,
          lessons: lessons.map(({ id, summary, body, path }) => ({ id, summary, body, path })),
          learnable,
        };
        deps.stdout(
          options.json === true
            ? JSON.stringify(output, null, 2)
            : [
                `${result.action}: ${result.reason}`,
                ...(result.packet?.errors
                  .slice(0, 10)
                  .map(
                    (e) =>
                      `  ${e.file ?? ''}${e.line === undefined ? '' : `:${String(e.line)}`} ${e.message}`,
                  ) ?? []),
              ].join('\n'),
        );
        deps.setExitCode(EXIT[result.action]);
      }),
    );
}

/** Whether a merged PR is the user's own, unlearned, never offered, with changes by others. */
async function offerable(
  host: GitHubCodeHost,
  root: string,
  mainRoot: string,
  state: StateStore,
  pr: number,
  deps: CliDeps,
  settings: LearnSettings,
): Promise<boolean> {
  const store = new LessonStore(root, { now: deps.now, settings, mainRoot });
  try {
    if ((await store.readUsage()).prs[String(pr)]?.offeredAt !== undefined) return false;
    const heads = new Map<number, string>();
    const info = (await babysatPullRequests(state)).get(pr);
    if (info?.headSha !== undefined) heads.set(pr, info.headSha);
    const [changes] = await prChanges(host, store, [pr], heads);
    if (changes === undefined || changes.learned !== undefined) return false;
    if (changes.commits.length === 0 && changes.comments.length === 0) return false;
    await store.markPrs([pr], 'offeredAt');
    return true;
  } catch (error) {
    // Not the user's PR, the host could not tell, or the store is broken: do not offer it,
    // and never fail the babysit run over it.
    if (!(error instanceof LearnError) && !(error instanceof ProviderError)) {
      deps.stderr(
        `sentinel: lessons could not be read (${error instanceof Error ? error.message : String(error)}); not offering this pull request`,
      );
    }
    return false;
  }
}
