# sentinel

[![CI](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml)
[![Security](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Agentic product & software development lifecycle governance for AI coding tools.**

sentinel is a plugin that adds skills, guardrails and deterministic tooling to Claude Code,
VS Code / GitHub Copilot, Codex and Cursor. Your agent then runs a governed workflow: from bootstrapping a repo, through PRDs that must
pass a quality gate, to issue → isolated worktree → RFC → test-driven implementation → PR →
CI babysitting.

> **Status: early development.** The deterministic CLI exists (M0–M2); the skills and the
> plugin marketplace described below are planned, not shipped. See
> [the implementation plan](docs/PLAN.md) for the roadmap.
>
> **Distribution is changing.** sentinel will be installed from a plugin marketplace in this
> repository instead of npm ([ADR-0006](docs/adr/0006-marketplace-distribution.md)). Until that
> lands, run the CLI from a local build (see [Development](#development)).

## Design in one paragraph

sentinel never calls an LLM itself ([ADR-0002](docs/adr/0002-no-llm-calls.md)). The agent you
already use does the reasoning. sentinel provides the workflows as Agent Skills
([ADR-0003](docs/adr/0003-skills-as-canonical-workflows.md)), plus a CLI whose commands enforce
the rules in code: quality thresholds, retry caps, branch naming, never pushing to the default
branch. The CLI is bundled inside each skill, so installing the plugin is the whole setup.

## Requirements

- Node.js ≥ 22
- git ≥ 2.25
- GitHub CLI (`gh`) for the GitHub code host

No issue-tracker credentials: your agent reaches the tracker with the connections it already has
(an MCP server or CLI for GitHub, Jira, Linear, Azure DevOps…). See
[ADR-0005](docs/adr/0005-agent-native-issue-trackers.md).

## Install (planned)

Add this repository as a plugin marketplace in your tool, then install the `sentinel` plugin.

| Tool              | How                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Claude Code       | `/plugin marketplace add robert-nagy/sentinel`, then `/plugin install sentinel@robert-nagy`         |
| VS Code / Copilot | add `robert-nagy/sentinel` under `chat.plugins.marketplaces`, then install from the Plugins page |
| Codex             | `codex plugin marketplace add robert-nagy/sentinel`                                              |
| Cursor            | from Cursor's marketplace once listed; until then a team marketplace or a local plugin folder    |

OpenCode, Claude Desktop and plain `.agents/skills` setups are not supported for now.

## Usage (current)

The commands below use `sentinel` from a local build (`npm run build && npm link`).

```sh
sentinel doctor          # check your environment
sentinel doctor --json   # machine-readable output
```

`doctor` exits `0` when no check fails (warnings are allowed) and `1` otherwise.

```sh
sentinel branch name --issue 42 --title "Add login page"   # feat/42-add-login-page
sentinel config show      # effective config (defaults + global + repo)
sentinel config schema    # JSON Schema for sentinel.config.json
```

### Issue trackers

```sh
sentinel issue resolve --available linear,github   # use | ask | fallback | unavailable
sentinel issue use linear --location "team ENG" --label kind/bug=Bug
sentinel issue describe   # what the agent should do, and how labels map
sentinel issue duplicates "Add login page" --candidates candidates.json
```

`resolve` decides which tracker to use: the configured one; otherwise the only reachable one when
it doesn't conflict with the git remote; otherwise it asks; with nothing reachable it falls back to
the local tracker, Markdown files in `docs/issues/` managed with `sentinel issue
create|get|list|comment|label|close|reopen`.

Configuration lives in `sentinel.config.json` at the repo root (and optionally a global file; see
`sentinel config path`). Invalid configuration exits with code `5`.

## Development

```sh
npm ci
npm run check        # lint + format check + typecheck + unit tests
npm run build        # bundle to dist/ with tsup
npm run test:e2e     # run the built CLI (build first)
npm link             # put a local `sentinel` on your PATH
```

Add a changeset (`npm run changeset`) for every user-facing change. Changesets drive the version
and changelog only; releases are git tags, not npm publishes.

## Documentation

- [Implementation plan](docs/PLAN.md)
- Architecture decision records: [docs/adr](docs/adr)

## License

[MIT](LICENSE)
