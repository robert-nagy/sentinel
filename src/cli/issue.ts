import type { Command } from 'commander';
import { ProviderError, type Issue } from '../core/issue-provider.js';
import { collect } from './common.js';
import type { CliDeps } from './deps.js';
import { createServices } from './providers.js';
import { guarded } from './safe.js';

function formatIssue(issue: Issue): string {
  const lines = [
    `#${issue.id} ${issue.title} [${issue.state}]`,
    issue.url,
    `labels: ${issue.labels.length > 0 ? issue.labels.join(', ') : '(none)'}`,
  ];
  if (issue.body.trim() !== '') lines.push('', issue.body.trim());
  return lines.join('\n');
}

function formatList(issues: readonly Issue[]): string {
  return issues.map((i) => `#${i.id}\t${i.state}\t${i.title}`).join('\n');
}

interface JsonOption {
  json?: boolean;
}

export function registerIssue(program: Command, deps: CliDeps): void {
  const issue = program.command('issue').description('Work with the configured issue tracker');
  const print = (value: unknown, text: string, json?: boolean): void => {
    deps.stdout(json === true ? JSON.stringify(value, null, 2) : text);
  };

  issue
    .command('get')
    .description('Show an issue')
    .argument('<id>', 'issue id')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (id: string, options: JsonOption) => {
        const { issues } = await createServices(deps);
        const found = await issues.getIssue(id);
        print(found, formatIssue(found), options.json);
      }),
    );

  issue
    .command('list')
    .description('List issues')
    .option('--state <state>', 'open, closed or all', 'open')
    .option('--label <label>', 'filter by label (repeatable)', collect)
    .option('--search <text>', 'free-text search')
    .option('--limit <n>', 'maximum number of issues', '30')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (options: JsonOption & { state: string; label?: string[]; search?: string; limit: string }) => {
          if (!['open', 'closed', 'all'].includes(options.state)) {
            throw new ProviderError('failed', `--state must be open, closed or all (got "${options.state}")`);
          }
          const limit = Number.parseInt(options.limit, 10);
          if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
            throw new ProviderError('failed', '--limit must be between 1 and 200');
          }
          const { issues } = await createServices(deps);
          const found = await issues.listIssues({
            state: options.state as 'open' | 'closed' | 'all',
            labels: options.label,
            search: options.search,
            limit,
          });
          print(found, formatList(found), options.json);
        },
      ),
    );

  issue
    .command('create')
    .description('Create an issue')
    .requiredOption('--title <title>', 'issue title')
    .option('--body <text>', 'issue body')
    .option('--body-file <path>', 'read the issue body from a file')
    .option('--label <label>', 'logical label, mapped through labelMap (repeatable)', collect)
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (options: JsonOption & { title: string; body?: string; bodyFile?: string; label?: string[] }) => {
          let body = options.body ?? '';
          if (options.bodyFile !== undefined) {
            const text = await deps.files.readText(options.bodyFile);
            if (text === undefined) throw new ProviderError('failed', `body file not found: ${options.bodyFile}`);
            body = text;
          }
          const { issues } = await createServices(deps);
          const created = await issues.createIssue({ title: options.title, body, labels: options.label });
          print(created, `created #${created.id} ${created.url}`.trim(), options.json);
        },
      ),
    );

  issue
    .command('comment')
    .description('Add a comment to an issue')
    .argument('<id>', 'issue id')
    .requiredOption('--body <text>', 'comment text')
    .action(
      guarded(deps, async (id: string, options: { body: string }) => {
        const { issues } = await createServices(deps);
        await issues.addComment(id, options.body);
        deps.stdout(`commented on #${id}`);
      }),
    );

  issue
    .command('link')
    .description('Link a pull request to an issue')
    .argument('<id>', 'issue id')
    .requiredOption('--pr <url>', 'pull request URL')
    .action(
      guarded(deps, async (id: string, options: { pr: string }) => {
        const { issues } = await createServices(deps);
        await issues.linkPullRequest(id, options.pr);
        deps.stdout(`linked ${options.pr} to #${id}`);
      }),
    );

  issue
    .command('duplicates')
    .description('Find existing issues with a similar title')
    .argument('<title>', 'title to look for')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (title: string, options: JsonOption) => {
        const { issues } = await createServices(deps);
        const found = await issues.findDuplicates(title);
        print(found, found.length === 0 ? 'no similar issues found' : formatList(found), options.json);
      }),
    );

  issue
    .command('describe-provider')
    .description('Print agent-facing instructions for the configured issue tracker')
    .action(
      guarded(deps, async () => {
        const { issues } = await createServices(deps);
        deps.stdout(issues.describe());
      }),
    );
}
