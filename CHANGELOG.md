# @robert-nagy/sentinel

## 0.3.0

### Minor Changes

- 7a216b9: Add `sentinel babysit <pr> [--once]`: reads CI results through `gh`, parses failed logs (tsc, eslint, vitest/jest, pytest, go, dotnet, cargo, generic stack traces) into a failure packet with a stable signature, re-runs a suspected infrastructure failure once, hands real failures to the agent (exit 2), and gives up with a PR comment (exit 3) after the attempt budget, three fixes of the same failure, or the timeout.
- ffdd409: Add `sentinel guardrails write`: writes a managed guardrail block to `AGENTS.md` (idempotent, `--dry-run`, CRLF-safe) and an `@AGENTS.md` pointer to an existing `CLAUDE.md`. The plugin ships the same rules as an always-on Cursor rule, and skill files are linted (frontmatter, no hard-coded tracker, every named command exists in the bundle).
- b3a10b9: Add `sentinel mine search|draft|create`: `search` lists popular comparable repositories through `gh`; `draft` turns the agent's findings into an approval list (`docs/feature-gaps.md`); `create` files only the ticked gaps, skipping likely duplicates, either in the local tracker or as a list for the agent to file with its own tracker tools.
- 2416c0e: Package sentinel as a plugin marketplace (ADR-0006): the repository root is a catalog for Claude Code, VS Code / Copilot, Codex and Cursor, and the CLI ships as a single dependency-free `scripts/sentinel.mjs` inside every skill. Adds a placeholder `sentinel-doctor` skill; the config JSON Schema is now committed under `schema/`.
- 425285b: Add `sentinel setup`: a question bank (core questions plus SLA, security, journey, integration and compliance follow-ups) whose answers are saved to `.sentinel/domain.json`, empty-repo stack proposal data, stack-parameterised GitHub test workflows (unit, integration and e2e on push and pull request; load on demand or weekly) and a README renderer with Mermaid context and container diagrams. Works from an answers file for agents or interactively in a terminal.
- d6807a6: Add the `sentinel-prd`, `sentinel-sdlc` and `sentinel-sdlc-auto` skills and the `sentinel-reviewer` sub-agent. Each skill repeats the guardrails and reaches the issue tracker only through `sentinel issue resolve`.

## 0.2.0

### Minor Changes

- 565de31: Make issue trackers agent-native (ADR-0005): `issueProvider` now records intent only (`tracker`, `location`, `notes`, `labelMap`, `localDir`) and the agent reaches the tracker with its own MCP servers or CLIs. Add `sentinel issue resolve|detect|use|describe`, which decides deterministically which tracker to use (configured → the only reachable one that doesn't conflict with the git remote → ask → local fallback), and a built-in local Markdown tracker managed with `sentinel issue create|get|list|comment|label|close|reopen`. `sentinel issue duplicates` ranks candidate issues (listed by the agent, or from the local tracker) by title similarity. `sentinel pr create` now takes `--title` and no longer reads the issue. The built-in GitHub and custom issue providers, `issue link`, `issue describe-provider` and the `issueProvider.type`/`options` keys are removed.
- 66e3c33: Add layered configuration (`sentinel.config.json`, global + repo, validated with a published JSON Schema), a branch-name resolver (`sentinel branch name`), `sentinel config show|path|schema`, and a file-based state store.
- ff24fb5: Add the issue tracker layer and code host: `sentinel issue get|list|create|comment|link|duplicates|describe-provider` (GitHub Issues via `gh`, or any tracker through the `custom` provider's command templates), and `sentinel pr create --issue <id>` (GitHub). Provider and authentication failures exit with code 4.
- 178dc2f: Add `sentinel analyze`: detects projects (node, python, go, rust, java, dotnet, ruby, php), frameworks and the test tooling in use for each of the four test tiers, with per-ecosystem recommendations. `--install` prints the commands to install missing tooling.
- 59913e0: Add `sentinel worktree add|remove|list|prune`: per-issue git worktrees on the configured branch template, reusing existing branches, copying configured files, keeping the worktree root git-ignored, supporting Windows long paths, refreshing `origin` before pruning, hinting when worktrees pile up, and a `doctor` warning for the same.
- fed7e31: Add the PRD quality loop: `sentinel prd validate <file> [--scores scores.json]` checks structure (context, FR-n with Given/When/Then, measurable NFRs, security, data models, API contracts, test matrix) and ambiguity, caps each score dimension at what the structure supports, and decides accept / refine / escalate (mean ≥ 85, each dimension ≥ 70, three refinements). Iteration state is kept per PRD; `sentinel prd status <slug>` shows it. Exit codes: 0 accept, 2 refine, 3 escalate.
- e6adc02: Add `sentinel prd new <slug>` (IEEE 29148-aligned PRD template; unfilled `TODO` markers keep it from passing validation), `sentinel prd rubric` (scoring rubric for the five dimensions) and `sentinel rfc new <issue-id>` (technical design template at `docs/rfcs/issue-<id>.md`).

### Patch Changes

- 822ed93: `sentinel worktree prune` now also asks GitHub whether a pull request from the branch was merged, so squash- and rebase-merged worktrees are cleaned up. If the code host is unavailable it warns and falls back to the local check.
- 2ecc2ec: Stop publishing to npm (ADR-0006): the package is now private, the release workflow tags `vX.Y.Z` and creates a GitHub Release instead of running `npm publish`, and CI smoke-tests the built CLI directly instead of an installed tarball. sentinel will be distributed as a plugin marketplace from this repository.

## 0.1.0

### Minor Changes

- 8b14b1c: Project foundation: TypeScript CLI skeleton with `sentinel --version` and `sentinel doctor` (Node.js, git, git repository, GitHub CLI and auth, Windows `core.longpaths` checks; `--json` output).

### Patch Changes

- 496cc63: `sentinel doctor` is faster and more robust: independent git and gh checks run concurrently, every external command is bounded to 10 s, and a timed-out command is reported as a warning instead of being mistaken for a failure (e.g. "not authenticated").
