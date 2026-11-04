import type { Command } from 'commander';
import {
  BRANCH_TYPES,
  BranchNameError,
  resolveBranchName,
  templatePlaceholders,
  type BranchType,
} from '../core/branch-namer.js';
import { loadConfig } from '../core/config.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

interface NameOptions {
  issue: string;
  type?: string;
  title?: string;
  label?: string[];
  issueType?: string;
  json?: boolean;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function registerBranch(program: Command, deps: CliDeps): void {
  const branch = program.command('branch').description('Branch naming');

  branch
    .command('name')
    .description('Print the branch name for an issue, from the configured templates')
    .requiredOption('--issue <id>', 'issue id, for example 42, #42 or PROJ-123')
    .option('--type <type>', `branch type: ${BRANCH_TYPES.join(', ')} (default: inferred)`)
    .option('--title <title>', 'issue title, used for {slug}')
    .option('--label <label>', 'issue label, used to infer the type (repeatable)', collect)
    .option('--issue-type <type>', "the tracker's issue type, used to infer the type")
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: NameOptions) => {
        const knownTypes: readonly string[] = BRANCH_TYPES;
        if (options.type !== undefined && !knownTypes.includes(options.type)) {
          throw new BranchNameError(
            `unknown branch type "${options.type}"; use one of: ${BRANCH_TYPES.join(', ')}`,
          );
        }
        const { config } = await loadConfig({
          cwd: deps.cwd,
          files: deps.files,
          homeDir: deps.homeDir,
          env: deps.env,
          platform: deps.platform,
        });

        const type = options.type as BranchType | undefined;
        const needsUser = BRANCH_TYPES.some(
          (t) =>
            (type === undefined || type === t) &&
            templatePlaceholders(config.branches[t]).includes('user'),
        );
        let user: string | undefined;
        if (needsUser) {
          const result = await deps.run('git', ['config', 'user.name'], { cwd: deps.cwd });
          user = result.exitCode === 0 ? result.stdout.trim() : undefined;
        }

        const resolved = resolveBranchName(
          {
            issue: {
              id: options.issue,
              title: options.title,
              labels: options.label,
              issueType: options.issueType,
            },
            type,
          },
          config,
          { now: deps.now(), user },
        );
        deps.stdout(options.json ? JSON.stringify(resolved, null, 2) : resolved.name);
      }),
    );
}
