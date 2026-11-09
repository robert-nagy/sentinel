---
'@robert-nagy/sentinel': minor
---

Add `sentinel guardrails write`: writes a managed guardrail block to `AGENTS.md` (idempotent, `--dry-run`, CRLF-safe) and an `@AGENTS.md` pointer to an existing `CLAUDE.md`. The plugin ships the same rules as an always-on Cursor rule, and skill files are linted (frontmatter, no hard-coded tracker, every named command exists in the bundle).
