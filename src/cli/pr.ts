import { isAbsolute, join } from 'node:path';
import type { Command } from 'commander';
import { GitHubCodeHost } from '../core/hosts/github.js';
import { LOCAL_TRACKER, normalizeTracker } from '../core/issue-tracker.js';
import { LocalTracker } from '../core/local-tracker.js';
import { ProviderError } from '../core/provider-error.js';
import { findRepoRoot } from '../core/repo.js';
import { loadCliConfig } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

interface CreateOptions {
  issue: string;
  title: string;
  body?: string;
  issueUrl?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  json?: boolean;
}

/**
 * The line that ties the PR to its issue. Only GitHub closes issues from the PR body, so
 * other trackers get a plain reference and the agent links the PR with its own tools
 * (the `link-pr` verb, ADR-0005).
 */
export function issueReference(tracker: string | null, issueId: string, issueUrl?: string): string {
  const id = issueId.trim().replace(/^#/, '');
  if (tracker === 'github') return `Closes #${id}`;
  if (tracker === LOCAL_TRACKER) return `Refs local issue ${id}`;
  return `Refs ${id}${issueUrl === undefined ? '' : `: ${issueUrl}`}`;
}

export function registerPr(program: Command, deps: CliDeps): void {
  const pr = program.command('pr').description('Pull requests');

  pr.command('create')
    .description('Push the branch and open a pull request that references an issue')
    .requiredOption('--issue <id>', 'issue the pull request implements')
    .requiredOption('--title <title>', 'pull request title')
    .option('--body <text>', 'pull request description')
    .option('--issue-url <url>', "link to the issue, for trackers that don't auto-link ids")
    .option('--base <branch>', 'target branch (default: codeHost.defaultBranch)')
    .option('--head <branch>', 'source branch (default: the current branch)')
    .option('--draft', 'open as a draft')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: CreateOptions) => {
        const { config } = await loadCliConfig(deps);
        const host = new GitHubCodeHost({ run: deps.run, cwd: deps.cwd });
        const tracker =
          config.issueProvider.tracker === null
            ? null
            : normalizeTracker(config.issueProvider.tracker);

        // Fail before pushing if a local issue does not exist.
        let local: LocalTracker | undefined;
        if (tracker === LOCAL_TRACKER) {
          const root = (await findRepoRoot(deps.cwd, deps.files)) ?? deps.cwd;
          const dir = config.issueProvider.localDir;
          local = new LocalTracker(isAbsolute(dir) ? dir : join(root, dir), deps.now);
          await local.get(options.issue);
        }

        let head = options.head;
        if (head === undefined) {
          const current = await deps.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: deps.cwd,
          });
          head = current.exitCode === 0 ? current.stdout.trim() : '';
          if (head === '' || head === 'HEAD') {
            throw new ProviderError('failed', 'cannot determine the current branch; pass --head');
          }
        }
        const base = options.base ?? config.codeHost.defaultBranch;
        if (head === base) {
          throw new ProviderError(
            'failed',
            `refusing to open a pull request from ${base} into itself`,
          );
        }

        // gh needs the branch on the remote; pushing is idempotent.
        const push = await deps.run('git', ['push', '--set-upstream', 'origin', head], {
          cwd: deps.cwd,
        });
        if (push.exitCode !== 0) {
          throw new ProviderError(
            'failed',
            `git push failed: ${(push.stderr || push.stdout).trim()}`,
          );
        }

        const body = [
          options.body?.trim(),
          issueReference(tracker, options.issue, options.issueUrl),
        ]
          .filter((part) => part !== undefined && part !== '')
          .join('\n\n');
        const created = await host.createPullRequest({
          title: options.title,
          body,
          head,
          base,
          draft: options.draft,
        });

        // The local tracker is ours, so link the PR deterministically.
        if (local !== undefined) {
          await local.comment(options.issue, `Pull request: ${created.url}`);
        } else if (tracker !== 'github') {
          deps.stderr(
            `sentinel: hint: link ${created.url} to issue ${options.issue} with your ${tracker ?? 'tracker'} tools (see \`sentinel issue describe\`)`,
          );
        }
        deps.stdout(options.json === true ? JSON.stringify(created, null, 2) : created.url);
      }),
    );
}
