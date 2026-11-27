---
name: sentinel-setup
description: Bootstraps a repository for sentinel (Phase 0). Asks the user about the product's domain, decides the stack, architecture and folder layout with them and records it as an ADR, writes the GitHub test workflows, a README with diagrams and the agent guardrails, then opens a bootstrap pull request. Use when the user asks to set up, bootstrap or initialise a repository with sentinel.
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
4. The worktree starts from the default branch, so it lacks what the steps above wrote to the main checkout. If you saved the tracker with `issue use`, run the same `node scripts/sentinel.mjs issue use <tracker>` command (with the same options) in the worktree, so `sentinel.config.json` is written there. For the local tracker, move the bootstrap issue file that `create` wrote (under `issueProvider.localDir`, by default `docs/issues/`) from the main checkout to the same path in the worktree. These two files, written by this run, are the only changes you make to the main checkout.

## Record the domain

1. In the worktree, run `node scripts/sentinel.mjs setup --questions --json`. It changes nothing. It returns `next` (the open questions, each with `id`, `prompt`, optional `hint` and a `kind` of `text` or `yesno`) and `stack`.
2. Ask the user the questions in `next`, in order, a few at a time. Show the `hint` when there is one. Ask follow-ups until each answer is concrete: numbers for scale and availability targets, named roles for users, named systems for integrations. Do not invent answers; if the user does not know, record "unknown" and move on. A `yesno` question takes `yes` or `no`.
3. Write the answers to a JSON file outside the repository, for example in your temp directory, as `{"<question id>": "<answer>"}`. Use only the ids from `next`; every answer must be non-empty.
4. Run `node scripts/sentinel.mjs setup --answers <file> --json`. It merges the answers into `.sentinel/domain.json`.
5. Act on the exit code:
   - `0`: the domain is complete. Continue.
   - `2`: answering opened more questions (follow-up branches such as security, integrations or compliance). Ask the new questions in `next`, write them to the answers file and run the same command again. Repeat until it exits `0`.
   - any other code: stop and tell the user the error.

## Decide the stack and architecture

The project's biggest technical decisions are made here, with the user, not by the first feature's pull request. You propose; the user chooses; sentinel checks and records the result. Read `stack` and `architecture` from the last `--json` result.

1. **Recorded already.** If `architecture.recorded` is `true`, run `node scripts/sentinel.mjs architecture show` and show the user the decision. Ask whether it still holds. If it does, go on to "Generate the files"; if not, work through the steps below and record the new decision with `--force`.
2. **Stack per layer.** List the layers the domain answers call for (for example backend, frontend, database, worker) and, for each, the language and main frameworks.
   - `stack.projects` is empty (no code yet, perhaps only docs or config): propose a stack for each layer from the domain answers and anything the user said they prefer. Give each layer that is built and tested an ecosystem (`node`, `python`, `go`, `rust`, `java`, `dotnet`, `ruby`, `php`) and, when there are several such layers, a folder each (for example `src/backend` and `src/web`). A layer such as a database has no ecosystem.
   - Otherwise show the detected `stack.projects`, with their frameworks and paths, as the current stack, and ask the user to confirm or correct it. Name the test tooling of each project under `tests.<tier>` (unit, integration, E2E, load). A tier whose `detected` is `null` has no tool yet: name its `recommended` tool and, when `install` is not `null`, its install command, and run that command only after the user agrees. When `install` is `null`, tell the user what to add by hand.

   **STOP.** Wait for the user to confirm the stack or name another.

3. **Architecture.** Propose 2 to 3 named architectures that fit this stack and the domain answers, for example vertical slices, Clean Architecture, hexagonal (ports and adapters), layered, or a modular monolith. For each, give the trade-offs for this project: the scale and availability answers, the team size, and how complex the domain is. Say how much domain-driven design each uses, as one of `none`, `tactical` (entities, value objects and aggregates in code) or `strategic` (bounded contexts as modules, plus the tactical patterns), and which principles it follows (for example SOLID). Recommend one, and say why. With existing code, describe the architecture the code already follows as one of the options.

   **STOP.** Wait for the user to pick one or describe another.

4. **Folder layout.** Propose the top-level folders for the chosen architecture and stack, each with its purpose in one line (for example `src/backend/Domain`: entities and rules, no I/O). With existing code, start from the folders that exist.

   **STOP.** Wait for the user to confirm or edit the layout.

