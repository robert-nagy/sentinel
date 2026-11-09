# ADR-0005: Issue trackers are reached through the host agent's own tooling

- **Status:** Accepted
- **Date:** 2026-11-04
- **Amends:** ADR-0004 (the `issueProvider` half; `codeHost` is unchanged)

## Context

ADR-0004 planned four built-in tracker clients: GitHub via `gh`, Jira over REST v3, Azure
DevOps over REST, and a Custom provider driven by shell-command templates. Each needs its own
credentials (`JIRA_API_TOKEN`, `AZURE_DEVOPS_EXT_PAT`…), format conversion (ADF, HTML) and
configuration written by `sentinel init`.

The host agent usually already has a working connection to the tracker: an MCP server
(Atlassian, Linear, GitHub, Azure DevOps), an authenticated CLI (`gh`, `glab`, `az`), or both.
Duplicating those clients inside sentinel costs a milestone (M7), adds a credential surface,
and still covers fewer trackers than the agent can already reach.

What the agent _cannot_ discover from its tool list is intent:

- which tracker is canonical when several are reachable (a GitHub remote _and_ a Linear MCP);
- where inside it the work lives (Jira project, Linear team, ADO area path);
- the team's vocabulary (labels in GitHub, statuses and issue types in Jira or Linear);
- a choice shared by everyone on the repo, not one that depends on each person's connectors.

A wrong guess has side effects (issues filed in the wrong place) and is awkward to undo.

## Decision

1. **Sentinel ships no remote tracker clients.** The agent reads and writes issues with the
   tools it already has. Skills describe tracker work as neutral verbs (get, list, create,
   comment, set status, link a PR, close) and never hard-code `gh issue …` or a REST call.
2. **Config records intent only.** `issueProvider` holds `tracker` (a free-form slug such as
   `github`, `jira`, `linear`, `local`), `location`, `notes`, `labelMap` (neutral label →
   the tracker's own label, issue type or status name) and `localDir`. No credentials, no
   transport options. Every field is optional.
3. **Resolution is lazy and deterministic.** There is no mandatory setup step. When a skill
   needs the tracker it calls `sentinel issue resolve --available <slugs the agent can reach>`.
   The rule, enforced in code:
   - `tracker` is configured → **use** it (or report **unavailable** if the agent says it
     cannot reach it).
   - Exactly one tracker reachable, and it does not conflict with the forge of the git remote →
     **use** it and offer to save the choice.
   - Several reachable, or the only one conflicts with the remote's forge → **ask** the user
     once (the remote's forge is listed first as the recommendation), then save.
   - None reachable → **fall back** to the local markdown tracker.

   `sentinel issue use <tracker>` saves the decision to the repo's `sentinel.config.json`.

4. **The local markdown tracker is built in.** It is the only tracker sentinel implements:
   issues are Markdown files with front matter under `localDir` (default `docs/issues`),
   committed with the repo. `sentinel issue create|get|list|comment|label|close|reopen` work
   on it, and exit with code 4 and a pointer to the agent's own tooling for any other tracker.
5. **Duplicate ranking stays in code.** The agent lists candidate issues with its own tools and
   passes them to `sentinel issue duplicates <title> --candidates <file>`, which ranks them
   with the same title-similarity rule for every tracker (the local tracker supplies its own
   candidates).
6. **`codeHost` is unchanged.** PR creation, check status, failed logs and re-runs stay
   deterministic in sentinel (GitHub via `gh`), because the babysitter's caps and failure
   signatures depend on them. `sentinel pr create --issue <id> --title <title>` no longer reads
   the issue: it writes `Closes #<id>` for GitHub, a plain reference otherwise, and comments
   the PR link on local issues itself.

## Consequences

- No tracker credentials or REST clients in sentinel; M7 (Jira/ADO clients) is dropped, and
  the GitHub and custom (shell-template) providers merged in M1 PR 4 (#11) are removed.
  Linear, GitLab, Jira, ADO and anything else with an MCP server or CLI work on day one.
- `sentinel init` no longer asks for a provider; it can still record one if the user passes
  `--tracker`.
- Two tracker steps move from code to skill prose, because sentinel no longer touches remote
  trackers: listing candidate duplicates (sentinel still ranks them) and status transitions
  (the agent applies `labelMap["status/in-progress"]` when a worktree is created) and PR
  links. Branch naming, worktrees, duplicate ranking, PRD gates and babysitter limits stay
  enforced in code.
- Behaviour on a repo is consistent across teammates once `tracker` is saved. Before that,
  resolution depends on each person's connectors, which is why the rule asks rather than
  guesses whenever there is any ambiguity.
- Format fidelity (ADF, HTML) is the connector's problem, not sentinel's.
