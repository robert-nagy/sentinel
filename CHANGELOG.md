# @robert-nagy/sentinel

## 0.2.0

### Minor Changes

- 565de31: Make issue trackers agent-native (ADR-0005): `issueProvider` now records intent only (`tracker`, `location`, `notes`, `labelMap`, `localDir`) and the agent reaches the tracker with its own MCP servers or CLIs. Add `sentinel issue resolve|detect|use|describe`, which decides deterministically which tracker to use (configured → the only reachable one that doesn't conflict with the git remote → ask → local fallback), and a built-in local Markdown tracker managed with `sentinel issue create|get|list|comment|label|close|reopen`. `sentinel issue duplicates` ranks candidate issues (listed by the agent, or from the local tracker) by title similarity. `sentinel pr create` now takes `--title` and no longer reads the issue. The built-in GitHub and custom issue providers, `issue link`, `issue describe-provider` and the `issueProvider.type`/`options` keys are removed.
- 66e3c33: Add layered configuration (`sentinel.config.json`, global + repo, validated with a published JSON Schema), a branch-name resolver (`sentinel branch name`), `sentinel config show|path|schema`, and a file-based state store.
- ff24fb5: Add the issue tracker layer and code host: `sentinel issue get|list|create|comment|link|duplicates|describe-provider` (GitHub Issues via `gh`, or any tracker through the `custom` provider's command templates), and `sentinel pr create --issue <id>` (GitHub). Provider and authentication failures exit with code 4.
- 178dc2f: Add `sentinel analyze`: detects projects (node, python, go, rust, java, dotnet, ruby, php), frameworks and the test tooling in use for each of the four test tiers, with per-ecosystem recommendations. `--install` prints the commands to install missing tooling.
- 59913e0: Add `sentinel worktree add|remove|list|prune`: per-issue git worktrees on the configured branch template, reusing existing branches, copying configured files, keeping the worktree root git-ignored, supporting Windows long paths, refreshing `origin` before pruning, hinting when worktrees pile up, and a `doctor` warning for the same.

### Patch Changes

- 822ed93: `sentinel worktree prune` now also asks GitHub whether a pull request from the branch was merged, so squash- and rebase-merged worktrees are cleaned up. If the code host is unavailable it warns and falls back to the local check.

## 0.1.0

### Minor Changes

- 8b14b1c: Project foundation: TypeScript CLI skeleton with `sentinel --version` and `sentinel doctor` (Node.js, git, git repository, GitHub CLI and auth, Windows `core.longpaths` checks; `--json` output).

### Patch Changes

- 496cc63: `sentinel doctor` is faster and more robust: independent git and gh checks run concurrently, every external command is bounded to 10 s, and a timed-out command is reported as a warning instead of being mistaken for a failure (e.g. "not authenticated").
