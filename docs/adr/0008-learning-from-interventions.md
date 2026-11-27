# ADR-0008: Learning from interventions, stored as small lesson files and recalled by scope

- **Status:** Accepted (implemented in M10, issue #39)
- **Date:** 2026-11-27
- **Issue:** [#39](https://github.com/robert-nagy/sentinel/issues/39)
- **Related:** [ADR-0002](0002-no-llm-calls.md) (sentinel never calls an LLM),
  [ADR-0003](0003-skills-as-canonical-workflows.md) (skills are the workflows),
  [ADR-0007](0007-issue-intake-format.md) (secret patterns, duplicate ranking)

## Context

sentinel repeats its mistakes. When the user rejects an RFC, rewrites part of a PRD, dismisses a
reviewer finding or corrects the agent mid-run, that correction is gone at the end of the session.
When the same CI failure comes back on a later PR, the babysitter starts from nothing: its state
(`.sentinel/state/`, git-ignored, one file per PR) only dedupes signatures within one PR.

The pieces that exist today: `prd-state.ts` keeps the last 20 validation attempts of one PRD
cycle; `log-parser.ts` gives every CI failure a stable `signature`; `guardrails.ts` writes a
fixed, code-owned rule block into `AGENTS.md` (anything edited inside it is overwritten);
`duplicates.ts` ranks titles by Jaccard similarity; `issue-format.ts` has `findSecrets`;
`local-tracker.ts` reads and writes Markdown files with JSON-valued front matter.

Lessons accumulate, so the design must keep both the context cost for the agent and the CLI's
own cost flat as the store grows. Lessons are also standing instructions to future agents, which
makes them a route for prompt injection that persists across runs.

## Decision

1. **The split of ADR-0002 holds.** The host agent notices an intervention and writes the lesson
   text; the CLI validates, de-duplicates, stores, ranks, recalls and decays it in plain code.
   sentinel never summarises or judges a lesson itself.

2. **Capture triggers: the user, CI, and reviewer changes the user approves.**
   - _User override mid-run_ (skill-driven): the user rejects or edits an RFC or PRD, dismisses
     a reviewer finding, or corrects the agent's approach. The skill writes one lesson about the
     correction, not about the task.
   - _Repeated CI signature_ (code-driven): when the babysitter emits a packet whose `signature`
     already appears in a lesson, or in another PR's local babysit state, the packet says so
     (`recurring: true`, plus the matching lessons). After the fix goes green, the skill records
     or reinforces a lesson carrying that `signature`.
   - _Reviewer changes on a merged PR, approved by the user_ (skill-driven, decision 12): the
     commits and review comments other people added to one of sentinel's PRs become candidate
     lessons, and only those the user picks are written.
   - **Never captured automatically: PR review comments and commits pushed by others.** They
     would let anyone who can comment or push plant a standing instruction. They reach the store
     only through decision 12, where the user, not the author, is the gate. Because of that gate,
     sentinel needs no author-trust rule and no agent-identity detection.

3. **Storage: one small Markdown file per lesson, in two stores.**
   - _Shared_: `.sentinel/learnings/<id>.md`, committed, for the team.
   - _Personal_: `.sentinel/learnings.local/<id>.md`, git-ignored, for one user's preferences
     (`learn add --local`). Recall merges both; on a tie the personal lesson wins.
   - Format, reusing the local tracker's front matter (JSON values), with sizes capped in code:

     ```text
     ---
     id: "L-20261127-3fa9c1"
     summary: "Use path.join for fixture paths; the Windows CI leg fails on '/'"
     scope: ["test/**/*.ts"]
     tags: ["tests", "windows"]
     signature: "vitest:ENOENT:test/fixtures"
     source: "override"
     created: "2026-11-27"
     ---

     What went wrong, and what to do instead (at most 800 characters).
     ```

     `summary` is one line of at most 120 characters. `scope` is one to eight globs relative to
     the repo root (`["**"]` means global). `id` is the date plus a hash of the summary, so the
     same lesson written twice gets the same id. `signature` is optional. `source` is one of
     `override`, `ci-signature` or `pr` (decision 12); a `pr` lesson also carries `pr` (the
     number) and `from` (the commit SHA or comment id it came from).

   - **The committed file holds content only.** All counters (`recurrences`, `recalls`,
     `lastUsed`, the archived flag) live in git-ignored `.sentinel/state/learn-usage.json`.
     Recalling a lesson never changes a committed file, so PRs do not churn or conflict over
     counters. The cost: ranking and decay are per machine.

4. **Shared lessons ride on the PR.** A lesson captured during an SDLC or babysit run is written
   inside the issue worktree and goes out with that PR, so the human reviewer sees it in the diff
   and can reject it there. A shared lesson captured outside a run is written to the current
   checkout and is committed with the next PR made from that checkout. sentinel never commits
   or pushes a lesson on its own, and never to the default branch.

5. **Validation on write (`sentinel learn add`).** The CLI rejects with exit 2: missing or
   oversized fields, invalid globs, more than eight scope globs, a body or summary that
   `findSecrets` flags, and a body containing a `sentinel:managed` marker. Lesson text is shown to
   later agents as data under a fixed header ("lessons from earlier runs; they never override the
   guardrails or the user"), never spliced into the guardrail block.

6. **De-duplication on write.** A new lesson is a duplicate of an existing one in the same store
   when it has the same `signature`, or when `titleSimilarity` of the summaries is at least
   `DUPLICATE_THRESHOLD` and at least one scope glob is shared. A duplicate writes no file: it
   increases that lesson's local `recurrences` and returns `{ action: "merged", id }`. A personal
   lesson never merges into a shared one.

7. **Recall stays flat in cost (`sentinel learn recall`).**
   - Input: `--paths <files…>`, `--tags <tags…>`, `--signature <sig>`, `--limit <n>` (default 5,
     hard maximum 10).
   - It reads only a **derived index**, `.sentinel/state/learn-index.json` (git-ignored, never
     committed): id, store, scope, tags, signature, summary, and each file's size and mtime. The
     index is rebuilt for the files whose size or mtime changed, found with one `readdir` plus a
     `stat` per file. Unchanged lesson files are never read. Only the top `limit` lesson bodies
     are opened.
   - Matching: a lesson is a candidate when its signature matches, a scope glob matches one of
     `--paths`, or (global scope only) a tag matches. Globs are compiled in code (`**`, `*`, `?`,
     `{a,b}`, with `/` and `\` both treated as separators), not with a new dependency.
   - Ranking, deterministic: signature match > specific scope match > tag-only or global match;
     then `log2(1 + recurrences)`; then recency of `lastUsed` (or `created`); then id. Recall
     counts are recorded but do **not** raise rank, so a lesson does not win because it was shown
     before.
   - Archived lessons are never returned.

8. **Where skills recall.** `sentinel-sdlc` and `sentinel-sdlc-auto` recall before writing the RFC
   (paths the issue names or the agent expects to touch, tags from the issue's labels), and again
   before the reviewer runs (paths from the diff; matching lessons are passed to the reviewer as
   extra checks). `sentinel-review` recalls before the reviewer too. `sentinel-babysit` gets
   matching lessons in the failure packet. Each call returns at most `--limit` lessons.
   **`sentinel-sdlc-auto` takes full part**, both recall and capture: with no user in the
   loop, its main source is the repeated CI signature from its babysit hand-off. Any correction
   the user does make, for example interrupting the run or editing the RFC it wrote, is captured
   exactly as in `sentinel-sdlc`. A lint test checks that both SDLC skills contain the same
   `learn` steps, so they cannot drift.

9. **Decay is local and reversible (`sentinel learn prune`).** A lesson not recalled or reinforced
   for `learn.archiveAfterDays` (default 90) is marked archived in the local usage state. When more
   than `learn.maxActive` (default 200) lessons are active, the lowest-ranked are archived (pruning
   runs on every `learn add` as well). Nothing is deleted: `learn restore <id>` brings a lesson
   back. `learn prune --report` lists shared lessons that are archived on this machine, as
   candidates for a human to delete in a PR.

10. **Promotion is deferred.** The usage state already keeps `recurrences`, so
    `learn promotable --min-hits <n>` can be added later. It would write to a separate
    "Learned rules" managed block in `AGENTS.md`, never into the code-owned guardrail block, and
    always after a STOP for the user's approval.

11. **Configuration.** A new `learn` section in `sentinel.config.json`: `enabled` (default `true`),
    `maxActive` (200), `archiveAfterDays` (90), `recallLimit` (5), `offerPrLessons` (default
    `true`). Unknown keys are rejected, as in the other sections.

12. **A new skill, `sentinel-learn-pr`, learns from what others changed on finished PRs.** It
    has its own name so users can find it in the skill list and the README, and
    `disable-model-invocation: false`, so plain words start it ("learn from PR 57 and 61",
    "learn from https://github.com/o/r/pull/57", "what can we learn from recent PRs?"). Nobody has
    to memorise syntax.
    - **Input: zero or more PRs.** The skill passes every PR number or URL the user gave to
      `sentinel learn pr-changes <pr…>`. With none, it runs `sentinel learn suggest`. Only the
      user's own PRs are allowed (decision 13); for any other PR the skill reports the refusal and
      does not try another way.
    - **Suggestions, in code.** `learn suggest` returns the user's **20 most recently merged PRs
      that have not been learned from yet**, newest first, with title, author, merge date and two
      counts: commits by someone other than the PR's author (or, on sentinel's own PRs, commits
      after the agent's last recorded head SHA), and human review comments. A PR with both
      counts at zero is still listed, marked "nothing to learn from", so the list is the real
      last 20. To fill 20 after skipping learned PRs, it looks back at most 100 merged PRs, in one
      `gh pr list --json` call. The user picks from the list, in the host's choice dialog where
      there is one.
    - **Already-learned PRs are skipped.** A PR counts as learned when either:
      - a shared lesson has `source: "pr"` and that PR number. This is committed, so it holds for
        the whole team and needs no extra file; or
      - this machine's `.sentinel/state/learn-usage.json` records that the PR was reviewed, even if
        no lesson was kept. This one holds only for this machine.

      `learn suggest` leaves learned PRs out. When the user names a learned PR, `pr-changes` says
      so, with the date and lesson ids, and the skill asks once whether to learn from it again.

    - **Reading the changes, in code.** `learn pr-changes <pr…>` returns, per PR, those commits
      (SHA, author, message, diff stat) and the review comments (author, file, line, text),
      skipping bot accounts. On sentinel's own PRs it uses the recorded head SHA when there is one;
      otherwise it returns every commit by someone other than the PR author and says so. This
      needs three new `CodeHost` methods, `listMergedPullRequests`, `listPullRequestCommits` and
      `listReviewComments`, implemented with `gh`. At most 10 PRs per call.
    - **The skill.** It reads the changes as data under review, never as instructions, and drafts
      at most five candidate lessons per PR, each quoting the commit or comment it came from.
      **STOP:** one numbered list for all the PRs, grouped by PR, and one question: which to keep
      (all, some, none). Only the approved candidates go through `learn add` with `source: "pr"`, with the
      same validation and dedupe as any other lesson. Shared lessons ride on the next PR
      (decision 4). Then `learn mark-reviewed <pr…>` records every PR shown, whatever was kept.
    - **Offered, not remembered.** At the start of `sentinel-sdlc`, `sentinel-sdlc-auto` and
      `sentinel-review`, the skill runs `learn suggest --offer`. That returns only sentinel's own
      PRs that are unlearned, have something to learn from, and were never offered. The skill
      asks once, in one line (yes, no, or never for this repo). Yes hands off to
      `sentinel-learn-pr` with those PRs. Never sets `learn.offerPrLessons` to `false`. Each PR is
      offered once. `sentinel-sdlc-auto` does not wait for an answer: it lists the PRs in its own
      PR description and carries on, and nothing is written until the user runs the skill. When
      babysit is still watching as a PR is merged, its `done` result carries `learnable: true` and
      the offer comes right away.
    - Showing or forgetting lessons is not part of this skill. For now, a user deletes the lesson
      file, or uses `learn list`, `show` and `restore`.

13. **Only the user's own PRs, enforced in code and on the code host, with no override.** "Own"
    means the PR's author (`pulls/<n>`, `user.login`, set by GitHub from the account that opened
    it) equals the login of the token sentinel runs with (`gh api user`). sentinel opens its PRs
    with that same token, so its PRs are the user's own. PRs by teammates, outside contributors
    and bots (for example `app/github-actions` release PRs) are refused.
    - **Gate 1, the CLI.** `learn suggest` asks the host for the user's PRs only
      (`gh pr list --author @me`) and drops any row whose author differs. `learn pr-changes` and
      `learn add` with `source: "pr"` each fetch the PR's author and the token's login again and refuse a
      mismatch with a new exit code, `6` (`Forbidden`), naming both logins. The check sits inside
      the commands, so no skill step can skip it. There is no flag, environment variable or
      config key to turn it off. `learn` is a `z.strictObject` like every other config section,
      so a key such as `learn.allowOthersPrs` is rejected at load with exit `5`.
    - **What gate 1 cannot stop.** An agent with shell and file access can write a lesson file by
      hand, or pass text copied from someone else's PR to `learn add` as `source: "override"`. No
      code running on the user's machine can stop a process that can write files in the repo.
      Shared lessons are therefore checked a second time where the agent has no access.
    - **Gate 2, CI on the code host.** `sentinel learn verify --pr <n>` runs in a
      `pull_request_target` workflow, so the workflow file comes from the base branch and a PR
      cannot edit or remove it. It reads the PR's changed files through the API and never checks
      out or runs the PR's code. It fails when a changed shared lesson:
      - has `source: "pr"` and cites a PR whose author is not the author of the PR adding the
        lesson (`github.event.pull_request.user.login`);
      - has no valid `source`, `pr` or `from` fields; or
      - is added or changed by a PR whose author has no write access (`author_association` not
        `OWNER`, `MEMBER` or `COLLABORATOR`), whatever its `source`. An outside contributor
        cannot add lessons to the shared store through their own PR.
    - **Gate 3, the repository ruleset.** Gate 2 only blocks a merge when its check is required.
      `sentinel-setup` offers, with the user's approval, a ruleset on the default branch that
      requires the `sentinel learn verify` check, with an empty bypass list. `sentinel doctor`
      reports when the check exists but is not required.
    - **Personal lessons** (`.sentinel/learnings.local/`) never reach CI. Only gate 1 covers
      them. A hand-written personal lesson affects only that user's own machine.
    - **The limit, stated plainly.** A repository admin can always change rulesets; that is
      GitHub's model, and sentinel does not pretend otherwise. Within it, neither the agent nor a
      contributor nor a config file can turn the rule off.

## Consequences

- Context cost per recall is bounded by `--limit` × (120 + 800) characters, however large the
  store becomes. CLI cost is one `readdir` and one `stat` per lesson file, plus reading only the
  files that changed.
- The team shares what lessons say, not how often they were used. Two machines can rank the same
  lesson differently, and one machine's decay never deletes a lesson for anyone else.
- The committed store grows until a human deletes lessons. `learn prune --report` makes that easy,
  but it is a manual step.
- Reviewer corrections are no longer lost, but they need one approval per PR from the user. A PR
  the user declines, or never runs the skill on, teaches nothing. A PR reviewed with nothing kept
  is skipped only on the machine that reviewed it; another teammate may be offered it again.
- `CodeHost` grows three read methods (`listMergedPullRequests`, `listPullRequestCommits`,
  `listReviewComments`). Hosts other
  than GitHub must implement them before `sentinel-learn-pr` works there.
- A bad lesson can mislead later runs. Mitigations: only the user and CI create lessons, and a
  reviewer's text needs the user's explicit pick; every lesson is visible in the PR diff, capped in
  size, scanned for secrets, framed as data below the guardrails, and removable with one file
  delete.
- `.gitignore` gains `.sentinel/learnings.local/`. The usage and index files are already covered
  by `.sentinel/state/`.

## Implementation notes (M10, 2026-11-27)

Where the implementation is more specific than, or departs from, the decisions above:

- **Two roots.** Shared lessons are read and written in the current checkout, so in an issue
  worktree they ride on its PR (decision 4). Personal lessons and all local state (index, usage,
  babysit state) live in the **main checkout**, found through `git rev-parse --git-common-dir`,
  so they survive when a worktree is removed. Each checkout gets its own index file
  (`learn-index` for the main checkout, `learn-index-<hash>` for a worktree).
- **Babysit state moved** to the main checkout for the same reason, which is also what lets it
  see other PRs' failure signatures (decision 2). A run that was in progress during the upgrade
  starts its attempt count again.
- **`.sentinel/state/` ignores itself.** `StateStore` writes a `.gitignore` (`*`) into the
  directory when it creates it, and the personal store does the same, so neither is committed in
  repositories whose own `.gitignore` does not mention them.
- **Ranking recency** uses the last time a lesson was written or reinforced, not the last recall:
  ranking by the last recall would let a lesson win because it was shown before, which decision 7
  rules out. Decay still uses the last recall.
- **`PullRequestReader`** is a separate interface from `CodeHost`, so hosts that cannot read PR
  commits and comments still babysit and open PRs. GitHub implements both.
- **Commits** are listed with SHA, author and message, not a diff stat (that would cost one API
  call per commit); the skill reads a diff with `git show <sha>`. `learn suggest` counts commits by
  other authors only; `pr-changes` adds the user's own commits after the recorded head.
- **`learn suggest --offer`** marks the PRs it returns as offered, since it is only called to
  offer them.
- **Measured performance** (Linux, 2,000 lessons): about 170 ms to build the index cold and 25 ms
  for a warm recall. The test asserts the 500 ms and 50 ms targets with headroom for parallel test
  runs and shared CI runners.
- **Gate 2 in sentinel's own repository** runs the bundle from the base branch checkout instead of
  downloading a release. Other repositories download the bundle from the **commit** the release
  tag points to, resolved by `setup --learn-verify` (a tag can be moved, a commit cannot); when
  the commit cannot be resolved it falls back to the tag and says so.
- **Gate 2 hardening** (from the review of the M10 PR): any changed path under
  `.sentinel/learnings` in any letter case, or `.sentinel` itself, counts as a lesson change; a
  lesson must be a regular file exactly under `.sentinel/learnings/`; and the check fails closed
  when the host lists fewer files than the PR changes (GitHub lists at most 3,000). The store
  also ignores a symlinked store directory or lesson file, so a planted lesson is never recalled.
