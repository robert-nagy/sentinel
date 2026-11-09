# sentinel — Implementation Plan

> **Status:** v3 — v2 decisions locked after the design-grilling session (2026-11-02); issue trackers revised on 2026-11-04 to use the host agent's own tooling (ADR-0005). See §11 for the full decision log.
> Source: _Refined Requirements Specification: `sentinel`_ (PDLC/SDLC platform spec + master generator prompt).
> Repo at planning time: empty (`README.md` = `# sentinel`), remote `github.com/robert-nagy/sentinel`, branch `main`.

---

## 1. What we're building

`sentinel` is a **public, MIT-licensed, cross-platform (Linux/macOS/Windows) npm CLI** published as **`@robert-nagy/sentinel`** (binary: `sentinel`). It governs the product and software lifecycle in a repo, from bootstrapping through PRDs to issue → PR, inside whatever AI coding tool the user runs.

Three layers, kept strictly separate:

| Layer                     | What it is                                                                                                                                                                                                                                                 | Runs where                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **A. Deterministic core** | TypeScript library + CLI: config, branch naming, stack detection, git worktrees, tracker resolution + local tracker, code host (PRs/CI), PRD structural validation, CI log parsing, state, file generation. Same input → same output; fully unit-testable. | `sentinel` CLI, MCP server                                              |
| **B. Skills**             | The workflow intelligence, written as **Agent Skills (`SKILL.md`)**: `sentinel-setup`, `sentinel-prd`, `sentinel-sdlc`, `sentinel-sdlc-auto`, `sentinel-babysit`, `sentinel-mine`, plus one sub-agent, `sentinel-reviewer`.                                | The host agent (Claude Code, Cursor, VS Code/Copilot, OpenCode, Codex…) |
| **C. Adapters**           | Small, per-tool installers: copy the skills, write the AGENTS.md/CLAUDE.md pointer, the Cursor guardrail rule, MCP config (each tool's own shape) and the reviewer sub-agent.                                                                              | `sentinel init`                                                         |

### Core principle: sentinel never calls an LLM _(decision Q1)_

The host agent does all the reasoning. Sentinel supplies (1) skills that tell the agent what to do and (2) deterministic tools the agent calls through the CLI or MCP. The same split applies to connections: **sentinel does not duplicate tracker clients the agent already has** (MCP servers, authenticated CLIs); it records which tracker to use and decides that deterministically (§4, ADR-0005). **Rules that matter are enforced in code, not prose**: the PRD threshold, per-dimension floor and iteration cap; babysitter attempt limits; branch naming; never committing to the default branch. No API keys, no model lock-in. Headless use is still possible later by running a host agent headless (e.g. `claude -p "/sentinel-babysit 42"` in CI); sentinel itself never owns a model.

---

## 2. Spec deviations (agreed)

| #   | Spec                                                                                                      | Plan                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm i -g sentinel`                                                                                       | `sentinel` is taken on npm (an old file-watcher). Publish **`@robert-nagy/sentinel`**; the binary is still `sentinel`.                                                                |
| 2   | `.js` files                                                                                               | **TypeScript**, built with `tsup` to ESM JS. Same module names as the spec, with a `.ts` extension.                                                                                   |
| 3   | Score = mean of 5 dimensions ≥ 85                                                                         | **Mean ≥ 85 and every dimension ≥ 70** (`dimensionFloor`, configurable).                                                                                                              |
| 4   | "up to 3 refinements" / "iteration > 3"                                                                   | Evaluation 0 = first draft; refinements 1–3; **max 4 evaluations**; escalate if refinement 3 still fails.                                                                             |
| 5   | "push fixes until green"                                                                                  | Capped: `maxAttempts` (default 5), stop when the same failure signature repeats twice, one flaky re-run before patching, never force-push, never push to the default branch.          |
| 6   | Auto-install test frameworks                                                                              | Propose → confirm. `--yes` for non-interactive runs.                                                                                                                                  |
| 7   | Per-tool commands/rules (`.claude/commands`, `.cursor/rules/*.mdc` for workflows, `.opencode/agent.json`) | Workflows are **skills** in `.agents/skills/` + `.claude/skills/` (every target tool reads one of these). Per-tool files shrink to guardrails, MCP config and the reviewer sub-agent. |
| 8   | Slash commands `/prd`, `/sdlc-worktree`, `/setup-repo`                                                    | Skills named **`/sentinel-setup`, `/sentinel-prd`, `/sentinel-sdlc`, `/sentinel-sdlc-auto`, `/sentinel-babysit`, `/sentinel-mine`**.                                                  |
| 9   | One "issue provider" concept                                                                              | Split into **`issueProvider`** (which tracker, recorded as intent) and **`codeHost`** (github only in v0.1). PRs, CI babysitting and generated workflows depend on `codeHost`.        |
| 10  | Issue providers: GitHub, Jira, Linear, Azure DevOps                                                       | **Any tracker the host agent can reach** (MCP server or CLI), plus a built-in **local markdown** tracker. Sentinel ships no remote tracker clients (ADR-0005).                        |
| 11  | `.agents/` "universal format"                                                                             | Concretely: **`AGENTS.md` + `.agents/skills/`** (the de facto cross-tool locations).                                                                                                  |
| 12  | Claude Desktop `mcp.json`                                                                                 | Merge into `claude_desktop_config.json` at the OS-specific path (global scope only).                                                                                                  |
| 13  | Feature mining creates issues directly                                                                    | Draft `docs/feature-gaps.md` first; create issues only for the items the user approves.                                                                                               |

---

## 3. Architecture

```
          ┌───────────────────────── sentinel CLI (commander) ─────────────────────────┐
          │ init · setup · analyze · branch · worktree · issue · prd · rfc · pr ·        │
          │ babysit · mine · mcp · doctor                       (all support --json)    │
          └──────────────┬─────────────────────────────────────────────┬───────────────┘
                         │                                             │
          ┌──────────────▼───────────────────┐          ┌──────────────▼──────────────┐
          │ src/core  (library)               │◄─────────│ src/mcp/server.ts (STDIO)    │
          │ config · exec · state             │  same fns│ tools + skill-backed prompts │
          │ branch-namer · stack-analyzer     │          └─────────────────────────────┘
          │ git-worktree-manager              │
          │ issue-tracker (resolve) · local-tracker      ┌─────────────────────────────┐
          │ code-host      → github           │          │ src/skills/  (SKILL.md ×6)   │
          │ prd-validator · log-parser        │          │ src/agents/sentinel-reviewer │
          │ pr-babysitter · socratic-engine   │          └──────────────┬──────────────┘
          └───────────────────────────────────┘                         │ installed by
                                                          ┌─────────────▼──────────────┐
                                                          │ src/adapters/  (6 targets)  │
                                                          └────────────────────────────┘
```

### 3.1 File tree

```text
sentinel/
├── bin/sentinel.ts                      # #!/usr/bin/env node → src/cli
├── src/
│   ├── cli/                             # one module per subcommand
│   ├── core/
│   │   ├── config.ts                    # zod schema, defaults, global+repo merge, JSON Schema export
│   │   ├── exec.ts                      # execa wrapper: dry-run, logging, injectable, Windows-safe
│   │   ├── state.ts                     # .sentinel/state/*.json
│   │   ├── socratic-engine.ts
│   │   ├── stack-analyzer.ts
│   │   ├── branch-namer.ts
│   │   ├── git-worktree-manager.ts
│   │   ├── issue-tracker.ts             # intent, aliases, forge detection, resolve rule, describe()
│   │   ├── local-tracker.ts             # the one tracker sentinel implements: Markdown files
│   │   ├── code-host.ts                 # interface: createPR, prStatus, checks, failedLogs, comment
│   │   ├── hosts/ github.ts
│   │   ├── prd-validator.ts
│   │   ├── log-parser.ts                # CI log → failure packet
│   │   └── pr-babysitter.ts
│   ├── mcp/server.ts
│   ├── skills/                          # canonical SKILL.md sources (templated at install)
│   │   ├── sentinel-setup/SKILL.md      (+ references/question-bank.md)
│   │   ├── sentinel-prd/SKILL.md        (+ references/rubric.md)
│   │   ├── sentinel-sdlc/SKILL.md
│   │   ├── sentinel-sdlc-auto/SKILL.md
│   │   ├── sentinel-babysit/SKILL.md
│   │   └── sentinel-mine/SKILL.md
│   ├── agents/sentinel-reviewer.md      # canonical body; rendered per tool
│   ├── adapters/
│   │   ├── base.ts                      # FileOp model, managed markers, JSON merge, backups, dry-run diff
│   │   ├── dot-agents.ts · claude-code.ts · claude-desktop.ts
│   │   └── cursor.ts · vscode.ts · opencode.ts
│   └── templates/
│       ├── prd-template.md · rfc-template.md · readme-template.md · feature-gaps-template.md
│       ├── sentinel-config.json
│       └── workflows/github/ ci.yml · security.yml · release.yml   # stack-parameterised
├── test/ unit/ · integration/ · e2e/ · fixtures/
├── .github/workflows/                   # sentinel's own CI
├── .changeset/
├── docs/ PLAN.md · adr/
├── LICENSE (MIT) · package.json · tsconfig.json · tsup.config.ts · README.md
```

---

## 4. Core modules

### `config.ts` — `sentinel.config.json` (repo); global defaults in `~/.config/sentinel/config.json` (`%APPDATA%\sentinel\config.json` on Windows)

```jsonc
{
  "$schema": "https://unpkg.com/@robert-nagy/sentinel/schema/config.json",
  "issueProvider": {
    // every field optional; omit the section and the tracker is resolved on first use
    "tracker": "linear", // free-form slug: github · gitlab · jira · linear · azure-devops · local · …
    "location": "team ENG", // where the work lives inside the tracker
    "notes": "Bugs go to the Triage project", // free-form guidance for the agent
    "labelMap": {
      // neutral label → this tracker's own label, issue type or status
      "kind/feature": "Feature",
      "kind/bug": "Bug",
      "priority/p1": "Urgent",
      "status/in-progress": "In Progress",
      "status/in-review": "In Review",
    },
    "localDir": "docs/issues", // used only when tracker = local
  },
  "codeHost": { "type": "github", "defaultBranch": "main" },
  "branches": {
    "feature": "feat/{issue_id}-{slug}",
    "bugfix": "fix/{issue_id}",
    "hotfix": "hotfix/{issue_id}-{slug}",
    "refactor": "refactor/{issue_id}-{slug}",
  },
  "worktrees": { "root": ".worktrees", "copyFiles": [".env.example"] },
  "prd": { "dir": "docs/prd", "threshold": 85, "dimensionFloor": 70, "maxRefinements": 3 },
  "rfc": { "dir": "docs/rfcs" },
  "babysit": { "maxAttempts": 5, "pollIntervalSec": 30, "timeoutMin": 60 },
  "testing": { "unit": null, "integration": null, "e2e": null, "load": null },
}
```

### `branch-namer.ts` — `resolveBranchName({ type?, issue }, config)`

- Placeholders: `{issue_id}`, `{slug}`, `{type}`, `{user}`, `{date}`. Unknown placeholder → error.
- Slug: NFKD transliteration, lowercase, `[a-z0-9-]`, max 40 chars, no leading or trailing `-`.
- Validated against `git check-ref-format` rules. Tracker-native IDs (`PROJ-123`, `ENG-42`, numeric ADO IDs) are allowed in `{issue_id}`.
- Infers the branch type from the labels or issue type the agent passes in (`kind/bug`, Jira/Linear/ADO `Bug` → `bugfix`). The agent reads the issue with its own tools and passes `--title`, `--label`, `--issue-type`.

### `stack-analyzer.ts` — `analyze(dir) → StackReport`

- Manifest detectors: `package.json` (+ lockfile → npm/pnpm/yarn/bun), `pyproject.toml`/`requirements*.txt`, `go.mod`, `Cargo.toml`, `pom.xml`/`build.gradle*`, `*.csproj`/`*.sln`, `Gemfile`, `composer.json`. Frameworks are detected from dependencies.
- Detects the test tooling already in use for each of the 4 tiers. Fills gaps from a per-ecosystem recommendation table (e.g. TS: vitest / vitest+testcontainers / playwright / k6; Python: pytest / pytest+testcontainers / playwright / locust; Go: testing / testcontainers-go / playwright / k6; .NET: xUnit / Testcontainers / Playwright / k6).
- Empty repo → `{ empty: true }`. In that case `sentinel-setup` has the agent propose a stack from the domain answers for the user to confirm.
- `--install` prints the install commands for each tier and runs them only after confirmation.

### `issue-tracker.ts` — which tracker, decided in code _(ADR-0005)_

Sentinel does **not** talk to remote trackers. The host agent reads and writes issues with the connections it already has (an Atlassian, Linear, GitHub or Azure DevOps MCP server; `gh`, `glab`, `az`). Sentinel owns the two things the agent cannot discover from its tool list: **which tracker is canonical**, and **how the team names things there**.

Skills describe tracker work only as neutral verbs, carried out with whatever tool fits:

| Verb         | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `get`        | read one issue: id, title, body, labels/type, status                    |
| `list`       | find issues by text, label or status                                    |
| `dedupe`     | before `create`: list likely matches, rank them with `issue duplicates` |
| `create`     | file an issue (labels/type/priority via `labelMap`)                     |
| `comment`    | add a comment                                                           |
| `set-status` | move an issue to `labelMap["status/<name>"]` (e.g. _In Progress_)       |
| `link-pr`    | connect a PR to the issue (tracker link, or `Fixes <id>` in the body)   |
| `close`      | close or resolve the issue                                              |

**Resolution rule** — `resolveTracker({ config, available, remoteForge })`, exposed as `sentinel issue resolve --available <slugs>`. The agent lists the trackers it can reach; sentinel reads the git remote. Slugs are normalised (`gh` → `github`, `atlassian` → `jira`, `ado` → `azure-devops`…).

| Situation                                                          | Action        | Then                                                                 |
| ------------------------------------------------------------------ | ------------- | -------------------------------------------------------------------- |
| `issueProvider.tracker` configured and reachable (or not reported) | `use`         | —                                                                    |
| configured, but the agent reports it unreachable                   | `unavailable` | tell the user which connection is missing (exit 4)                   |
| nothing configured; exactly one reachable, no conflict with remote | `use`         | offer to save it (`sentinel issue use`)                              |
| several reachable, or the only one conflicts with the remote forge | `ask`         | ask the user once (the remote's forge is recommended first), save it |
| none reachable                                                     | `fallback`    | use the local tracker                                                |

A "conflict" is a remote on an issue-hosting forge (GitHub, GitLab, Azure DevOps, Bitbucket) whose tracker the agent cannot reach while it can reach another one: the repo might well track work on the forge, so sentinel asks instead of guessing.

Other commands:

- `sentinel issue detect` — hints for the agent: the remote's forge, and which tracker CLIs are installed.
- `sentinel issue use <tracker> [--location] [--notes] [--label neutral=native]` — saves the decision to the repo's `sentinel.config.json`, leaving other keys untouched.
- `sentinel issue describe` — agent-facing instructions for the configured tracker: location, notes, label map and the verb contract (and the CLI commands when it is `local`).
- `sentinel issue duplicates <title> [--candidates <file>]` — ranks candidate issues by title similarity (Jaccard ≥ 0.5). The agent lists candidates with its own tools; the local tracker supplies its own. This keeps mining's de-duplication rule in code for every tracker.

### `local-tracker.ts` — the built-in fallback

Issues as Markdown files with front matter (`id`, `title`, `status: open|closed`, `labels`, `created`) under `issueProvider.localDir` (default `docs/issues`), named `<id>-<slug>.md`, committed with the repo. Ids are sequential integers. Comments are appended under a `## Comments` heading. `sentinel issue create|get|list|comment|close` operate on it; for any other tracker they exit with code 4 and point the agent at its own tooling.

### `code-host.ts` — GitHub only in v0.1

`sentinel pr create --issue <id> --title <title> [--issue-url <url>] --title <title>` pushes the branch and opens the PR. It does not read the issue: the body gets `Closes #<id>` when the tracker is GitHub, `Refs local issue <id>` (plus a PR-link comment on the local issue) when it is local, and `Refs <id>[: <url>]` otherwise, after which the agent links the PR with its own tools.

`createPullRequest`, `getPullRequest`, `listChecks`, `getFailedLogs` (`gh run view --log-failed`), `rerunFailed`, `comment`. The interface is ready for an Azure Repos/Pipelines host later.

### `git-worktree-manager.ts`

- `create(issueId, type?)`: resolve the branch → `git fetch` → `git worktree add <root>/<issue-id> -b <branch> origin/<defaultBranch>` → copy `copyFiles` → make sure `<root>/` is in `.gitignore`. Moving the issue to _In Progress_ is a skill step (`set-status` with `labelMap["status/in-progress"]`), done by the agent with its own tracker tooling.
- Edge cases: branch already exists (reuse it), directory already exists, Windows path length and `core.longpaths`, dirty main tree (warn).
- `remove(issueId)`, `prune()` (removes worktrees whose PR is merged, using the code host).

### `prd-validator.ts` — `validate(markdown, { scores?, slug })`

- **Structural checks**:
  - Context/problem statement present.
  - Every `FR-n` has at least one Given/When/Then scenario.
  - NFRs are measurable (number + unit).
  - Security covers authentication, authorisation/RBAC and input validation.
  - Data models and API contracts are present.
  - The test matrix covers unit, integration, E2E and load.
  - Ambiguity lint: "fast", "user-friendly", "etc.", "as appropriate", "TBD"…
- **Score caps**: each structural failure caps its dimension (e.g. a missing GWT for FR-3 caps Testability at 60), so the agent's self-scores can't go above what the structure supports.
- **Decision**: `pass = mean ≥ threshold && min ≥ dimensionFloor`. `nextAction ∈ accept | refine | escalate`. The iteration count is stored in `.sentinel/state/prd-<slug>.json`.
- **Escalation**, verbatim: `Confidence threshold not met. Recommended action: Escalate to a higher-reasoning model.`
- **Exit codes**: 0 accept · 2 refine · 3 escalate.

### `log-parser.ts` + `pr-babysitter.ts`

- Parsers for vitest/jest, pytest, go test, tsc, eslint, dotnet, cargo and generic stack traces. The output is a _failure packet_: `{ signature, jobs[], errors[{file,line,message,excerpt}], suspectedFlaky }`.
- State machine: `POLL → pending: wait | green: DONE | red: FETCH_LOGS → PARSE → (first time this signature appears: RERUN_ONCE) → EMIT_PACKET → [agent patches & pushes] → POLL`. It ends in `GIVE_UP` (with a summary comment on the PR) after `maxAttempts`, a signature repeated twice, or timeout.
- Modes: `--once` (agent-driven; prints the packet and exits; used by the skills) and `--watch` (terminal poller).

### `socratic-engine.ts`

- Question bank as data: the spec's 4 core questions, plus follow-up branches for SLAs/NFRs, security boundaries, core user journeys, integrations and compliance (a PII answer triggers the compliance branch).
- Two modes: `sentinel setup` (interactive terminal, `@inquirer/prompts`) and agent-driven (the skill asks the questions in chat, then calls `sentinel setup --answers answers.json`).
- Answers are saved to `.sentinel/domain.json`. `renderReadme()` produces a README with domain context and Mermaid context/container diagrams.

---

## 5. Skills (layer B)

All skills follow the Agent Skills spec: a folder with `SKILL.md`; `name` must match the folder and be lowercase-hyphenated; `description` is at most 1024 chars. Claude Code-specific frontmatter (`argument-hint`, `disable-model-invocation`) is included; other tools ignore unknown fields.

**Pinned CLI invocation (decision Q16a).** Skill bodies use a `{{SENTINEL}}` token. `sentinel init` replaces it with `npx -y @robert-nagy/sentinel@<installed-version>`, so the skills always match the CLI that generated them and need no global install. Re-running `init` after an upgrade re-pins the version. `sentinel doctor` warns when installed skills and the CLI version differ.

| Skill                | Phase | Behaviour                                                                                                                                                                                                                                                                          | `disable-model-invocation`       |
| -------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `sentinel-setup`     | 0     | Detect empty state → grilling → stack proposal/analysis → choose test tiers (confirm installs) → scaffold folders + GitHub workflows → README + diagrams → bootstrap branch + PR → hand off to babysit.                                                                            | true                             |
| `sentinel-prd`       | 1     | Draft the PRD from the template using `.sentinel/domain.json` and the issue → self-score with the rubric → `prd validate` → refine (≤3) → accept or escalate.                                                                                                                      | false (the agent may suggest it) |
| `sentinel-mine`      | 1     | `gh search repos` for comparable high-star projects → extract feature/API surfaces → gap list in `docs/feature-gaps.md` → **stop for user approval** → `issue resolve` → `list` candidates + `issue duplicates` to skip duplicates → `create` the approved issues with `labelMap`. | true                             |
| `sentinel-sdlc`      | 2     | `issue resolve` → `get` the issue → dependencies → worktree + `set-status` in progress → RFC `docs/rfcs/issue-<id>.md` → **STOP for RFC approval** → TDD (unit/integration/E2E) → `sentinel-reviewer` → docs sync → PR + `link-pr` → babysit loop.                                 | true                             |
| `sentinel-sdlc-auto` | 2     | Same as `sentinel-sdlc` with no RFC stop; still never merges.                                                                                                                                                                                                                      | true                             |
| `sentinel-babysit`   | 2     | Run `babysit --once` in a loop: read the packet → patch → push → repeat until green or `GIVE_UP`.                                                                                                                                                                                  | true                             |

Shared guardrails (repeated in every skill and in AGENTS.md):

- never commit to or push to the default branch
- never force-push
- never merge
- never edit outside the worktree during an SDLC run
- always use `{{SENTINEL}} branch name` for branch names
- reach the issue tracker only through `{{SENTINEL}} issue resolve`'s answer: never pick a tracker on your own when it says `ask`, and never write issues to a tracker it did not return

**`sentinel-reviewer` sub-agent (decision Q14b).** A fresh-context reviewer of the diff. Checklist:

- injection
- secrets in the diff
- missing authZ
- unhandled errors and rejected promises
- unsafe deserialisation
- unvalidated input
- missing tests for each tier
- docs left out of sync

It returns findings as JSON. On tools without sub-agents (Cursor), `sentinel-sdlc` runs the same checklist inline.

---

## 6. Adapters (layer C) — verified formats

| Target                | Repo scope                                                                                                                                                                                                                                                                                                   | Global scope                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`.agents`**         | `AGENTS.md` (managed block: project context + guardrails + skill index); `.agents/skills/sentinel-*/`                                                                                                                                                                                                        | `~/.agents/skills/sentinel-*/`                                                                                                                                                                  |
| **Claude Code**       | `.claude/skills/sentinel-*/` (a copy, decision Q10a); `.claude/agents/sentinel-reviewer.md` (`name`, `description`, `tools`); `.mcp.json` → `mcpServers.sentinel {type:"stdio", command:"npx", args:[…]}`; `CLAUDE.md` managed block with `@AGENTS.md` (Claude Code ignores AGENTS.md when CLAUDE.md exists) | `~/.claude/skills/`, `~/.claude/agents/`                                                                                                                                                        |
| **Claude Desktop**    | —                                                                                                                                                                                                                                                                                                            | Merge `mcpServers.sentinel` into `claude_desktop_config.json`: macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/`. Timestamped backup first. |
| **Cursor**            | `.cursor/rules/sentinel-guardrails.mdc` (`alwaysApply: true`); `.cursor/mcp.json` → `mcpServers`. Skills come from `.agents/skills/` (auto-enables the `.agents` target).                                                                                                                                    | `~/.cursor/rules/sentinel-guardrails.mdc`, `~/.cursor/mcp.json`                                                                                                                                 |
| **VS Code / Copilot** | `.vscode/mcp.json` → **`servers`** key; `.github/agents/sentinel-reviewer.agent.md`; `.vscode/tasks.json` (analyze, doctor, babysit --watch); `.github/copilot-instructions.md` managed pointer to AGENTS.md (for Copilot surfaces that skip AGENTS.md). Skills come from `.agents/skills/`.                 | `~/.copilot/agents/`                                                                                                                                                                            |
| **OpenCode**          | `opencode.json` → `mcp.sentinel {type:"local", command:["npx","-y",…], enabled:true}` (`$schema: https://opencode.ai/config.json`); `.opencode/agents/sentinel-reviewer.md` (`mode: subagent`). Skills come from `.agents/skills/`.                                                                          | `~/.config/opencode/opencode.json`, `~/.config/opencode/agents/`                                                                                                                                |

Adapter mechanics (`base.ts`):

- `render(ctx) → FileOp[]` (`write | mergeJson | managedBlock`), applied by one shared writer.
- Every generated file or block carries a `sentinel:managed v<version>` marker. Re-runs replace only managed content, so user edits survive.
- `--dry-run` prints a unified diff; `--force` overwrites unmanaged conflicts; global JSON merges always back up first.
- Format knowledge (paths, keys, frontmatter) is centralised in one `targets.ts` table with source links, so changing format rules is a one-file update. ADR-0001 records the research (2026-11-02). Watch item: OpenCode V2 (beta) moves MCP config to `mcp.servers`.

---

## 7. CLI surface

```
sentinel init [--scope repo|global] [--targets agents,claude-code,claude-desktop,cursor,vscode,opencode]
              [--tracker <slug>] [--yes] [--dry-run] [--force]
sentinel setup [--answers answers.json]                      # Phase 0 (interactive or agent-fed)
sentinel analyze [--json] [--install]
sentinel branch name --issue <id> [--type feature|bugfix|hotfix|refactor]
sentinel worktree add <id> [--type] | remove <id> | prune
sentinel issue resolve [--available <slugs>] | detect | use <tracker> | describe
sentinel issue duplicates <title> [--candidates <file>]
sentinel issue create|get|list|comment|label|close|reopen    # local tracker only
sentinel prd new <slug> | validate <file> [--scores scores.json] | status <slug>
sentinel rfc new <issue-id>
sentinel pr create --issue <id>
sentinel babysit <pr> [--once|--watch]
sentinel mine search|draft|create --approved docs/feature-gaps.md
sentinel mcp                                                   # STDIO MCP server
sentinel doctor                                                # tools, auth, config, skill-version drift
```

Every command supports `--json`. Exit codes: 0 ok · 2 threshold not met / refine · 3 escalate / give-up · 4 provider/auth error · 5 config error.

MCP tools mirror the CLI: `analyze_stack`, `resolve_branch`, `worktree_create/remove`, `issue_resolve/use/describe/duplicates`, `local_issue_get/list/create/comment/close`, `prd_validate`, `rfc_scaffold`, `pr_create`, `ci_status`, `ci_failure_packet`. MCP **prompts** expose the six skills, so Claude Desktop (which has no skill folders) still gets the workflows.

---

## 8. Tooling & dependencies

| Need             | Choice                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | **Node ≥ 22** (Node 20 reached end of life in April 2026), ESM                                                            |
| Language / build | TypeScript (strict), `tsup`                                                                                               |
| CLI / prompts    | `commander`, `@inquirer/prompts`                                                                                          |
| Exec             | `execa`                                                                                                                   |
| Config           | `zod` + `zod-to-json-schema`                                                                                              |
| MCP              | `@modelcontextprotocol/sdk`                                                                                               |
| Markdown         | `unified`, `remark-parse`, `remark-frontmatter`, `remark-gfm` (no tracker format conversion: that is the connector's job) |
| HTTP             | native `fetch` + small retry/backoff helper                                                                               |
| Tests            | `vitest`, `nock`/`msw` (HTTP fixtures), real `git` in temp dirs                                                           |
| Quality          | `eslint`, `prettier`, `tsc --noEmit`                                                                                      |
| Release          | `changesets` → npm publish with provenance (GitHub OIDC)                                                                  |
| License          | MIT                                                                                                                       |

---

## 9. Milestones

Each milestone ends with a merged PR on `main` and green CI on **ubuntu, macOS and Windows × Node 22/24**.

### M0 — Foundation (≈1–2 days)

- [ ] `package.json` (`@robert-nagy/sentinel`, `bin`, `engines.node >=22`, `files`, `exports`), TS strict, tsup, vitest, eslint/prettier, MIT LICENSE.
- [ ] Sentinel's own CI: `ci.yml` (3-OS matrix), `security.yml` (CodeQL + `npm audit` + dependency review), `publish.yml` (changesets + provenance; the filename must match the npm trusted-publisher config).
- [ ] CLI skeleton + `doctor` (node, git, gh, auth, Windows `core.longpaths`).
- [ ] ADR-0001 target formats (from the 2026-11-02 research), ADR-0002 "no LLM calls", ADR-0003 "skills as the canonical workflow format", ADR-0004 "issueProvider ≠ codeHost".

### M1 — Deterministic core (≈4 days)

- [ ] `config.ts` + schema + JSON Schema publishing + global/repo merge (OS-specific paths).
- [ ] `exec.ts`, `state.ts`.
- [ ] `branch-namer.ts`: exhaustive tests (unicode, long titles, Jira keys, invalid refs).
- [ ] `stack-analyzer.ts`: fixtures for ~9 ecosystems + the empty repo.
- [ ] `git-worktree-manager.ts`: integration tests with real git and a bare origin, on all 3 OSes.
- [x] ~~`issue-provider.ts` + `providers/github.ts` + `providers/custom.ts`~~ (merged in #11, replaced by the line below per ADR-0005); `code-host.ts` + `hosts/github.ts`.
- [ ] `issue-tracker.ts` (intent config, slug aliases, remote forge detection, resolution rule, describe) + `local-tracker.ts` + `duplicates.ts`.
- [ ] CLI: `analyze`, `branch`, `worktree`, `issue`, `pr create`.

### M2 — PRD & RFC quality loop (≈3 days)

- [ ] `prd-template.md` (IEEE 29148-aligned), `rfc-template.md`, rubric reference.
- [ ] `prd-validator.ts`: structure, ambiguity lint, caps, mean + floor, iteration state, escalation, exit codes.
- [ ] `prd new|validate|status`, `rfc new`.
- [ ] Golden tests: good / borderline / bad PRDs → expected scores, gaps and actions.

### M3 — Skills, adapters, `init` (≈4 days)

- [ ] Write the 6 skills + `sentinel-reviewer`; `{{SENTINEL}}` pinning.
- [ ] `adapters/base.ts` + `targets.ts` + 6 adapters, for repo and global scope.
- [ ] `sentinel init`: interactive flow (scope → targets → code host → branch templates; the tracker is resolved lazily, or recorded with `--tracker`) + a fully flag-driven mode.
- [ ] Skills use only the neutral tracker verbs and `issue resolve`; a lint test fails if a skill hard-codes `gh issue`, `glab issue` or a tracker REST call.
- [ ] Snapshot tests per adapter × scope × OS-path; idempotency test (running init twice changes nothing, and user edits outside managed blocks survive); test that the skill frontmatter is valid Agent Skills.

### M4 — MCP server (≈2 days)

- [ ] Tools + skill prompts over STDIO.
- [ ] Integration test via the SDK client (spawn, list, call every tool).
- [ ] Manual smoke test in Claude Desktop, Claude Code, Cursor, VS Code and OpenCode.

### M5 — Phase 0: `sentinel-setup` (≈3 days)

- [ ] Socratic engine + question bank + `.sentinel/domain.json`.
- [ ] Empty-state detection; stack proposal flow.
- [ ] Stack-parameterised GitHub workflow templates (4 tiers as separate jobs; load tests on `workflow_dispatch`/schedule only).
- [ ] README renderer with Mermaid; bootstrap PR via branch-namer + code host.

### M6 — Babysitter & mining (≈3–4 days)

- [ ] `log-parser.ts` + fixtures for each toolchain.
- [ ] `pr-babysitter.ts` state machine, `--once` / `--watch`, flaky re-run, signature dedupe, give-up comment.
- [ ] `sentinel mine` search → draft → approved-create, with dedupe via `findDuplicates`.

### M7 — Tracker coverage, without clients (≈1 day)

_Was "Jira & Azure DevOps trackers (≈4 days)"; replaced by ADR-0005._

- [ ] Manual smoke test of `sentinel-sdlc` and `sentinel-mine` against GitHub (`gh`), Jira (Atlassian MCP), Linear (Linear MCP) and the local tracker; record the `labelMap` each needed.
- [ ] Document the resolution rule and `labelMap` examples per tracker in the README.

### M8 — Hardening & 0.1.0 release (≈2–3 days)

- [ ] E2E: `npm pack` → install the tarball in a temp dir on 3 OSes → `init --yes` for all targets → assert the file tree; dogfood one real issue through `/sentinel-sdlc` to a green PR on this repo.
- [ ] Docs: README (install, `npx`, quickstart per tool, config reference, tracker setup), CONTRIBUTING, SECURITY.md, CODE_OF_CONDUCT.
- [ ] Publish `0.1.0` with provenance.

**Total ≈ 4 weeks for one developer.** M0–M4 is the minimum usable product: config, branches, worktrees, PRD validation, and skills installed into every tool, plus MCP.

---

## 10. Testing sentinel itself

| Tier        | Scope                                                                                                                                    | Tooling          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Unit        | branch-namer, validator rules, log-parser, analyzer detectors, adapter `render()`, tracker resolution table, local tracker               | vitest           |
| Integration | worktrees with real git; code host against recorded HTTP; MCP via SDK client; adapter writer on temp dirs (incl. JSON merge and backups) | vitest, nock/msw |
| E2E         | packed tarball → `init` / `analyze` / `branch` / `prd validate` on fixture repos, ×3 OSes                                                | vitest + execa   |
| Performance | `analyze` on a 10k-file synthetic monorepo < 2 s; MCP round-trip < 200 ms                                                                | vitest bench     |

Coverage gate: 85% lines on `src/core`.

---

## 11. Decision log (grilling session, 2026-11-02)

| #   | Decision                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Sentinel **never calls an LLM**; the host agent reasons, sentinel enforces.                                                                                                          |
| Q2  | Audience: **public open-source tool**.                                                                                                                                               |
| Q3  | ~~Built-in trackers: GitHub Issues, Jira, Azure DevOps; others via Custom.~~ Superseded by Q17.                                                                                      |
| Q4  | **TypeScript** (tsup build).                                                                                                                                                         |
| Q5  | Both modes available: RFC checkpoint and full autonomy (see Q12).                                                                                                                    |
| Q6  | PRD pass = **mean ≥ 85 and each dimension ≥ 70**.                                                                                                                                    |
| Q7  | Mining writes a **draft list for approval** before creating issues.                                                                                                                  |
| Q8  | Package **`@robert-nagy/sentinel`**, binary `sentinel`.                                                                                                                              |
| Q9  | Workflows are **Agent Skills**, prefixed `sentinel-`: setup, prd, sdlc, sdlc-auto, babysit, mine.                                                                                    |
| Q10 | Skills **copied** to both `.agents/skills/` and `.claude/skills/`.                                                                                                                   |
| Q11 | ~~Jira gets a built-in REST v3 tracker.~~ Superseded by Q17.                                                                                                                         |
| Q12 | **`sentinel-sdlc`** stops for RFC approval; **`sentinel-sdlc-auto`** runs to a green PR without stopping. Neither merges.                                                            |
| Q13 | **`issueProvider` separate from `codeHost`**; code host is GitHub only in v0.1.                                                                                                      |
| Q14 | Only **`sentinel-reviewer`** is a sub-agent; other roles are folded into skills.                                                                                                     |
| Q15 | **MIT**; **Windows fully supported** (CI matrix + real path/worktree tests).                                                                                                         |
| Q16 | `init` **pins** skills to `npx -y @robert-nagy/sentinel@<version>`; `doctor` detects drift.                                                                                          |
| Q17 | _(2026-11-04)_ **Tracker-agnostic**: the agent uses its own MCP/CLI connections; config keeps intent only; lazy, coded resolution rule; built-in local markdown fallback (ADR-0005). |

Unverified facts to re-check in M0:

- the owner and status of the npm `sentinel` package (only matters if we ever want the unscoped name);
- OpenCode V2's config shape;
- the full Copilot custom-agent frontmatter reference;
- whether Cursor supports a global `~/.cursor/commands` folder (not needed by this plan).

---

## 12. Risks

| Risk                                    | Mitigation                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tool formats keep changing              | All format knowledge in `targets.ts` + ADR with sources; snapshot tests; `doctor` version-drift checks                  |
| Agents ignore skill instructions        | Enforcement lives in CLI/MCP (exit codes, state, caps); guardrails repeated in AGENTS.md and the Cursor always-on rule  |
| Babysitter makes things worse           | Attempt caps, signature dedupe, flaky re-run, give-up comment, never force-push                                         |
| Mining floods trackers                  | Draft + approval + dedupe (agent lists candidates, `issue duplicates` ranks them in code)                               |
| Agent files issues in the wrong tracker | Coded resolution rule; `ask` on any ambiguity; decision saved to the repo config so every teammate gets the same answer |
| Global writes clobber user config       | JSON merge, timestamped backups, `--dry-run`                                                                            |
| Windows paths / long paths / CRLF       | 3-OS CI; `path` APIs only; `.gitattributes`; `doctor` checks `core.longpaths`                                           |
| Tracker connector missing or broken     | `issue resolve` reports `unavailable` with the configured tracker; the local tracker keeps work moving                  |
| `npx` first-run latency in skills       | Documented; users may `npm i -g` and `doctor` confirms the version matches                                              |
