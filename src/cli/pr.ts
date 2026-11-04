import type { Command } from 'commander';
import { ProviderError } from '../core/issue-provider.js';
import type { CliDeps } from './deps.js';
import { createServices } from './providers.js';
import { guarded } from './safe.js';

interface CreateOptions {
  issue: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
  json?: boolean;
}

export function registerPr(program: Command, deps: CliDeps): void {
  const pr = program.command('pr').description('Pull requests');

  pr.command('create')
    .description('Push the branch and open a pull request linked to an issue')
    .requiredOption('--issue <id>', 'issue the pull request implements')
    .option('--title <title>', 'pull request title (default: the issue title)')
    .option('--body <text>', 'extra text for the pull request description')
    .option('--base <branch>', 'target branch (default: codeHost.defaultBranch)')
    .option('--head <branch>', 'source branch (default: the current branch)')
    .option('--draft', 'open as a draft')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: CreateOptions) => {
        const { config, issues, host } = await createServices(deps);
        const issue = await issues.getIssue(options.issue);

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

        const reference =
          config.issueProvider.type === 'github'
            ? `Closes #${issue.id}`
            : `Refs ${issue.id}: ${issue.url}`.trim();
        const body = [options.body?.trim(), reference]
          .filter((part) => part !== undefined && part !== '')
          .join('\n\n');
        const created = await host.createPullRequest({
          title: options.title ?? `${issue.title} (#${issue.id})`,
          body,
          head,
          base,
          draft: options.draft,
        });

        // GitHub closes the issue from the PR body; other trackers need an explicit link.
        if (config.issueProvider.type !== 'github' && issues.capabilities().linkPullRequest) {
          await issues.linkPullRequest(issue.id, created.url);
        }
        deps.stdout(options.json === true ? JSON.stringify(created, null, 2) : created.url);
      }),
    );
}
