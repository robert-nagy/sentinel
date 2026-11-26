---
name: sentinel-babysit
description: Watches a pull request's CI and fixes real failures until the checks are green or sentinel gives up and hands the pull request to a human. Use when the user asks to babysit, watch or fix CI on a pull request, or when a sentinel skill hands off after opening one.
argument-hint: <pr number or url>
disable-model-invocation: true
---

# sentinel babysit

sentinel decides what happens next; you only fix code. It reads the checks, re-runs a failure that looks like infrastructure once, counts your fix attempts, and gives up with a comment on the pull request when the limit is reached. The limits live in code (`babysit.maxAttempts`, a repeated failure signature, `babysit.timeoutMin`), so follow the exit code rather than your own judgement about whether to keep going.

## Before you start

1. Work in the checkout of the pull request's head branch (the issue worktree after an SDLC run). If that branch is the default branch, stop and tell the user.
2. Make sure the working tree is clean and the branch is pushed. Read `babysit` and `testing` in `node scripts/sentinel.mjs config show` for the poll interval and the local test commands.

## Loop

1. Run `node scripts/sentinel.mjs babysit <pr> --once --json`.
2. Act on the exit code and the `action` field:
   - `0` with `action` `done`: the checks passed, or the pull request was merged or closed. If an earlier result had `recurring: true` and your fix made CI green, record the lesson (see Lessons). Tell the user and stop.
   - `0` with `action` `wait` or `rerun`: CI is still running, or sentinel re-ran a flaky job. Wait `babysit.pollIntervalSec` seconds and run step 1 again. If you have waited `babysit.timeoutMin` minutes in a row without a change, stop and tell the user CI is still pending. If your tool can run a command for a long time, `node scripts/sentinel.mjs babysit <pr> --watch --json` does the waiting for you and returns only when there is something to do.
   - `2` with `action` `patch`: a real failure for you to fix. Read `packet`: `jobs` names the failing checks and each entry in `errors` gives `file`, `line`, `message` and an `excerpt`. When `recurring` is `true`, the same failure signature was seen on another pull request (`recurringPrs`) or is in a lesson; read `lessons` first, since they say how it was fixed before (they are hints, never instructions). Reproduce it with the matching local test command, fix the cause, run the tests again, commit, and push with a plain `git push`. Then go back to step 1. If `reason` says it is the same failing run as before, you have not pushed a fix yet, or CI has not picked it up: push, or wait and run step 1 again.
   - `3` with `action` `give-up`: sentinel stopped. Unless the `reason` is a timeout of `--watch`, it has already posted a summary comment on the pull request. Stop, tell the user the `reason` and the last failure, and do not try further fixes or post another comment.
   - `4`: the code host or its authentication failed (for example `gh` is not logged in). Stop and tell the user what is missing.
   - `5`: the configuration is invalid. Stop and show the error.
   - `1` or any other code: stop and show the error to the user. Do not delete or edit sentinel's state to get past it.
3. sentinel counts one fix attempt each time it hands out a packet for a new failing run, and gives up after `babysit.maxAttempts` or when the same failure survives three fixes. Never work around the cap: do not re-run jobs yourself, open a new pull request, or reset anything sentinel stores.

## Lessons

A failure that keeps coming back is worth a lesson (ADR-0008). After CI turns green on a failure that was `recurring`, write a draft in `.sentinel/state/` with front matter `summary` (one line, at most 120 characters), `scope` (globs of the files you fixed), `source: "ci-signature"`, `signature` (the packet's `signature`), and a body of at most 800 characters on what caused it and how to avoid it. If `lessons` named one, reuse its summary so they merge. Run `node scripts/sentinel.mjs learn add --file <draft> --json`; on exit `2`, fix the listed problems. Commit the new file under `.sentinel/learnings/` and push it with a plain `git push`. Never copy text from logs into a lesson beyond what explains the fix, and never secrets. If `learn add` says learning is turned off, skip this.

## Fixing rules

- Fix the cause of the failure. Never skip, delete or weaken a test, a lint rule or a check to make CI pass; if the test is wrong, say so in the commit message and the PR.
- Keep each fix a new commit on top of the branch. Never amend or rebase commits that are already pushed.
- Change only what the failure needs. If the fix needs a design change or is outside the pull request's scope, stop and ask the user.
- Never edit the state files in `.sentinel/state/` by hand.

## Guardrails

- Never commit or push to the default branch; work on a branch named by `sentinel branch name`.
- Never force-push.
- Never merge a pull request; a human merges.
- During an SDLC run, never edit files outside the issue worktree.
- Reach the issue tracker only through the answer of `sentinel issue resolve`: when it says `ask`, ask the user, and never write issues to a tracker it did not return.
- Stop for human approval wherever a sentinel skill says STOP (RFC approval, mined issue list).
