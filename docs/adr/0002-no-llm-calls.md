# ADR-0002: sentinel never calls an LLM

- **Status:** Accepted
- **Date:** 2026-11-02

## Context

The spec mixes deterministic behaviour (branch naming, worktrees, CI polling) with reasoning
(PRD synthesis and scoring, RFC writing, CI repair). sentinel could own an LLM client or lean
on the agent the user already runs (Claude Code, Cursor, Copilot, OpenCode…).

## Decision

sentinel **never calls a model API**. The host agent does all reasoning; sentinel provides:

1. **Skills** that tell the agent what to do (ADR-0003).
2. **Deterministic tools** (CLI with `--json`, and an MCP server) the agent calls.

Every rule that matters is **enforced in code** rather than left to prose: PRD threshold,
per-dimension floor and iteration cap; babysitter attempt limits and failure-signature dedupe;
branch name resolution; never pushing to the default branch. Commands communicate outcomes
through stable exit codes (`src/core/exit-codes.ts`).

## Consequences

- No API keys, no model or vendor lock-in; identical behaviour across every host tool.
- Unattended runs come from running a host agent headless (e.g. `claude -p "/sentinel-babysit 42"`
  in CI), not from sentinel itself.
- Quality depends on the host agent following skills, which is why enforcement lives in code
  and guardrails are repeated in `AGENTS.md` and an always-on Cursor rule.
- The core keeps its boundaries clean enough that an optional model provider could be added
  later as a self-contained module, but none is planned.
