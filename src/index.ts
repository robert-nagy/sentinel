export { VERSION } from './version.js';
export { ExitCode } from './core/exit-codes.js';
export {
  runCommand,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from './core/exec.js';
export {
  runDoctor,
  formatDoctorReport,
  type CheckResult,
  type CheckStatus,
  type DoctorContext,
  type DoctorReport,
} from './core/doctor/index.js';
export { createProgram, main, type CliDeps } from './cli/index.js';
export {
  BRANCH_TYPES,
  BranchNameError,
  inferBranchType,
  isValidBranchName,
  resolveBranchName,
  slugify,
  validateBranchTemplate,
  type BranchIssue,
  type BranchType,
  type ResolvedBranch,
} from './core/branch-namer.js';
export {
  DEFAULT_CONFIG,
  configJsonSchema,
  configSchema,
  userConfigSchema,
  type SentinelConfig,
  type UserConfig,
} from './core/config-schema.js';
export { ConfigError, loadConfig, globalConfigPath, type LoadedConfig } from './core/config.js';
export { StateStore, StateError } from './core/state.js';
export { nodeFiles, type FileAccess } from './core/fs.js';
export { findRepoRoot } from './core/repo.js';
export {
  ProviderError,
  resolveLabels,
  titleSimilarity,
  type Issue,
  type IssueProvider,
  type IssueQuery,
  type NewIssue,
  type ProviderCapabilities,
} from './core/issue-provider.js';
export { createIssueProvider } from './core/providers/index.js';
export { GitHubIssueProvider } from './core/providers/github.js';
export { CustomIssueProvider } from './core/providers/custom.js';
export {
  renderCommand,
  tokenizeTemplate,
  validateCommandTemplate,
} from './core/command-template.js';
export type { CheckRun, CodeHost, NewPullRequest, PullRequest } from './core/code-host.js';
export { GitHubCodeHost } from './core/hosts/github.js';
export {
  GitWorktreeManager,
  WORKTREE_CLEANUP_THRESHOLD,
  WorktreeError,
  parseWorktreeList,
  type CreateWorktreeResult,
  type PruneResult,
  type WorktreeInfo,
} from './core/git-worktree-manager.js';
export {
  TEST_TIERS,
  analyze,
  formatStackReport,
  installCommands,
  type Ecosystem,
  type ProjectReport,
  type StackReport,
  type TestTier,
} from './core/stack-analyzer.js';
