# RFC: Learn from user corrections across runs

> Issue: #39 | Created: 2026-11-26 | Status: Implemented (unattended run, `sentinel-sdlc-auto`)

## Summary

Implements [ADR-0008](../adr/0008-learning-from-interventions.md) (milestone M10a–M10c in one
PR). sentinel gains a lesson store (`.sentinel/learnings/` shared, `.sentinel/learnings.local/`
personal), a `sentinel learn` command group that validates, de-duplicates, recalls and decays
lessons in code, recurring-signature detection in the babysitter, a new `sentinel-learn-pr` skill
that learns from the user's own merged PRs only, and `learn` steps in `sentinel-sdlc`,
`sentinel-sdlc-auto`, `sentinel-review` and `sentinel-babysit`.

## Motivation

See issue #39 and ADR-0008: corrections are lost at the end of a session, the babysitter forgets
failure signatures across PRs, and reviewer fixes teach nothing. Lessons must stay cheap to
recall as they pile up, and nobody but the user (or CI) may create one.

## Detailed design

New core modules:

- `src/core/front-matter.ts`: the front-matter reader and writer, moved out of
  `local-tracker.ts` (no behaviour change for the local tracker).
- `src/core/globs.ts`: `compileGlob`, `validateGlob`, `globSpecificity`. Supports `**`, `*`, `?`
  and `{a,b}`; paths are normalised to `/` first, so `\` works on Windows. Absolute globs, `..`
  segments, `[`…`]` classes and `!` negation are rejected. No new dependency.
- `src/core/learnings.ts`: the lesson schema (`summary` ≤ 120 chars on one line, body ≤ 800, 1–8
  scope globs, ≤ 8 tags, optional `signature`, `source` ∈ `override | ci-signature | pr`, with `pr`
  and `from` required for `pr`), `lessonId` (`L-<yyyymmdd>-<6 hex of sha256(summary)>`), parse,
  render and validation (secret scan with `findSecrets`, `sentinel:managed` markers rejected).
  `LearnError` with kinds `invalid` (exit 2), `forbidden` (exit 6) and `failed` (exit 1).
- `src/core/learn-store.ts`: `LessonStore` over both directories.
  - **Index** `.sentinel/state/learn-index.json`: one `readdir` per store and one `stat` per
    `.md` file; a file is read and parsed only when its size or mtime changed. Invalid files are
    kept in the index with their problem and never recalled. `refresh()` reports how many files
    it read, so tests can assert that unchanged files are not read.
  - **Usage** `.sentinel/state/learn-usage.json`: per lesson (keyed `<store>:<id>`)
    `recurrences`, `recalls`, `lastUsed`, `lastReinforced`, `archived`; per PR `reviewedAt` and
    `offeredAt`.
  - `add`: validate → dedupe within the same store (same id, same `signature`, or
    `titleSimilarity` ≥ `DUPLICATE_THRESHOLD` with a shared scope glob) → write `<id>.md`
    atomically or bump `recurrences` → prune.
  - `recall({ paths, tags, signature, limit })`: candidates from the index only; ranking tuple
    (tier, specificity, `log2(1 + recurrences)`, `lastReinforced ?? created`, id); tier 3 =
    signature, 2 = a specific glob matches a path, 1 = global lesson (`["**"]`) with paths or a
    matching tag. Personal wins ties. Opens only the returned files; records recalls.
  - `prune`, `restore`, `list`, `show`, `prReport` (PRs cited by shared lessons).
- `src/core/learn-pr.ts`: the own-PR gate and PR learning.
  - `assertOwnPullRequest`: the PR's author (`pulls/<n>`, `user.login`) must equal the token's
    login (`gh api user`), else `LearnError('forbidden')`. Called by `suggest`, `pr-changes`,
    `mark-reviewed` and `add --source pr`. No flag, env var or config key disables it.
  - `suggest`: the user's merged PRs (`gh pr list --author @me`, up to 100, one call with
    `commits`, `reviews` and `comments`), rows by other authors dropped, learned PRs dropped,
    first 20, with counts. `--offer`: only PRs that sentinel babysat on this machine, that have
    something to learn from and were never offered; marks them offered; empty when
    `learn.offerPrLessons` is `false`.
  - `prChanges`: per PR (≤ 10) the commits by someone other than the PR author, plus every
    commit after the last head SHA the babysitter recorded, and the human review comments,
    review bodies and conversation comments (bots and the PR author's own comments skipped).
  - `verify`: CI check for a PR (see below).
- `src/core/hosts/github.ts` + `code-host.ts`: `currentLogin`, `getPullRequestAuthor`
  (login, type, `author_association`, head SHA), `listMergedPullRequests`,
  `listPullRequestCommits`, `listPullRequestComments`, `listPullRequestFiles`, `readFileAtRef`.
- `src/core/pr-babysitter.ts`: the state records the open PR's head SHA (`headSha`); the CLI adds
  `recurring`, `recurringPrs` and `lessons` to the output when a packet's signature is in a lesson
  or in another PR's local babysit state.
- `src/core/state.ts`: `StateStore` writes a `.gitignore` (`*`) into `.sentinel/state/` when it
  creates it, so the index, usage and babysit state are never committed in target repos (today
  only this repo's own `.gitignore` covers it). The personal store gets the same file.
- `src/core/config-schema.ts`: `learn` section (`enabled`, `maxActive`, `archiveAfterDays`,
  `recallLimit`, `offerPrLessons`), strict like the others; `schema/config.json` regenerated.
- `src/core/workflows.ts`: `renderLearnVerifyWorkflow(version)`, a `pull_request_target` workflow
  that downloads the sentinel bundle at the pinned tag from this repository (never the PR's code)
  and runs `learn verify`. `sentinel setup --learn-verify` writes it; this repository gets its own
  copy that runs the bundle from the base checkout.
- `src/core/doctor/checks.ts`: `learn-verify` check: warns when the workflow is missing or its
  check is not required by a ruleset on the default branch (best effort, never fails doctor).

CLI (`src/cli/learn.ts`):

```
sentinel learn add --file <lesson.md> [--local] [--json]
sentinel learn recall [--paths <files…>] [--tags <tags…>] [--signature <sig>] [--limit <n>] [--json]
sentinel learn list [--archived] [--json] | show <id> | prune [--report] | restore <id>
sentinel learn suggest [--limit 20] [--offer] [--json]
sentinel learn pr-changes <pr…> [--json]
sentinel learn mark-reviewed <pr…>
sentinel learn verify --pr <n> [--json]
```

`learn verify` fails (exit 2) when the PR changes anything under `.sentinel/learnings/` and its
author has no write access (`author_association` not `OWNER`, `MEMBER` or `COLLABORATOR`), when a
changed lesson is invalid or its file name differs from its id, or when a `source: "pr"` lesson
cites a PR whose author is not this PR's author. It reads files with the contents API at the PR's
head SHA and never checks out or runs PR code.

Skills: new `sentinel-learn-pr`; `learn` steps in `sentinel-sdlc` and `sentinel-sdlc-auto`
(identical, checked by a test), `sentinel-review`, `sentinel-babysit`; `sentinel-setup` offers the
verify workflow and the ruleset. README skills table, PLAN ticks, ADR-0008 accepted.

## API changes

- New `sentinel learn` command group (above), new exit code `6` (`Forbidden`).
- `babysit --json` output gains `recurring`, `recurringPrs` and `lessons` (additive).
- `CodeHost` gains read methods (additive for GitHub; other hosts must implement them).
- New config section `learn` (optional, defaults apply).
- `setup --learn-verify` (additive).

## Data changes

- New committed directory `.sentinel/learnings/`; new git-ignored `.sentinel/learnings.local/`.
- New state files `learn-index.json`, `learn-usage.json`; babysit state gains `headSha`
  (optional, older files still load).
- No migration: an empty store is the starting point.

## Test plan

- Unit: front matter (moved, local tracker tests unchanged), globs (including Windows paths),
  lesson validation and id, store add/dedupe/recall/rank/prune/restore, index refresh reads
  only changed files, a 2,000-lesson performance test (warm recall < 50 ms, cold build
  < 500 ms, with a margin on Windows), config section, GitHub host methods with a fake runner,
  own-PR gate (mismatch → exit 6; no flag or config key disables it), suggest/pr-changes/verify
  with fake hosts, babysit recurring signature, skill lint (identical `learn` steps in both SDLC
  skills, new skill has guardrails and only bundled commands).
- Integration: the `learn` CLI end to end against a temp repo (add → recall → prune → restore).
- E2E: the existing plugin-install E2E covers the new skill's presence; the CLI E2E runs
  `learn add` and `learn recall` through the built binary.

## Rollout and rollback

Ships in the next minor release with a changeset. `learn.enabled: false` makes every `learn`
command a no-op that says so (recall returns nothing, add writes nothing). The own-PR gate is
not affected by `enabled`. Rollback: revert the PR; lesson files are plain Markdown and can be
deleted.

## Risks and alternatives

- A bad lesson misleads later runs: caps, secret scan, data framing, PR review, own-PR gate.
- Recall ranks by `lastReinforced`, not `lastUsed` (ADR said `lastUsed`): ranking by the last
  recall would let a lesson win because it was shown before, which decision 7 forbids. Decay
  still uses `lastUsed`.
- Commit diff stats are not fetched (one API call per commit); the skill reads a commit with
  `git show <sha>` when it needs the diff.
- The recorded head SHA can include a human commit pushed while the babysitter was still
  watching; commits by other authors are always included, so only the user's own hand-made
  commits in that window can be missed.

## Departures from the first draft

- Personal lessons and all local state (index, usage, babysit state) live in the main checkout
  (`git rev-parse --git-common-dir`), shared lessons in the current checkout; one index per
  checkout. The first draft put everything under the current repository root, which in an issue
  worktree would lose usage and personal lessons when the worktree is removed.
- The babysit state moved to the main checkout as a consequence.
- The PR reads are a separate `PullRequestReader` interface rather than new `CodeHost` methods.
- `learn suggest` counts only commits by other authors; `pr-changes` also lists the user's own
  commits after the recorded head SHA.
- `learn verify` exits `2` when lesson changes break the rule (a check failure), and `6` is kept
  for refusals of the user's own commands.

## Open questions

None blocking. Ruleset creation stays a user step (the skill shows the `gh api` call and runs it
only after approval).

## Approval

- [ ] Design reviewed and approved. Implementation does not start until this is checked.
      (Unattended run: not waited for, per `sentinel-sdlc-auto`.)
