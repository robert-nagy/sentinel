---
name: sentinel-setup
description: Bootstraps a repository for sentinel (Phase 0). Asks the user about the product's domain, confirms the stack, writes the GitHub test workflows, a README with diagrams and the agent guardrails, then opens a bootstrap pull request. Use when the user asks to set up, bootstrap or initialise a repository with sentinel.
argument-hint: [project name]
disable-model-invocation: true
---

# sentinel setup (Phase 0)

You ask the questions and write the answers; sentinel decides which questions are open, which stack applies and what the generated files contain. Every command below runs from this skill's folder path (`node scripts/sentinel.mjs …`) with the repository, or later the worktree, as the working directory.

## Check the environment

1. Run `node scripts/sentinel.mjs doctor --json`. Stop on any check that is `fail` and tell the user its `hint`.
2. Run `node scripts/sentinel.mjs config show` and note `codeHost.defaultBranch`.

## Find the issue tracker

1. Run `node scripts/sentinel.mjs issue resolve --json`. List the trackers you can reach with your own tools (for example a Jira, Linear or GitHub MCP server, or `gh`) and pass them as `--available <slugs>`.
2. Follow `action`: `use` means use that tracker (offer to save it with `node scripts/sentinel.mjs issue use <tracker>`); `ask` means ask the user once and save the answer; `fallback` means the local Markdown tracker; `unavailable` means stop and tell the user which connection is missing.
3. Run `node scripts/sentinel.mjs issue describe` and follow it: it gives the tracker's location, notes and label map. Describe tracker work only as the neutral verbs `get`, `list`, `create`, `comment`, `set-status`, `link-pr` and `close`, and carry them out with the tool that fits. For the local tracker the same output lists the `sentinel issue` commands.

## Open the bootstrap issue and worktree

1. `list` open issues and reuse one titled "Bootstrap repository" if it exists; otherwise `create` it, describing the Phase 0 work. Note its id.
2. Create the worktree: `node scripts/sentinel.mjs worktree add <issue-id> --title "Bootstrap repository" --json`. It names the branch with `sentinel branch name` and the configured template. Work only inside the path it prints from here on, and `set-status` the issue to in progress.
3. If it fails because `origin/<default branch>` does not exist (a brand-new repository with no commits), **STOP.** Ask the user to push a first commit to the default branch themselves (for example a `.gitignore` or a licence), then run the command again. Never create that commit yourself.

## Record the domain

1. In the worktree, run `node scripts/sentinel.mjs setup --questions --json`. It changes nothing. It returns `next` (the open questions, each with `id`, `prompt`, optional `hint` and a `kind` of `text` or `yesno`) and `stack`.
2. Ask the user the questions in `next`, in order, a few at a time. Show the `hint` when there is one. Ask follow-ups until each answer is concrete: numbers for scale and availability targets, named roles for users, named systems for integrations. Do not invent answers; if the user does not know, record "unknown" and move on. A `yesno` question takes `yes` or `no`.
3. Write the answers to a JSON file outside the repository, for example in your temp directory, as `{"<question id>": "<answer>"}`. Use only the ids from `next`; every answer must be non-empty.
4. Run `node scripts/sentinel.mjs setup --answers <file> --json`. It merges the answers into `.sentinel/domain.json`.
5. Act on the exit code:
   - `0`: the domain is complete. Continue.
   - `2`: answering opened more questions (follow-up branches such as security, integrations or compliance). Ask the new questions in `next`, write them to the answers file and run the same command again. Repeat until it exits `0`.
   - any other code: stop and tell the user the error.

## Confirm the stack

Read `stack` from the last `--json` result.

- `stack.proposal` is `true` (the repository has no code yet): propose an ecosystem from the domain answers and the user's preferences, one of `node`, `python`, `go`, `rust`, `java`, `dotnet`, `ruby`, `php`. **STOP** and wait for the user to confirm or pick another. Pass the confirmed one as `--stack <ecosystem>` to every command in the next section.
- Otherwise show the user the detected `stack.projects` and their test tooling per tier (unit, integration, E2E, load), and ask them to confirm. If a tier has no tool, name the `recommended` one and its `install` command, and install it only after the user agrees.

## Generate the files

1. Preview: `node scripts/sentinel.mjs setup --workflows --readme --name <project name> --dry-run --json` (add `--stack <ecosystem>` for an empty repository). Use the project name the user gave as the argument, or ask for one.
2. If a file already exists, the command fails and names it. Ask the user whether to overwrite it; add `--force` only when they agree. Otherwise drop `--readme` or `--workflows` for that file.
3. Run the same command without `--dry-run`. It writes `.github/workflows/sentinel-tests.yml` (unit, integration and E2E as separate jobs) and `.github/workflows/sentinel-load.yml` (load tests on manual dispatch and a schedule), and `README.md` with the domain context and Mermaid diagrams.
4. Write the guardrails: `node scripts/sentinel.mjs guardrails write --json`. It adds the managed block to `AGENTS.md` and an `@AGENTS.md` pointer to `CLAUDE.md` when that file exists.
5. Show the user the generated files and adjust the README prose they ask for. Leave the managed block in `AGENTS.md` as written.

## Open the bootstrap PR

1. Commit `.sentinel/domain.json`, the workflows, `README.md`, `AGENTS.md` (and `CLAUDE.md` if it changed) in the worktree, in small focused commits. Do not commit the answers file or anything under `.sentinel/state/`.
2. Open the PR: `node scripts/sentinel.mjs pr create --issue <issue-id> --title "Bootstrap repository with sentinel" --json`. It pushes the branch and targets the default branch. Then `link-pr` and `set-status` (in review) on the issue.
3. Tell the user the PR link. If the `sentinel-babysit` skill is installed, offer to watch CI with it; otherwise CI is theirs to watch. A merge is a human decision.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