5. **Record it.** Write the decision to a JSON file outside the repository, for example in your temp directory:

   ```json
   {
     "layers": [
       {
         "name": "backend",
         "path": "src/backend",
         "ecosystem": "dotnet",
         "language": "C#",
         "frameworks": ["ASP.NET Core"]
       },
       {
         "name": "frontend",
         "path": "src/web",
         "ecosystem": "node",
         "language": "TypeScript",
         "frameworks": ["React"]
       },
       { "name": "database", "language": "SQL", "frameworks": ["PostgreSQL"] }
     ],
     "architecture": {
       "style": "Vertical slices around a pure domain project",
       "ddd": "tactical",
       "principles": ["SOLID"],
       "rationale": "Why this fits the project, in the user's terms."
     },
     "alternatives": [{ "style": "Clean Architecture", "reason": "Why the user did not pick it." }],
     "folders": [{ "path": "src/backend/Domain", "purpose": "Entities and rules, no I/O" }]
   }
   ```

   Use only what the user confirmed; `alternatives` holds the proposals they did not pick. Run `node scripts/sentinel.mjs setup --architecture <file> --json` in the worktree (add `--force` only when you are replacing a recorded decision the user changed). Exit `2` with `problems` means the file is invalid: fix each problem and run it again. It writes `.sentinel/architecture.json` and an ADR under `docs/adr/`, and the result's `files` lists both. The SDLC skills read this decision before every RFC, and the reviewer checks pull requests against it.

## Generate the files

1. Preview: `node scripts/sentinel.mjs setup --workflows --readme --name <project name> --dry-run --json`. Use the project name the user gave as the argument, or ask for one. In an empty repository the workflows and the README follow the recorded decision: one test job per tier for each layer with an ecosystem, in that layer's folder, with that layer's toolchain. A layer with no code yet has its job steps skipped, with a notice, until its manifest (for example `package.json` or a `.csproj`) exists, so the bootstrap pull request stays green. Do not scaffold code for a layer to make its jobs run: that is the first feature's work.
2. If a file already exists, the command fails and names it. Ask the user whether to overwrite it; add `--force` only when they agree. Otherwise drop `--readme` or `--workflows` for that file.
3. Run the same command without `--dry-run`. It writes `.github/workflows/sentinel-tests.yml` (unit, integration and E2E as separate jobs) and `.github/workflows/sentinel-load.yml` (load tests on manual dispatch and a schedule), and `README.md` with the domain context and Mermaid diagrams.
4. If the tracker is GitHub, offer the GitHub issue forms: `feature.yml` and `bug.yml` under `.github/ISSUE_TEMPLATE/`, which ask reporters in the browser for the same sections `sentinel-intake` writes. If the user agrees, run `node scripts/sentinel.mjs setup --issue-forms --dry-run --json`, then the same command without `--dry-run`. The forms take their labels from `labelMap`. If a form already exists, ask before adding `--force`.
5. If the code host is GitHub, offer the lesson check. sentinel learns only from the user's own pull requests (ADR-0008); this CI check enforces that for lessons committed to the repository, and it never runs a pull request's code. If the user agrees, run `node scripts/sentinel.mjs setup --learn-verify --json`. It writes `.github/workflows/sentinel-lessons.yml`, pinned to the commit of this sentinel release (if `warnings` says it could only pin the tag, tell the user), and, in `ruleset`, the path of a ruleset that makes the check required on the default branch with no bypass. Show the user the ruleset file. **STOP** and ask before applying it: only on an explicit yes, run `gh api --method POST repos/{owner}/{repo}/rulesets --input <ruleset path>` after the bootstrap PR is merged (the check must exist on the default branch first). It needs admin rights on the repository; if it fails, tell the user how to add the check under Settings → Rules instead.
6. Write the guardrails: `node scripts/sentinel.mjs guardrails write --json`. It adds the managed block to `AGENTS.md` and an `@AGENTS.md` pointer to `CLAUDE.md` when that file exists.
7. Show the user the generated files and adjust the README prose they ask for. Leave the managed block in `AGENTS.md` as written.

## Open the bootstrap PR

1. Commit in the worktree, in small focused commits: `.sentinel/domain.json`, `.sentinel/architecture.json` and its ADR, the workflows, the issue forms and the lesson check if you wrote them, `README.md`, `AGENTS.md` (and `CLAUDE.md` if it changed), `sentinel.config.json` and the local issue file if you wrote them, and the manifest and lockfile changes from any test tools you installed. Do not commit the answers file or anything under `.sentinel/state/`.
2. Open the PR: `node scripts/sentinel.mjs pr create --issue <issue-id> --title "Bootstrap repository with sentinel" --json`. It pushes the branch and targets the default branch. Then `link-pr` and `set-status` (in review) on the issue.
3. Hand off to the babysit loop with the pull request `number` that `pr create` printed, following the `sentinel-babysit` skill: run `node scripts/sentinel.mjs babysit <pr> --once --json` in the worktree and act on the result. On `wait` or `rerun` (exit `0`), wait `babysit.pollIntervalSec` seconds and run it again; after `babysit.timeoutMin` minutes of waiting with no change, stop and tell the user CI is still pending. On `patch` (exit `2`), fix the failure in `packet` inside the worktree, commit, push with a plain `git push`, and run it again; if `reason` says it is the same failing run as before, push or wait instead of making another fix. On `done` (exit `0`), go on. On `give-up` (exit `3`), stop: sentinel has commented on the PR, and a human takes over. On any other exit code, stop and show the error. Never skip or weaken a test to make CI pass.
4. Tell the user the PR link and the CI result. A merge is a human decision.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
