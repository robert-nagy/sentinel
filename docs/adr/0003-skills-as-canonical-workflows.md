# ADR-0003: Agent Skills are the canonical workflow format

- **Status:** Accepted; amended by [ADR-0006](0006-marketplace-distribution.md). Skills remain
  the canonical workflow format. Two decisions below are superseded: skills are no longer
  copied into `.agents/skills/` and `.claude/skills/` (they ship in a plugin), and the
  `{{SENTINEL}}` / `npx` pinning is replaced by a bundled CLI inside each skill. Claude Desktop
  is no longer a target.
- **Date:** 2026-11-02

## Context

The spec asked for per-tool workflow artifacts: Claude Code slash commands, Cursor `.mdc` rules,
Copilot prompt files, an OpenCode agent JSON. Maintaining six renderings of the same workflows
invites drift. Format research (ADR-0001) showed every target tool except Claude Desktop now
reads Agent Skills (`SKILL.md`), from `.agents/skills/` (Cursor, VS Code/Copilot, OpenCode,
Codex) or `.claude/skills/` (Claude Code, and also read by the others).

## Decision

- All workflows are Agent Skills, prefixed `sentinel-`:
  `sentinel-setup`, `sentinel-prd`, `sentinel-sdlc` (stops for RFC approval),
  `sentinel-sdlc-auto` (no stop; never merges), `sentinel-babysit`, `sentinel-mine`.
- Skills are **copied** (not symlinked) into both `.agents/skills/` and `.claude/skills/`;
  symlinks are unreliable on Windows and in some git setups.
- One sub-agent, `sentinel-reviewer`, is rendered per tool that supports file-based sub-agents
  (Claude Code, Copilot, OpenCode). Elsewhere the review checklist runs inline.
- Skills reference the CLI through a `{{SENTINEL}}` token that `sentinel init` pins to
  `npx -y @robert-nagy/sentinel@<installed version>`, so skills and CLI never drift;
  `sentinel doctor` reports a mismatch.
- Claude Desktop, which has no skill folders, receives the workflows as MCP prompts.

## Consequences

- Per-tool adapters reduce to: skill copies, an `AGENTS.md`/`CLAUDE.md` pointer, a Cursor
  always-on guardrail rule, MCP configuration, and the reviewer sub-agent.
- The spec's `/prd`, `/sdlc-worktree`, `/setup-repo` commands become `/sentinel-*` skills.
- First run of a pinned `npx` command is slower; users may install globally instead.
