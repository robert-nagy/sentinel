# sentinel

[![CI](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml)
[![Security](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Agentic product & software development lifecycle governance for AI coding tools.**

sentinel installs skills, guardrails and deterministic tooling into Claude Code, Claude Desktop,
Cursor, VS Code / GitHub Copilot, OpenCode and any tool that reads `AGENTS.md` / `.agents/skills`.
Your agent then runs a governed workflow: from bootstrapping a repo, through PRDs that must
pass a quality gate, to issue → isolated worktree → RFC → test-driven implementation → PR →
CI babysitting.

> **Status: early development (M0 — foundation).** Only `sentinel --version` and
> `sentinel doctor`, `sentinel branch name` and `sentinel config` exist today. See [the implementation plan](docs/PLAN.md) for the roadmap.

## Design in one paragraph

sentinel never calls an LLM itself ([ADR-0002](docs/adr/0002-no-llm-calls.md)). The agent you
already use does the reasoning. sentinel provides the workflows as Agent Skills
([ADR-0003](docs/adr/0003-skills-as-canonical-workflows.md)), plus a CLI and MCP server whose
commands enforce the rules in code: quality thresholds, retry caps, branch naming, never pushing
to the default branch.

## Requirements

- Node.js ≥ 22
- git ≥ 2.25
- GitHub CLI (`gh`) for the GitHub issue provider / code host

## Usage (current)

```sh
npx @robert-nagy/sentinel doctor          # check your environment
npx @robert-nagy/sentinel doctor --json   # machine-readable output
```

`doctor` exits `0` when no check fails (warnings are allowed) and `1` otherwise.

```sh
npx @robert-nagy/sentinel branch name --issue 42 --title "Add login page"   # feat/42-add-login-page
npx @robert-nagy/sentinel config show      # effective config (defaults + global + repo)
npx @robert-nagy/sentinel config schema    # JSON Schema for sentinel.config.json
```

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

Add a changeset (`npm run changeset`) for every user-facing change.

## Documentation

- [Implementation plan](docs/PLAN.md)
- Architecture decision records: [docs/adr](docs/adr)

## License

[MIT](LICENSE)
