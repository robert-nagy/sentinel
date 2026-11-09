# ADR-0001: Target tool configuration formats

- **Status:** Superseded in part by [ADR-0006](0006-marketplace-distribution.md): sentinel no
  longer writes these files through `sentinel init` adapters; it is installed as a plugin. The
  table stays as a record of where each tool reads skills, instructions and sub-agents, and is
  still the reference for the `AGENTS.md` / `CLAUDE.md` guardrail block.
- **Date:** 2026-11-02
- **Context source:** format research run during planning (see `docs/PLAN.md` §6)

## Context

`sentinel init` writes configuration for six targets. These formats change often and the
original spec contained several inaccuracies (`.opencode/agent.json`, a generic `mcp.json` for
Claude Desktop, workflows as Cursor `.mdc` rules). We need one verified reference that the
adapters (M3) are built against.

## Decision

Adapters target the formats below. All format knowledge (paths, keys, frontmatter fields) will
live in a single `src/adapters/targets.ts` table that links back to this ADR.

| Target            | Skills                                                                                                                            | Instructions                                                                                                                       | MCP config (top-level key)                                                                                                                         | Sub-agent                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.agents`         | `.agents/skills/<name>/SKILL.md` (global `~/.agents/skills`)                                                                      | `AGENTS.md`                                                                                                                        | —                                                                                                                                                  | —                                                                  |
| Claude Code       | `.claude/skills/<name>/SKILL.md` (global `~/.claude/skills`). Legacy `.claude/commands/*.md` still work but skills are preferred. | `CLAUDE.md`; `AGENTS.md` is read only when no `CLAUDE.md` exists, so we import it with `@AGENTS.md`                                | `.mcp.json` (`mcpServers`, `type: "stdio"`)                                                                                                        | `.claude/agents/*.md` (`name`, `description`, `tools`, `model`, …) |
| Claude Desktop    | —                                                                                                                                 | —                                                                                                                                  | `claude_desktop_config.json` (`mcpServers`): macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`, Linux `~/.config/Claude/` | —                                                                  |
| Cursor            | reads `.agents/skills`, `.cursor/skills`, `.claude/skills`                                                                        | `.cursor/rules/**/*.mdc` (`description`, `globs`, `alwaysApply`; plain `.md` ignored); global `~/.cursor/rules`; reads `AGENTS.md` | `.cursor/mcp.json`, `~/.cursor/mcp.json` (`mcpServers`)                                                                                            | none file-based                                                    |
| VS Code / Copilot | reads `.github/skills`, `.agents/skills`, `.claude/skills`                                                                        | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` (`applyTo`); reads `AGENTS.md`                         | `.vscode/mcp.json` (**`servers`**)                                                                                                                 | `.github/agents/*.agent.md`, `~/.copilot/agents/`                  |
| OpenCode          | reads `.opencode/skills`, `.agents/skills`, `.claude/skills`                                                                      | `AGENTS.md` (global `~/.config/opencode/AGENTS.md`)                                                                                | `opencode.json` (**`mcp`**: `{type: "local", command: [..], environment, enabled}`)                                                                | `.opencode/agents/*.md` (`description`, `mode: subagent`, …)       |

Agent Skills (`SKILL.md`) follow the agentskills.io spec: `name` (≤ 64 chars, lowercase/digits/
hyphens, must match the folder), `description` (≤ 1024 chars), optional `license`,
`compatibility`, `metadata`, `allowed-tools`. Tool-specific fields (e.g. Claude Code's
`argument-hint`, `disable-model-invocation`) are ignored by other tools.

## Sources

- Claude Code skills / sub-agents / MCP / memory: https://code.claude.com/docs/en/skills.md,
  https://code.claude.com/docs/en/sub-agents.md, https://code.claude.com/docs/en/mcp,
  https://code.claude.com/docs/en/memory.md
- Claude Desktop local MCP servers: https://modelcontextprotocol.io/docs/develop/connect-local-servers
- Cursor: https://cursor.com/docs/rules, https://cursor.com/docs/mcp.md, https://cursor.com/docs/skills.md
- VS Code: https://code.visualstudio.com/docs/agent-customization/custom-instructions.md,
  https://code.visualstudio.com/docs/agent-customization/agent-skills.md,
  https://code.visualstudio.com/docs/agent-customization/custom-agents,
  https://code.visualstudio.com/docs/agents/reference/mcp-configuration.md
- OpenCode: https://opencode.ai/docs/config, https://opencode.ai/docs/agents,
  https://opencode.ai/docs/mcp-servers, https://opencode.ai/docs/skills, https://opencode.ai/docs/rules
- Agent Skills: https://agentskills.io; AGENTS.md: https://agents.md

## Open items (re-verify before M3)

- OpenCode V2 (beta) moves MCP config to `mcp.servers`; keep the current shape until V2 is stable.
- Full Copilot custom-agent frontmatter reference (`model`, `target`, `mcp-servers`) not yet verified.
- Owner and status of the unscoped npm package `sentinel` (irrelevant while we publish scoped).

## Consequences

- Skills become the single canonical workflow format (ADR-0003); per-tool adapters stay small.
- Format drift is a one-file change plus snapshot test updates. `sentinel doctor` will grow
  checks that flag stale generated files.
