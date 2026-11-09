# sentinel

[![CI](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml)
[![Security](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Agentic product & software development lifecycle governance for AI coding tools.**

sentinel is a plugin that adds skills, guardrails and deterministic tooling to Claude Code,
VS Code / GitHub Copilot, Codex and Cursor. Your agent runs a governed workflow: a PRD that must
pass a quality gate, then issue → isolated worktree → RFC → test-driven implementation → pull
request.

> **Status: early development (pre-0.1.0).** The plugin installs from this repository and four
> skills ship today. Three more are planned and marked _coming soon_ below. See the
> [implementation plan](docs/PLAN.md) for the roadmap.

## How it works

sentinel never calls an LLM itself ([ADR-0002](docs/adr/0002-no-llm-calls.md)). The agent you
already use does the reasoning. sentinel provides the workflows as Agent Skills
([ADR-0003](docs/adr/0003-skills-as-canonical-workflows.md)), plus a CLI whose commands enforce
the rules in code: quality thresholds, retry caps, branch naming, never pushing to the default
branch. The CLI is bundled inside each skill as `scripts/sentinel.mjs`, so installing the plugin
is the whole setup ([ADR-0006](docs/adr/0006-marketplace-distribution.md)).

## Requirements

- Node.js ≥ 22
- git ≥ 2.25
- GitHub CLI (`gh`), signed in, for the GitHub code host

sentinel needs no issue-tracker credentials: your agent reaches the tracker with the connections it
already has (an MCP server or CLI for GitHub, Jira, Linear, Azure DevOps…). See
[ADR-0005](docs/adr/0005-agent-native-issue-trackers.md).

## Install

This repository is a plugin marketplace. Add it in your tool, then install the `sentinel` plugin.

| Tool              | How                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Claude Code       | `/plugin marketplace add robert-nagy/sentinel`, then `/plugin install sentinel@robert-nagy`                             |
| Codex             | `codex plugin marketplace add robert-nagy/sentinel`, then install `sentinel` from the plugin list                       |
| VS Code / Copilot | add `robert-nagy/sentinel` under the `chat.plugins.marketplaces` setting, or run _Chat: Install Plugin from Source_     |
| Cursor            | until sentinel is listed in Cursor's marketplace, copy or link `plugins/sentinel` to `~/.cursor/plugins/local/sentinel` |

OpenCode, Claude Desktop and plain `.agents/skills` setups are not supported for now. The VS Code
marketplace setting is experimental, and the plugin formats of all four tools are still moving.

## Quickstart

After installing, ask your agent in plain language. Each skill is also a slash command in tools that
support them.

1. **Check the setup.** "Run the sentinel-doctor skill." It runs the bundled CLI and reports Node,
   git, `gh` and configuration problems.
2. **Write a PRD.** "Use sentinel-prd to write a PRD for issue 42." The agent drafts the document
   from the template, scores itself against the rubric, and `sentinel prd validate` accepts it,
   asks for a refinement, or escalates after the refinement limit.
3. **Implement an issue.** "Use sentinel-sdlc on issue 42." The agent resolves your tracker, creates
   a worktree on a branch named by sentinel, writes an RFC and **stops for your approval**, then
   implements test-first, reviews the diff and opens a pull request. It never merges.
   `sentinel-sdlc-auto` does the same without the approval stop, for runs you explicitly want
   unattended.

| Skill                | Status      | What it does                                                           |
| -------------------- | ----------- | ---------------------------------------------------------------------- |
| `sentinel-doctor`    | shipped     | Checks that sentinel can run here                                      |
| `sentinel-prd`       | shipped     | Drafts and validates a PRD                                             |
| `sentinel-sdlc`      | shipped     | Issue to pull request, with an RFC approval stop                       |
| `sentinel-sdlc-auto` | shipped     | Same, without the approval stop                                        |
| `sentinel-setup`     | coming soon | Bootstraps a repository: domain questions, test tiers, CI workflows    |
| `sentinel-babysit`   | coming soon | Watches a pull request's CI and fixes failures until green             |
| `sentinel-mine`      | coming soon | Finds feature gaps in comparable projects and files issues on approval |

The shipped skills end by opening the pull request. Watching CI is yours until `sentinel-babysit`
lands.

## Guardrails

Every skill repeats these rules, and `sentinel guardrails write` puts them in your repository's
`AGENTS.md` (plus an `@AGENTS.md` pointer in `CLAUDE.md` when that file exists). Cursor gets them as
an always-on rule shipped in the plugin.

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`.
- Stop for human approval wherever a sentinel skill says STOP.

## Issue trackers

Skills describe tracker work as neutral verbs (`get`, `list`, `create`, `comment`, `set-status`,
`link-pr`, `close`) and your agent carries them out with whatever tool reaches your tracker.
sentinel only decides **which** tracker to use, in code:

| Situation                                                    | `sentinel issue resolve` says | Then                                      |
| ------------------------------------------------------------ | ----------------------------- | ----------------------------------------- |
| A tracker is configured and reachable (or not reported)      | `use`                         | use it                                    |
| Configured, but the agent reports it unreachable             | `unavailable` (exit 4)        | tell the user which connection is missing |
| Nothing configured, exactly one reachable, no conflict       | `use`                         | offer to save it (`sentinel issue use`)   |
| Several reachable, or the only one conflicts with the remote | `ask`                         | ask the user once and save the answer     |
| None reachable                                               | `fallback`                    | use the local tracker                     |

The local tracker keeps issues as Markdown files under `docs/issues/`.

Record the choice in `sentinel.config.json`. `labelMap` translates sentinel's neutral labels into
the tracker's own labels, issue types or statuses; the keys below are the neutral names the skills
use, and the values depend on your tracker.

```jsonc
// Jira
{ "issueProvider": { "tracker": "jira", "location": "Jira project PROJ",
    "labelMap": { "kind/bug": "Bug", "kind/feature": "Story",
                  "status/in-progress": "In Progress", "status/in-review": "In Review" } } }

// Linear
{ "issueProvider": { "tracker": "linear", "location": "team ENG",
    "labelMap": { "kind/bug": "Bug", "kind/feature": "Feature", "priority/p1": "Urgent",
                  "status/in-progress": "In Progress", "status/in-review": "In Review" } } }

// GitHub Issues (labels are usually the neutral names themselves)
{ "issueProvider": { "tracker": "github" } }

// Local Markdown tracker
{ "issueProvider": { "tracker": "local", "localDir": "docs/issues" } }
```

These examples show the shape; the per-tracker values are not yet verified against live trackers
(planned for M7), so check them against your own workflow names. `sentinel issue describe` prints
the instructions the agent follows for the configured tracker.

## Configuration

`sentinel.config.json` at the repository root, optionally layered over a global file
(`~/.config/sentinel/config.json`, or `%APPDATA%\sentinel\config.json` on Windows). Every section and
field is optional; a repo file wins over the global file, which wins over the defaults. Unknown keys
are rejected, and invalid configuration exits with code `5`. A JSON Schema for editor completion is
committed at [`schema/config.json`](schema/config.json); `sentinel config show` prints the effective
configuration and `sentinel config path` the files that contributed.

| Key                                             | Default                      | Meaning                                                                           |
| ----------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| `issueProvider.tracker`                         | `null`                       | Tracker slug (`github`, `jira`, `linear`, `local`…); `null` resolves on first use |
| `issueProvider.location`                        | `null`                       | Where the work lives inside the tracker                                           |
| `issueProvider.notes`                           | `null`                       | Free-form guidance for the agent                                                  |
| `issueProvider.labelMap`                        | `{}`                         | Neutral label → the tracker's own label, type or status                           |
| `issueProvider.localDir`                        | `docs/issues`                | Directory of the local tracker                                                    |
| `codeHost.type`                                 | `github`                     | Only `github` is supported                                                        |
| `codeHost.defaultBranch`                        | `main`                       | Branch worktrees start from and PRs target                                        |
| `branches.feature`                              | `feat/{issue_id}-{slug}`     | Branch template for features                                                      |
| `branches.bugfix`                               | `fix/{issue_id}`             | Branch template for bug fixes                                                     |
| `branches.hotfix`                               | `hotfix/{issue_id}-{slug}`   | Branch template for hotfixes                                                      |
| `branches.refactor`                             | `refactor/{issue_id}-{slug}` | Branch template for refactors                                                     |
| `worktrees.root`                                | `.worktrees`                 | Directory for per-issue worktrees (added to `.gitignore`)                         |
| `worktrees.copyFiles`                           | `[".env.example"]`           | Files copied into a new worktree, never overwriting                               |
| `prd.dir`                                       | `docs/prd`                   | Where PRDs are written                                                            |
| `prd.threshold`                                 | `85`                         | Minimum mean score to accept a PRD                                                |
| `prd.dimensionFloor`                            | `70`                         | Minimum score for each dimension (must not exceed threshold)                      |
| `prd.maxRefinements`                            | `3`                          | Failed refinement passes before escalating                                        |
| `rfc.dir`                                       | `docs/rfcs`                  | Where RFCs are written                                                            |
| `babysit.maxAttempts`                           | `5`                          | Fix attempts before giving up                                                     |
| `babysit.pollIntervalSec`                       | `30`                         | Seconds between CI polls                                                          |
| `babysit.timeoutMin`                            | `60`                         | Minutes before giving up on a pending run                                         |
| `testing.unit`, `.integration`, `.e2e`, `.load` | `null`                       | Command for each test tier                                                        |

Branch templates accept `{issue_id}` (required), `{slug}`, `{type}`, `{user}` and `{date}`.

## Exit codes

Every command supports `--json`. Agents branch on the exit code:

| Code | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| `0`  | Success                                                               |
| `1`  | Failure (for example a failed `doctor` check)                         |
| `2`  | Threshold not met: refine and retry (PRD scores, a CI failure to fix) |
| `3`  | Retry budget exhausted: escalate to a human or a stronger model       |
| `4`  | Tracker unavailable, or code host / authentication error              |
| `5`  | Invalid or missing configuration                                      |

## Using the CLI directly

The plugin runs the CLI for you. To use it yourself, build from source (see
[CONTRIBUTING](CONTRIBUTING.md)) and run `npm link`, or call a skill's bundle:
`node plugins/sentinel/skills/sentinel-doctor/scripts/sentinel.mjs <command>`.

```sh
sentinel doctor                      # check your environment
sentinel branch name --issue 42 --title "Add login page"   # feat/42-add-login-page
sentinel worktree add 42             # isolated worktree on a new branch
sentinel prd new login --issue 42    # PRD from the template
sentinel prd validate docs/prd/login.md --scores scores.json
sentinel rfc new 42                  # docs/rfcs/issue-42.md
sentinel pr create --issue 42 --title "Add login page"
sentinel guardrails write            # managed block in AGENTS.md
```

Run `sentinel --help` for the full list.

## Documentation

- [Implementation plan](docs/PLAN.md)
- Architecture decision records: [docs/adr](docs/adr)
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
