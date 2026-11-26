# sentinel

[![CI](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/ci.yml)
[![Security](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml/badge.svg)](https://github.com/robert-nagy/sentinel/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Agentic product & software development lifecycle governance for AI coding tools.**

sentinel is a plugin that adds skills, guardrails and deterministic tooling to Claude Code,
VS Code / GitHub Copilot, Codex and Cursor. Your agent runs a governed workflow: a PRD that must
pass a quality gate, then issue → isolated worktree → RFC → test-driven implementation → pull
request.

> **Status: early development.** Versions 0.1.0 to 0.3.0 are tagged, but sentinel is not yet listed
> in any tool's public marketplace; the plugin installs from this repository and all seven skills
> ship today. See the
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
   implements test-first, reviews the diff, opens a pull request and babysits its CI. It never
   merges.
   `sentinel-sdlc-auto` does the same without the approval stop, for runs you explicitly want
   unattended.

| Skill                | Status  | What it does                                                                |
| -------------------- | ------- | --------------------------------------------------------------------------- |
| `sentinel-doctor`    | shipped | Checks that sentinel can run here                                           |
| `sentinel-prd`       | shipped | Drafts and validates a PRD                                                  |
| `sentinel-sdlc`      | shipped | Issue to pull request, with an RFC approval stop                            |
| `sentinel-sdlc-auto` | shipped | Same, without the approval stop                                             |
| `sentinel-setup`     | shipped | Bootstraps a repository: domain questions, test tiers, CI workflows         |
| `sentinel-babysit`   | shipped | Watches a pull request's CI and fixes failures until green                  |
| `sentinel-mine`      | shipped | Finds feature gaps in comparable projects and files issues on approval      |
| `sentinel-review`    | shipped | Reviews a branch, staged or uncommitted work, or a PR, and reports findings |

`sentinel-sdlc` and `sentinel-sdlc-auto` hand the pull request to the `sentinel-babysit` loop: the
agent fixes real CI failures and pushes until the checks are green, or sentinel gives up after
`babysit.maxAttempts` and leaves a comment for a human. `sentinel-mine` stops for your approval of
the gap list before it files anything.

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
sentinel only decides **which** tracker to use, in code
([ADR-0005](docs/adr/0005-agent-native-issue-trackers.md)).

### How sentinel picks the tracker

A skill runs `sentinel issue resolve --available <slugs>`, listing the trackers the agent can reach
with its own tools. sentinel reads the git remote itself and applies these rules in order:

1. **Configured.** `issueProvider.tracker` is set: `use` it. If `--available` was passed and does
   not include it, the answer is `unavailable` (exit code 4) and the agent tells you which
   connection is missing. `local` is always reachable.
2. **The only reachable tracker that doesn't conflict with the git remote.** Nothing is configured
   and exactly one tracker is reachable: `use` it and offer to save it, unless the remote is on a
   different forge (see below).
3. **Ask.** Several trackers are reachable, or the only one conflicts with the remote: `ask` the
   user once and save the answer. The remote's forge comes first and is the recommendation (marked
   unreachable if the agent can't reach it); `local` is always the last option.
4. **Local fallback.** Nothing is reachable: `fallback` to the local tracker, which keeps issues as
   Markdown files under `docs/issues/`.

| Situation                                                    | `sentinel issue resolve` says | Then                                      |
| ------------------------------------------------------------ | ----------------------------- | ----------------------------------------- |
| A tracker is configured and reachable (or not reported)      | `use`                         | use it                                    |
| Configured, but the agent reports it unreachable             | `unavailable` (exit 4)        | tell the user which connection is missing |
| Nothing configured, exactly one reachable, no conflict       | `use`                         | offer to save it (`sentinel issue use`)   |
| Several reachable, or the only one conflicts with the remote | `ask`                         | ask the user once and save the answer     |
| None reachable                                               | `fallback`                    | use the local tracker                     |

Details that decide edge cases:

- **Slugs are normalised** before comparison: lower-cased, spaces and underscores become hyphens,
  and common aliases map to one name. `gh`, `github-issues` → `github`; `glab`, `gitlab-issues` →
  `gitlab`; `atlassian`, `jira-cloud`, `jira-server` → `jira`; `ado`, `azdo`, `az`, `azure`,
  `azure-boards` → `azure-devops`; `markdown`, `md`, `files` → `local`. Any other lower-case slug
  (`linear`, `youtrack`…) is accepted as is.
- **The forge** comes from the `origin` remote (or the first remote): a host containing `github`,
  `gitlab` or `bitbucket`, or `dev.azure.com` / `*.visualstudio.com` / `*.azure.com` for Azure
  DevOps. A self-hosted forge is recognised only when its host name contains the forge's name. A
  remote on any other host, or no remote, never conflicts.
- **A conflict** means the only reachable tracker differs from the remote's forge, for example a
  GitHub remote with only a Linear MCP server connected. The repo may track work on the forge, so
  sentinel asks instead of guessing.
- **Without `--available`**, sentinel trusts a configured tracker as is; with nothing configured, it
  treats the tracker CLIs it finds on `PATH` (`gh`, `glab`, `az`, `jira`, `linear`) as reachable.
  Installed is not proof of sign-in, so the skills always pass `--available`.
- `sentinel issue detect` shows what sentinel can see itself (the remote and its forge, and which
  tracker CLIs are installed).

### Recording the choice

`sentinel issue use <tracker> [--location <text>] [--notes <text>] [--label neutral=native]…`
writes `issueProvider` to the repository's `sentinel.config.json`, leaving every other key alone.
`--label` is repeatable and merges into the existing `labelMap`. `sentinel issue describe` prints
the instructions the agent follows for the configured tracker.

`labelMap` translates sentinel's neutral labels into the tracker's own label, issue type or status
name. The skills use these keys:

| Neutral key          | Used when                                                     |
| -------------------- | ------------------------------------------------------------- |
| `kind/feature`       | filing a feature (`sentinel mine create` labels gaps with it) |
| `kind/bug`           | marking a bug                                                 |
| `status/in-progress` | `set-status` after the worktree is created                    |
| `status/in-review`   | `set-status` after the pull request is opened                 |

sentinel hands the map to the agent through `sentinel issue describe` and does not check the
values. Map what differs in your tracker; an unmapped key reaches the agent as the neutral
name. Extra keys are passed through too. Branch-type detection does not depend on the map: a
native label or issue type such as `Bug` or `defect` already gives a `fix/` branch.

### Examples per tracker

Each example is a complete, schema-valid `sentinel.config.json`. The keys and the shape are checked
against [`schema/config.json`](schema/config.json); the values are **not yet verified against live
trackers**: the manual smoke test with each tracker (M7 in the [plan](docs/PLAN.md)) hasn't run, so
check names against your own labels, issue types and workflow statuses.

**GitHub Issues** (agent uses `gh` or a GitHub MCP server). _Not yet smoke-tested._ GitHub has no
statuses, so the status keys map to labels, which must exist in the repository; the kind keys map
to GitHub's default labels. `pr create`
writes `Closes #<id>` for this tracker.

```json
{
  "issueProvider": {
    "tracker": "github",
    "labelMap": {
      "kind/bug": "bug",
      "kind/feature": "enhancement",
      "status/in-progress": "in progress",
      "status/in-review": "in review"
    }
  }
}
```

**Jira** (agent uses the Atlassian MCP server). _Not yet smoke-tested._ Kinds map to issue types and
statuses to workflow statuses. Use your project's key in `location` and the `PROJ-123` key as the
issue id.

```json
{
  "issueProvider": {
    "tracker": "jira",
    "location": "Jira project PROJ",
    "labelMap": {
      "kind/bug": "Bug",
      "kind/feature": "Story",
      "status/in-progress": "In Progress",
      "status/in-review": "In Review"
    }
  }
}
```

**Linear** (agent uses the Linear MCP server). _Not yet smoke-tested._ Kinds map to labels and
statuses to workflow states of the team in `location`.

```json
{
  "issueProvider": {
    "tracker": "linear",
    "location": "team ENG",
    "labelMap": {
      "kind/bug": "Bug",
      "kind/feature": "Feature",
      "status/in-progress": "In Progress",
      "status/in-review": "In Review"
    }
  }
}
```

**GitLab Issues** (agent uses `glab` or a GitLab MCP server). _Not yet smoke-tested, and not in the
M7 smoke-test set._ sentinel recognises `gitlab` as a tracker and a forge, but the code host is
GitHub only, so `sentinel pr create` works only when the code lives on GitHub and the issues on
GitLab. The values below use GitLab's scoped labels as an example.

```json
{
  "issueProvider": {
    "tracker": "gitlab",
    "location": "group/project",
    "labelMap": {
      "kind/bug": "type::bug",
      "kind/feature": "type::feature",
      "status/in-progress": "workflow::in progress",
      "status/in-review": "workflow::in review"
    }
  }
}
```

**Local Markdown tracker** (built in; managed with `sentinel issue create|get|list|comment|label|close|reopen`).
_Not yet smoke-tested end to end; covered by unit tests._ Labels are stored verbatim, so no
`labelMap` is needed. `localDir` defaults to `docs/issues`.

```json
{
  "issueProvider": {
    "tracker": "local",
    "localDir": "docs/issues"
  }
}
```

Any other tracker works the same way: pick a slug, describe where the work lives in `location`, add
team conventions to `notes`, and map the four neutral keys.

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
sentinel setup --questions --json    # open domain questions and the detected stack
sentinel babysit 17 --once --json    # one look at a PR's CI: wait, done, patch or give-up
sentinel mine search "task tracker"  # popular comparable repositories
```

The `setup` command is built, but the skill that drives it is still to come (table above).

Run `sentinel --help` for the full list.

## Documentation

- [Implementation plan](docs/PLAN.md)
- Architecture decision records: [docs/adr](docs/adr)
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Code of conduct](CODE_OF_CONDUCT.md)

## License

[MIT](LICENSE)
