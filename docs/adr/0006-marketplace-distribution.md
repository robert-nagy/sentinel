# ADR-0006: sentinel is distributed as a plugin marketplace, not an npm package

- **Status:** Accepted. Implemented in M2.5 (#18, #19); the install smoke test passed in Claude Code, VS Code, Codex and Cursor (reported by the maintainer, 2026-11-09). Per-tool detail still to be recorded under Open items.
- **Date:** 2026-11-09
- **Supersedes:** the adapter half of [ADR-0001](0001-target-formats.md) and the copy/pin
  decisions of [ADR-0003](0003-skills-as-canonical-workflows.md)

## Context

The original plan shipped sentinel as the npm package `@robert-nagy/sentinel`. Users ran
`npx @robert-nagy/sentinel init`, which copied skills into `.agents/skills/` and
`.claude/skills/`, wrote per-tool MCP and sub-agent files through six adapters, and pinned every
skill to `npx -y @robert-nagy/sentinel@<version>`.

That design has three costs:

- **A registry we do not need.** npm requires an account, trusted-publisher (OIDC) setup, a
  workflow whose filename must match the publisher config, and provenance plumbing. None of it
  is part of what sentinel does.
- **An installer that duplicates the host tools.** Claude Code, VS Code / Copilot, Codex and
  Cursor now install skills, sub-agents and MCP servers from plugin marketplaces: a git
  repository with a catalog file. `sentinel init` and its adapters re-implement that, tool by
  tool, and have to track every format change.
- **Skills and CLI can drift.** Pinning skills to an `npx` version fixes this only until
  somebody upgrades one and not the other, and the first `npx` run is slow.

Format research on 2026-11-09 (sources below):

| Tool              | Catalog it reads                                                               | Plugin manifest                                        | Install path for an individual                                         |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Claude Code       | `.claude-plugin/marketplace.json`                                              | `.claude-plugin/plugin.json`                           | `/plugin marketplace add owner/repo`, then `/plugin install`           |
| VS Code / Copilot | Claude format, plus Agent Plugins 1.0                                          | root `plugin.json` (takes precedence) or Claude format | add the marketplace in settings, or _Chat: Install Plugin from Source_ |
| Codex             | `.agents/plugins/marketplace.json`; reads the Claude catalog as a legacy input | root `plugin.json`; `.codex-plugin/` as fallback       | `codex plugin marketplace add owner/repo[@ref]`                        |
| Cursor            | `.cursor-plugin/marketplace.json`                                              | root `plugin.json` or `.cursor-plugin/plugin.json`     | Cursor's reviewed marketplace, a team marketplace, or a local folder   |
| OpenCode          | none (skills are read from folders)                                            | none                                                   | manual copy                                                            |

Agent Plugins 1.0 is an open standard that covers only skills (`skills/<name>/SKILL.md`), MCP
servers (`mcp.json`) and a root `plugin.json`. Claude Code does not read it. Sub-agents, rules,
hooks and install mechanics stay vendor-specific everywhere. A plugin-root placeholder inside
skill text (`${CLAUDE_PLUGIN_ROOT}`) and a plugin `bin/` directory on `PATH` are Claude Code
features that the other tools do not share.

## Decision

1. **No npm publishing.** `@robert-nagy/sentinel` becomes a private package name used only by
   the build and by changesets. The publish workflow, OIDC setup and provenance are removed.
2. **This repository is the marketplace.** It holds one plugin, `sentinel`, in
   `plugins/sentinel/`, and a catalog at the repo root. Users install it with their tool's own
   plugin commands.
3. **The Claude Code format is the source of truth.** `.claude-plugin/marketplace.json` and
   `plugins/sentinel/.claude-plugin/plugin.json` are written by hand. A generator script derives
   the others from them, and CI fails when they drift:
   - `plugins/sentinel/plugin.json` (Agent Plugins 1.0, for Copilot and Codex)
   - `.agents/plugins/marketplace.json` (Codex)
   - `.cursor-plugin/marketplace.json` and, if needed, `plugins/sentinel/.cursor-plugin/plugin.json`
4. **Supported tools in v0.1: Claude Code, VS Code / Copilot, Codex and Cursor.** OpenCode, the
   generic `.agents/skills` target and Claude Desktop are dropped from the supported list. They
   can come back when they have a plugin install path.
5. **The CLI ships inside every skill.** The deterministic core is bundled into one
   dependency-free file. Each skill folder gets a copy at `scripts/sentinel.mjs`, and skills
   invoke it by a path relative to their own folder:
   `node scripts/sentinel.mjs <command> --json`. Node.js ≥ 22 remains a runtime requirement.
   A skill folder is therefore self-contained in every tool, with no plugin-root variable and no
   `PATH` entry.
6. **The bundle is committed on `main`, regenerated only by the version PR.** Marketplaces
   install by cloning git and run no build step, so built output must be in the tree. Feature
   PRs never touch the bundle; the changesets "version packages" PR rebuilds it and stamps the
   version into every manifest. `main` always carries the bundle of the last release.
7. **Changesets stay, publishing goes.** Changesets still produce the version bump and
   `CHANGELOG.md`. Merging the version PR tags `vX.Y.Z` and creates a GitHub Release. The
   plugin manifests carry the same version, which is what tells the host tools an update exists.
8. **`sentinel init` and the adapters are dropped.** Plugin install delivers the skills and the
   reviewer sub-agent. The two repo-level artifacts that a plugin cannot deliver are written by
   the `sentinel-setup` skill through the CLI: the managed guardrail block in `AGENTS.md` (with
   a `CLAUDE.md` pointer when that file exists) via `sentinel guardrails write`, and
   `sentinel.config.json`.
9. **If `@robert-nagy/sentinel` was ever published, deprecate it** with a message pointing at
   the marketplace, and keep the name reserved. The config `$schema` URL moves from unpkg to a
   tagged raw GitHub URL.

## Consequences

- Install is one or two commands in the user's own tool, with no Node package manager involved.
  Updates arrive through the tool's plugin update flow.
- Skills and CLI cannot drift: they are the same commit. The `{{SENTINEL}}` token, the version
  pinning and the `doctor` drift check for it are gone.
- ADR-0001's format table stops being build input. Format knowledge shrinks to four small
  manifests produced by one generator.
- The repository carries generated files: six copies of the bundle and three generated
  manifests. They change only in version PRs, which keeps review noise out of feature work.
- Skills on `main` can be ahead of the committed bundle between releases. A lint test checks
  every CLI command a skill mentions against the committed bundle; a PR whose skills need a new
  command must rebuild the bundle in the same PR.
- Cursor has no self-serve git install for individuals. Until sentinel is accepted into
  Cursor's marketplace, Cursor users install through a team marketplace or a local folder.
- VS Code marks its marketplace setting as experimental, and Codex reads the Claude catalog
  only as a legacy input. Both are covered by generated native manifests, but the formats may
  move again.
- Every supported tool must be able to run `node`. A tool or sandbox without shell access
  cannot use sentinel until the MCP server exists (see open items).

## Open items

- **MCP server packaging.** With the CLI inside every skill, the MCP server (M4) is no longer on
  the path to a usable product. Packaging it is awkward: the plugin-root placeholder is
  `${CLAUDE_PLUGIN_ROOT}` in Claude Code, `${PLUGIN_ROOT}` in the standard, and Cursor expands
  only its own and Claude's. Proposed: defer M4 until after 0.1 and decide the packaging then.
- **Reviewer sub-agent outside Claude Code and Cursor.** Where Copilot expects plugin agents
  (`*.agent.md`) and whether they still load next to a root `plugin.json` is unverified. Codex
  documents no plugin sub-agents; there the review checklist runs inline in the skill.
- **Coexistence of manifests.** One report says Claude Code rejects a plugin that has only a
  root `plugin.json`. Whether it accepts a root `plugin.json` next to `.claude-plugin/` needs a
  smoke test (`claude plugin validate`).
- **Whether `@robert-nagy/sentinel` was published** has to be checked on npmjs.com before
  deciding between deprecating and doing nothing.

## Sources

- Claude Code plugins reference: https://code.claude.com/docs/en/plugins-reference
- VS Code agent plugins: https://code.visualstudio.com/docs/agent-customization/agent-plugins
- Codex plugins: https://developers.openai.com/codex/plugins/build.md
- Cursor plugins: https://cursor.com/docs/plugins.md, https://cursor.com/docs/reference/plugins.md
- Agent Plugins 1.0 compared with vendor formats:
  https://startdebugging.net/2026/08/agent-plugins-1-0-vs-vendor-specific-plugin-formats/
- A multi-tool plugin repo layout: https://github.com/uw-ssec/rse-plugins/issues/237
