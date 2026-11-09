---
name: sentinel-prd
description: Drafts a product requirements document (PRD) from an issue or idea and refines it until sentinel's validator accepts it. Use when the user wants a PRD or spec for a feature, or asks to score or improve an existing PRD.
argument-hint: <issue id or feature name>
---

# sentinel PRD

Write the PRD yourself; sentinel only checks it. The validator is deterministic and caps your self-scores at what the document's structure supports, so honest scoring is the fastest way to pass.

## Find the issue tracker

1. Run `node scripts/sentinel.mjs issue resolve --json`. List the trackers you can reach with your own tools (for example a Jira, Linear or GitHub MCP server, or `gh`) and pass them as `--available <slugs>`.
2. Follow `action`: `use` means use that tracker (offer to save it with `node scripts/sentinel.mjs issue use <tracker>`); `ask` means ask the user once and save the answer; `fallback` means the local Markdown tracker; `unavailable` means stop and tell the user which connection is missing.
3. Run `node scripts/sentinel.mjs issue describe` and follow it: it gives the tracker's location, notes and label map. Describe tracker work only as the neutral verbs `get`, `list`, `create`, `comment`, `set-status`, `link-pr` and `close`, and carry them out with the tool that fits. For the local tracker the same output lists the `sentinel issue` commands.

## Draft

1. Read the issue (`get`) when the user gave an id, and `.sentinel/domain.json` when it exists.
2. Create the file: `node scripts/sentinel.mjs prd new <slug> --issue <id> --json`. It prints the path under the configured PRD directory.
3. Fill every section of the template. Each functional requirement `FR-n` needs at least one Given/When/Then scenario. Each non-functional requirement needs a number and a unit. Cover authentication, authorisation (RBAC) and input validation, data models, API contracts, and a test matrix with unit, integration, E2E and load tiers. Avoid vague words ("fast", "user-friendly", "etc.", "TBD").

## Score and validate

1. Run `node scripts/sentinel.mjs prd rubric` and score the five dimensions 0 to 100 against its anchors.
2. Write the scores to `.sentinel/state/<slug>-scores.json` as `{"clarity": 0, "testability": 0, "completeness": 0, "security": 0, "feasibility": 0}`. That folder is git-ignored.
3. Run `node scripts/sentinel.mjs prd validate <file> --scores .sentinel/state/<slug>-scores.json --json`.
4. Act on the exit code:
   - `0` accept: the PRD passes. Tell the user where it is.
   - `2` refine: fix every entry in `issues`, re-score, and validate again. sentinel counts the passes; do not exceed the limit it reports.
   - `3` escalate: stop. Print the `message` from the result exactly as given and ask the user to continue with a higher-reasoning model.

Never edit the state files in `.sentinel/state/` by hand to change the outcome.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
