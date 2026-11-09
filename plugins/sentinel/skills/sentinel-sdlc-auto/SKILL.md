---
name: sentinel-sdlc-auto
description: Same as sentinel-sdlc but without the RFC approval stop; takes one issue to an open pull request on its own. Use only when the user explicitly asks for an unattended or no-approval run.
argument-hint: <issue id>
disable-model-invocation: true
---

# sentinel SDLC (unattended)

Follows `sentinel-sdlc` exactly, except step 4 does not stop for approval. It still never merges, never pushes to the default branch, and still stops on an unclear or blocked issue.

## Find the issue tracker

1. Run `node scripts/sentinel.mjs issue resolve --json`. List the trackers you can reach with your own tools (for example a Jira, Linear or GitHub MCP server, or `gh`) and pass them as `--available <slugs>`.
2. Follow `action`: `use` means use that tracker (offer to save it with `node scripts/sentinel.mjs issue use <tracker>`); `ask` means ask the user once and save the answer; `fallback` means the local Markdown tracker; `unavailable` means stop and tell the user which connection is missing.
3. Run `node scripts/sentinel.mjs issue describe` and follow it: it gives the tracker's location, notes and label map. Describe tracker work only as the neutral verbs `get`, `list`, `create`, `comment`, `set-status`, `link-pr` and `close`, and carry them out with the tool that fits. For the local tracker the same output lists the `sentinel issue` commands.

## Run

1. Read the issue (`get`) and any issues it depends on. Stop and ask if the issue is unclear or blocked.
2. Create the worktree: `node scripts/sentinel.mjs worktree add <issue-id> --json`. It names the branch with the configured template. Work only inside the path it prints, then `set-status` the issue to in progress.
3. Write the design: `node scripts/sentinel.mjs rfc new <issue-id> --title "<title>"`, then fill in `docs/rfcs/issue-<issue-id>.md` (or the path it printed) inside the worktree.
4. Do not wait for approval, but keep the RFC accurate: update it whenever the plan changes, and mention in the PR where the design departed from the first draft.
5. Implement test-first. Write failing tests for each tier the issue touches (unit, integration, E2E; use the commands under `testing` in `node scripts/sentinel.mjs config show`), make them pass, and keep commits small and focused.
6. Review the diff with the `sentinel-reviewer` sub-agent if your tool has it. Otherwise run its checklist yourself: injection, secrets in the diff, missing authorisation, unhandled errors, unsafe deserialisation, unvalidated input, a missing test for any tier, and docs left out of sync. Fix what you find and re-run the review until it returns no findings.
7. Update docs that the change affects (README, RFC, API notes).
8. Open the PR: `node scripts/sentinel.mjs pr create --issue <issue-id> --title "<title>" --json`, then `link-pr` and `set-status` (in review) on the issue.
9. Tell the user the PR link and that CI is theirs to watch; a merge is a human decision.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
