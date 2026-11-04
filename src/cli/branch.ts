import type { Command } from 'commander';
import {
  BRANCH_TYPES,
  BranchNameError,
  resolveBranchName,
  templatePlaceholders,
  type BranchType,
  type ResolvedBranch,
} from '../core/branch-namer.js';
import type { SentinelConfig } from '../core/config-schema.js';
import { loadConfig } from '../core/config.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

export interface BranchOptions {
  issue: string;
  type?: string | undefined;
  title?: string | undefined;
  label?: string[] | undefined;
  issueType?: string | undefined;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Options shared by every command that turns an issue into a branch name. */
export function addBranchOptions(command: Command): Command {
  return command
    .option('--type <type>', `branch type: ${BRANCH_TYPES.join(', ')} (default: inferred)`)
    .option('--title <title>', 'issue title, used for {slug}')
    .option('--label <label>', 'issue label, used to infer the type (repeatable)', collect)
    .option('--issue-type <type>', "the tracker's issue type, used to infer the type");
}

export function loadCliConfig(deps: CliDeps) {
  return loadConfig({
    cwd: deps.cwd,
    files: deps.files,
    homeDir: deps.homeDir,
    env: deps.env,
    platform: deps.platform,
  });
}

/** Resolves the branch name for an issue using the effective configuration. */
export async function resolveCliBranch(
  deps: CliDeps,
  config: SentinelConfig,
  options: BranchOptions,
): Promise<ResolvedBranch> {
  const knownTypes: readonly string[] = BRANCH_TYPES;
  if (options.type !== undefined && !knownTypes.includes(options.type)) {
    throw new BranchNameError(
      `unknown branch type "${options.type}"; use one of: ${BRANCH_TYPES.join(', ')}`,
    );
  }
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
  return resolveBranchName(
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
}

export function registerBranch(program: Command, deps: CliDeps): void {
  const branch = program.command('branch').description('Branch naming');

  addBranchOptions(
    branch
      .command('name')
      .description('Print the branch name for an issue, from the configured templates')
      .requiredOption('--issue <id>', 'issue id, for example 42, #42 or PROJ-123'),
  )
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: BranchOptions & { json?: boolean }) => {
        const { config } = await loadCliConfig(deps);
        const resolved = await resolveCliBranch(deps, config, options);
        deps.stdout(options.json === true ? JSON.stringify(resolved, null, 2) : resolved.name);
      }),
    );
}
