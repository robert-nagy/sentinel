import type { Command } from 'commander';
import { ExitCode } from '../core/exit-codes.js';
import {
  GitWorktreeManager,
  WORKTREE_CLEANUP_THRESHOLD,
  WorktreeError,
} from '../core/git-worktree-manager.js';
import { addBranchOptions, loadCliConfig, resolveCliBranch, type BranchOptions } from './branch.js';
import type { CliDeps } from './deps.js';
import { guarded } from './safe.js';

async function createManager(deps: CliDeps): Promise<GitWorktreeManager> {
  const top = await deps.run('git', ['rev-parse', '--show-toplevel'], { cwd: deps.cwd });
  if (top.exitCode !== 0 || top.stdout.trim() === '') {
    throw new WorktreeError('not inside a git repository');
  }
  const { config } = await loadCliConfig(deps);
  return new GitWorktreeManager({
    repoRoot: top.stdout.trim(),
    config,
    run: deps.run,
    platform: deps.platform,
  });
}

export function registerWorktree(program: Command, deps: CliDeps): void {
  const worktree = program.command('worktree').description('Per-issue git worktrees');

  addBranchOptions(
    worktree
      .command('add')
      .description('Create (or reuse) the worktree for an issue and print its path')
      .argument('<id>', 'issue id, for example 42 or PROJ-123'),
  )
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(
        deps,
        async (id: string, options: Omit<BranchOptions, 'issue'> & { json?: boolean }) => {
          const manager = await createManager(deps);
          const { config } = await loadCliConfig(deps);
          const branch = await resolveCliBranch(deps, config, { ...options, issue: id });
          const result = await manager.create(id, branch.name);
          for (const warning of result.warnings) deps.stderr(`sentinel: warning: ${warning}`);
        const others = (await manager.list()).filter((w) => w.branch !== result.branch);
        if (others.length >= WORKTREE_CLEANUP_THRESHOLD) {
          let merged = 0;
          for (const w of others) {
            if (w.branch !== undefined && (await manager.isMergedLocally(w.branch))) merged += 1;
          }
          deps.stderr(
            `sentinel: hint: ${String(others.length)} other worktrees exist (${String(merged)} look merged); run \`sentinel worktree prune\` to clean up`,
          );
        }
          deps.stdout(options.json === true ? JSON.stringify(result, null, 2) : result.path);
        },
      ),
    );

  worktree
    .command('remove')
    .description('Remove the worktree for an issue (the branch is kept)')
    .argument('<id>', 'issue id')
    .option('--force', 'remove even with uncommitted changes')
    .action(
      guarded(deps, async (id: string, options: { force?: boolean }) => {
        const manager = await createManager(deps);
        const removed = await manager.remove(id, { force: options.force === true });
        deps.stdout(`removed ${removed.path}`);
      }),
    );

  worktree
    .command('list')
    .description('List sentinel worktrees')
    .option('--json', 'output machine-readable JSON')
    .action(
      guarded(deps, async (options: { json?: boolean }) => {
        const manager = await createManager(deps);
        const items = await manager.list();
        deps.stdout(
          options.json === true
            ? JSON.stringify(items, null, 2)
            : items.map((w) => `${w.branch ?? '(detached)'}  ${w.path}`).join('\n'),
        );
      }),
    );

  worktree
    .command('prune')
    .description('Remove clean worktrees whose branch is merged into the default branch')
    .option('--dry-run', 'only report what would be removed')
    .action(
      guarded(deps, async (options: { dryRun?: boolean }) => {
        const manager = await createManager(deps);
        const result = await manager.prune({ dryRun: options.dryRun === true });
        for (const warning of result.warnings) deps.stderr(`sentinel: warning: ${warning}`);
        const verb = options.dryRun === true ? 'would remove' : 'removed';
        for (const w of result.removed) deps.stdout(`${verb} ${w.path}`);
        for (const s of result.skipped) deps.stdout(`kept ${s.worktree.path} (${s.reason})`);
        deps.setExitCode(ExitCode.Ok);
      }),
    );
}
