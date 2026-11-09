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
export { ProviderError, type ProviderErrorKind } from './core/provider-error.js';
export { DUPLICATE_THRESHOLD, rankDuplicates, titleSimilarity } from './core/duplicates.js';
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
  LOCAL_TRACKER,
  TRACKER_CLIS,
  TRACKER_VERBS,
  TrackerError,
  describeTracker,
  detectTrackerHints,
  forgeFromRemote,
  formatTrackerDescription,
  normalizeTracker,
  redactRemote,
  resolveTracker,
  saveTrackerChoice,
  type Forge,
  type ResolveTrackerInput,
  type TrackerDecision,
  type TrackerDescription,
  type TrackerHints,
  type TrackerOption,
} from './core/issue-tracker.js';
export {
  LocalTracker,
  parseLocalId,
  parseLocalIssue,
  renderLocalIssue,
  type LocalComment,
  type LocalIssue,
  type LocalIssueQuery,
  type LocalIssueStatus,
  type NewLocalIssue,
} from './core/local-tracker.js';
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
export {
  DIMENSIONS,
  ESCALATION_MESSAGE,
  analyzePrd,
  capsFor,
  decide,
  scoresSchema,
  validatePrd,
  type Dimension,
  type NextAction,
  type PrdIssue,
  type PrdReport,
  type Scores,
} from './core/prd-validator.js';
export { PrdError, evaluationsBefore, recordEvaluation, type PrdState } from './core/prd-state.js';
