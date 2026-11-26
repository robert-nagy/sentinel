---
name: sentinel-mine
description: Finds features that comparable popular projects have and this one lacks, writes them to an approval list, and files only the gaps a human approves as issues, skipping likely duplicates. Use when the user asks to mine competitors, find feature gaps, or seed the backlog from similar projects.
argument-hint: <search terms describing the project>
disable-model-invocation: true
---

# sentinel mine

You do the reading and judging; sentinel finds the projects, writes the approval list, checks for duplicates and tells you what to file. Nothing reaches the issue tracker until a human has approved it.

## Search

1. Read the repository's README and `.sentinel/domain.json` when it exists, and agree the search terms with the user if they gave none.
2. Run `node scripts/sentinel.mjs mine search <terms> --json`. Add `--language <name>` to stay in the project's language and `--min-stars <n>` to raise the bar (default 500). It needs `gh` logged in; on exit code `4`, stop and tell the user.
3. Show the user the repositories and drop any they consider not comparable.

## Draft the gap list

1. For each kept repository, read its README, docs and public API (commands, endpoints, configuration options). Compare them with this repository and note each feature it lacks. Do not copy code or text from those projects; describe the capability in your own words.
2. Write the findings to `.sentinel/state/mine-findings.json` (that folder is git-ignored) as a JSON array: `[{"title": "…", "summary": "…", "sources": ["owner/repo"], "priority": "high"}]`. `sources` and `priority` (`high`, `medium` or `low`) are optional. Keep titles short and specific: they become issue titles.
3. Run `node scripts/sentinel.mjs mine draft --findings .sentinel/state/mine-findings.json --json`. It merges near-duplicate findings and writes `docs/feature-gaps.md` (or the `--out` path you give). If the file exists, ask the user before adding `--force`, because that discards earlier approvals.

## STOP for approval

Show the user the gap list and ask them to approve gaps by changing `[ ]` to `[x]` in the file, and to delete the ones they do not want. Wait for their answer. Never tick a gap yourself unless the user names that gap in chat and asks you to. If nothing is approved, stop.

## Find the issue tracker

1. Run `node scripts/sentinel.mjs issue resolve --json`. List the trackers you can reach with your own tools (for example a Jira, Linear or GitHub MCP server, or `gh`) and pass them as `--available <slugs>`.
2. Follow `action`: `use` means use that tracker (offer to save it with `node scripts/sentinel.mjs issue use <tracker>`); `ask` means ask the user once and save the answer; `fallback` means the local Markdown tracker; `unavailable` means stop and tell the user which connection is missing.
3. Run `node scripts/sentinel.mjs issue describe` and follow it: it gives the tracker's location, notes and label map. Describe tracker work only as the neutral verbs `get`, `list`, `create`, `comment`, `set-status`, `link-pr` and `close`, and carry them out with the tool that fits. For the local tracker the same output lists the `sentinel issue` commands.

## File the approved gaps

1. `mine create` reads the tracker from the saved configuration, not from `issue resolve`. If the answer had `offerToSave` set (including `fallback` to the local tracker), save it first with `node scripts/sentinel.mjs issue use <tracker>` and tell the user; otherwise duplicates are not checked against the local tracker.
2. Unless the tracker is `local`, `list` the existing issues, open and closed, and write them to `.sentinel/state/mine-candidates.json` as `[{"id": "…", "title": "…"}]`. The local tracker supplies its own candidates.
3. Run `node scripts/sentinel.mjs mine create --approved docs/feature-gaps.md --candidates .sentinel/state/mine-candidates.json --json` (leave out `--candidates` for the local tracker). It files nothing that is not ticked or that already has a `Created:` line.
4. Act on the result:
   - `created`: the local tracker already filed these and marked them in the gap list.
   - `toCreate`: `create` each one in the tracker with the given `title`, `body` and `labels`, mapping every neutral label through the `labelMap` from `issue describe`. After each, add a line `  - Created: <id>` under that gap in the gap list (after its other indented lines), so a re-run does not file it twice.
   - `skippedDuplicates`: show the user each gap with the existing issues it resembles. File one only if the user confirms it is different, and then the same way as `toCreate`.
5. Tell the user what was filed, with ids. The gap list is the record of what was approved; do not commit it to the default branch.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
