import { BranchNameError } from '../core/branch-namer.js';
import { ConfigError } from '../core/config.js';
import { ExitCode } from '../core/exit-codes.js';
import { WorktreeError } from '../core/git-worktree-manager.js';
import { ProviderError } from '../core/issue-provider.js';
import { PrdError } from '../core/prd-state.js';
import { ScaffoldError } from '../core/scaffold.js';
import { StateError } from '../core/state.js';
import type { CliDeps } from './deps.js';

/** Runs a command action, mapping expected domain errors to exit codes. */
export function guarded<Args extends unknown[]>(
  deps: CliDeps,
  action: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      if (error instanceof ConfigError) {
        deps.stderr(`sentinel: ${error.message}`);
        deps.setExitCode(ExitCode.Config);
      } else if (error instanceof ProviderError) {
        deps.stderr(`sentinel: ${error.message}`);
        deps.setExitCode(ExitCode.Provider);
      } else if (
        error instanceof BranchNameError ||
        error instanceof StateError ||
        error instanceof PrdError ||
        error instanceof ScaffoldError ||
        error instanceof WorktreeError
      ) {
        deps.stderr(`sentinel: ${error.message}`);
        deps.setExitCode(ExitCode.Failure);
      } else {
        throw error;
      }
    }
  };
}
