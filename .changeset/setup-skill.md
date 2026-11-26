---
'@robert-nagy/sentinel': minor
---

Add the `sentinel-setup` skill (Phase 0). It asks the user the domain questions from `sentinel setup --questions`, feeds the answers back until the domain is complete, confirms the stack (proposing one for an empty repository), writes the test workflows, README and `AGENTS.md` guardrails, and opens a bootstrap pull request from a sentinel worktree. It never merges.
