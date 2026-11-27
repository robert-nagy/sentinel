# PRD: Keep the generated sentinel.mjs bundle out of feature and bug PRs

> Slug: bundle-out-of-feature-prs | Created: 2026-11-27 | Issue: #45

## 1. Context & Problem Statement

sentinel ships its CLI as one generated file, `sentinel.mjs`, copied into each of the 10 skill folders under `plugins/sentinel/skills/*/scripts/` (ADR-0006, decision 5). Each copy is 1 179 039 bytes, about 31 000 lines. ADR-0006 decision 6 says feature PRs never touch the bundle and only the changesets "version packages" PR rebuilds it. But its Consequences section adds an exception: a PR whose skills name a new CLI command must rebuild the bundle in the same PR. The test `test/unit/skills.test.ts:106` ("only names CLI commands the committed bundle has") enforces that exception. It runs every command a skill names against the committed copy.

So every feature or bug PR that adds a CLI command and a skill step calling it rewrites all 10 copies. PR #41 (commit `c3de8e9`) is the measured example: 74 100 insertions and 20 409 deletions over 62 files. Only 5 467 insertions and 114 deletions were hand-written source, tests and docs. About 88 900 of the 94 500 changed lines (94%) were generated bundle.

That costs the people who work on sentinel on every such PR:

- Maintainers reviewing the PR scroll past or filter out tens of thousands of generated lines, and GitHub collapses or truncates the diff.
- The `sentinel-reviewer` sub-agent and the `sentinel-review` skill spend context window on the bundle.
- Any two open PRs that both rebuild the bundle conflict on all 10 files, so the second one to merge must rebuild again.

It needs solving now because milestone work (M10 and later) adds CLI commands in most PRs, so the cost repeats on almost every feature PR.

User stories, from issue #45:

- As a maintainer reviewing a feature or bug PR, I want the diff to hold only hand-written changes, so that I can review it without wading through regenerated copies of `sentinel.mjs`.
- As a contributor, I want to add a CLI command and the skill that uses it in one PR without rebuilding the bundle, so that my PR does not conflict with every other PR that touches the CLI.

The work has two parts: an investigation that compares options and records a decision (FR-1, FR-2), then applying the chosen option (FR-3 to FR-6).

Definitions used below:

- **Bundle**: the output of `npx tsup --config tsup.bundle.config.ts`, written to `dist-bundle/sentinel.mjs`, and its copies in the skill folders.
- **Committed bundle**: the copies tracked in git under `plugins/sentinel/skills/*/scripts/sentinel.mjs`.
- **Fresh bundle**: `dist-bundle/sentinel.mjs` built from the `src/` of the commit under test.
- **Feature PR**: any pull request to `main` other than the changesets version PR from branch `changeset-release/main`.
- **Version PR**: the PR titled `chore: version packages` that `.github/workflows/release.yml` opens from `changeset-release/main`.

Non-goals:

- Changing what the bundle contains or how tsup builds it.
- Shrinking the bundle itself (minification, dependency pruning). That may become a follow-up issue.
- Changing how users install the plugin (git clone from a marketplace, with no build step).

Background to read: issue #45; `docs/adr/0006-marketplace-distribution.md:59-68` and `:89-93`; `scripts/plugin-lib.js`; `scripts/build-plugin.js`; `.github/workflows/ci.yml`, `release.yml` and `sentinel-lessons.yml`; `.github/codeql/codeql-config.yml:6`.

## 2. Functional Requirements

### FR-1: Compare at least three options

The investigation writes a comparison of at least three ways to keep the committed bundle out of feature PRs. Each option is scored on 4 axes: lines of bundle diff in a feature PR, marketplace git installs, the release flow, and the trust boundary of `sentinel-lessons.yml`. Candidate options:

- **A. Check against a fresh build.** `test/unit/skills.test.ts` and the plugin-install E2E run the fresh bundle instead of the committed one. Only the version PR writes the committed copies.
- **B. Commit one copy.** Track a single bundle (for example `plugins/sentinel/scripts/sentinel.mjs`) and copy it into the skill folders at release. This needs a check that the host tools still load each skill folder on its own.
- **C. Bundle only on a release ref.** `main` carries no bundle. The release job commits it to a `release` branch or tag, and the marketplace manifests point there.

- Given the current setup described in section 1
- When the investigation is done
- Then `docs/adr/0009-bundle-out-of-feature-prs.md` (or the next free ADR number) holds a table with at least 3 options, each with a value for the 4 axes

### FR-2: Record one decision

The comparison names one recommended option and records it as a new ADR that amends ADR-0006 decision 6 and its Consequences.

- Given the FR-1 comparison
- When the ADR is merged
- Then it has status `Accepted`, names exactly one chosen option, and ADR-0006 links to it from decision 6

### FR-3: A feature PR that adds a command leaves the bundle alone

With the chosen option applied, a feature PR can add a CLI command under `src/` and a skill step that calls it with no change to any file named `sentinel.mjs`.

- Given `main` with the chosen option applied
- When a PR adds the command `sentinel example ping` under `src/` and a line `node scripts/sentinel.mjs example ping --json` to one `SKILL.md`, and changes no `sentinel.mjs`
- Then the CI jobs `quality`, `test` and `plugin-install` all finish with status `success`

### FR-4: Skills still cannot name a command that does not exist

The check behind `test/unit/skills.test.ts:106` keeps failing when a skill names a command that is absent from the bundle the check runs against.

- Given `main` with the chosen option applied
- When a PR adds `node scripts/sentinel.mjs nosuch command --json` to a `SKILL.md` and adds no such command to `src/`
- Then the `test` job fails, and its output names the skill and `sentinel nosuch command`

### FR-5: Feature PRs that touch the bundle are rejected

Once the bundle no longer has to change, CI blocks a feature PR that changes it, so the rule in ADR-0006 decision 6 is enforced instead of only documented.

- Given a feature PR whose diff against its base changes any path matching `plugins/sentinel/skills/*/scripts/sentinel.mjs`
- When CI runs the bundle guard step
- Then the step fails with the message `feature PRs must not change the generated bundle; the version PR rebuilds it (ADR-0006)` and lists each changed path
- Given the version PR from branch `changeset-release/main`
- When CI runs the bundle guard step
- Then the step passes even though the PR changes all 10 copies

### FR-6: Installs from the default branch still work after a release

After the version PR merges, a marketplace install from the default branch gets, in every skill folder, a bundle that has every command its `SKILL.md` names and that reports the released version.

- Given the version PR for version `X.Y.Z` has merged to `main`
- When `release.yml` runs `node scripts/build-plugin.js --verify-fresh` and the plugin-install E2E copies the plugin as a marketplace install would
- Then every skill's `scripts/sentinel.mjs` reports `X.Y.Z` from `--version`, every command its `SKILL.md` names exits 0 with `--help`, and the `vX.Y.Z` tag points at that commit

## 3. Non-Functional Requirements

- NFR-1: Diff size: in a feature PR made with the chosen option, 0% of changed lines are under `plugins/sentinel/skills/*/scripts/sentinel.mjs` (0 kB of bundle diff), compared with 94% in PR #41.
- NFR-2: CI duration: building the fresh bundle in CI adds at most 60 s to the wall-clock time of each `test` matrix job, measured as the median of 5 runs on `ubuntu-latest`.
- NFR-3: Install size: the plugin a marketplace install receives is at most 10 × 1.2 MB = 12 MB of bundle copies, so an install is no larger than it is today.
- NFR-4: Release lag: the committed bundle on `main` matches a fresh build of `src/` at every `vX.Y.Z` tag. `--verify-fresh` reports 0 problems on 100% of tagged commits.
- NFR-5: Platforms: the fresh-build check passes in 100% of the 6 `test` matrix jobs (`ubuntu-latest`, `macos-latest` and `windows-latest`, each on Node 22 and 24).

## 4. Security

Authentication: the work adds no user-facing service. GitHub Actions jobs authenticate with the workflow's `GITHUB_TOKEN`. No new secret or personal access token is introduced.

Authorisation (RBAC), per resource:

| Resource                                  | Who may write it                                                                   | Enforced by                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| Committed bundle copies                   | only the version PR from `changeset-release/main`, opened by `github-actions[bot]` | FR-5 guard step; a maintainer merges the PR |
| `main`                                    | maintainers, through a merged PR                                                   | branch protection (unchanged)               |
| `vX.Y.Z` tags and GitHub Releases         | `release.yml` with `contents: write`                                               | job permissions (unchanged)                 |
| `ci.yml` jobs that build the fresh bundle | read-only: `permissions: contents: read`                                           | workflow-level `permissions` block          |

Trust boundary: `sentinel-lessons.yml` runs on `pull_request_target` and executes the committed bundle from the base branch. It must keep doing so, and must never build or run code from the pull request, because that job holds a token that can read PRs on the base repository. Any option that has `sentinel-lessons.yml` build `src/` is rejected in FR-1.

Supply chain: users run the committed bundle without a build step, so it is code they trust from the repository. Only the version PR writes it, a maintainer reviews and merges that PR, and `--verify-fresh` checks before tagging that it equals a fresh build of `src/`. CodeQL keeps excluding the generated bundle (`.github/codeql/codeql-config.yml:6`) and keeps scanning `src/`, which the bundle is built from.

Input validation: the FR-5 guard reads the PR's changed paths from `git diff --name-only <base>...<head>` and matches them against the fixed glob `plugins/sentinel/skills/*/scripts/sentinel.mjs`. It decides whether a PR is the version PR only from `github.head_ref == 'changeset-release/main'` and `github.event.pull_request.head.repo.full_name == github.repository`, so a fork cannot get past the guard by naming its branch `changeset-release/main`. Neither value is put into a shell command without quoting. On a match the step exits 1 and prints the paths. It never prints file contents.

## 5. Data Models

- **BundleArtifact**: path (string, `dist-bundle/sentinel.mjs` or `plugins/sentinel/skills/<skill>/scripts/sentinel.mjs`), sha256 (64 hex characters), version (semver string reported by `--version`), sizeBytes (integer). Every committed copy has the same sha256 (checked by `checkConsistency`).
- **SkillCommandRef**: skill (directory name under `plugins/sentinel/skills/`), chain (array of command words, for example `["issue", "lint"]`), taken from `node scripts/sentinel.mjs <chain>` in `SKILL.md` by `commandChains()` in `test/unit/skills.test.ts`.
- **OptionAssessment** (in the ADR, FR-1): id (`A`, `B`, `C`, ...), summary (one sentence), bundleDiffLines (integer per feature PR), installImpact (one sentence), releaseImpact (one sentence), lessonsTrustImpact (one sentence), chosen (boolean, exactly one true).
- **GuardResult** (FR-5): pass (boolean), changedBundlePaths (array of strings), isVersionPr (boolean).

Relations: a SkillCommandRef is checked against exactly one BundleArtifact. With option A that is the fresh bundle. A release has one version and 10 committed BundleArtifacts with that version.

## 6. API Contracts

These are command-line and CI contracts. The work adds no network API.

| Interface                                            | Input                                                 | Success                                                                                         | Failure                                                                                     | Status                                            |
| ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `node scripts/build-plugin.js`                       | none                                                  | rebuilds the bundle, copies it into every skill, stamps versions; exit 0, prints `plugin built` | tsup error, exit 1                                                                          | unchanged; run only by `npm run version-packages` |
| `node scripts/build-plugin.js --check`               | none                                                  | committed plugin is internally consistent; exit 0, prints `plugin is consistent`                | exit 1, one `- <problem>` line per problem on stderr                                        | unchanged                                         |
| `node scripts/build-plugin.js --verify-fresh`        | none                                                  | committed bundle equals a fresh build; exit 0, prints `plugin bundle is fresh`                  | exit 1 with problems                                                                        | unchanged; runs in `release.yml` before tagging   |
| `node scripts/build-plugin.js --bundle-only`         | none                                                  | builds `dist-bundle/sentinel.mjs`, touches no tracked file; exit 0, prints the path             | exit 1 with the tsup error                                                                  | new, option A                                     |
| `node scripts/build-plugin.js --guard-pr <base-sha>` | a 40-character commit SHA                             | no bundle path changed since `<base-sha>`; exit 0                                               | exit 1 with the FR-5 message and the changed paths; a malformed SHA or unknown flag exits 2 | new, FR-5, any option                             |
| `SENTINEL_BUNDLE` environment variable               | absolute path; unset means `dist-bundle/sentinel.mjs` | `test/unit/skills.test.ts` and `test/e2e/plugin-install.test.ts` run that bundle                | the test fails with `bundle not found: <path>`                                              | new, option A                                     |
| CI job `quality`, step `Bundle guard`                | `github.event.pull_request.base.sha`                  | runs `--guard-pr` on `pull_request` events; skipped for the version PR as defined in section 4  | the job fails                                                                               | new, FR-5, any option                             |

If the ADR picks option B or C instead, it replaces the two option-A rows above with that option's contract in the same format. FR-3 to FR-6 stay as written.

## 7. Test Strategy Matrix

| Tier        | Scope                                                                                                                                                      | Tooling                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Unit        | `--guard-pr` path matching: 0, 1 and 10 changed bundle paths; the version PR exemption; a fork named `changeset-release/main`; unknown flags exit 2 (FR-5) | Vitest, `test/unit/plugin.test.js`     |
| Unit        | skill command check runs against `SENTINEL_BUNDLE` or `dist-bundle/sentinel.mjs`; a missing command fails with the skill name (FR-4)                       | Vitest, `test/unit/skills.test.ts`     |
| Integration | a fixture commit that adds a command and a skill line with no bundle change passes `npm test` (FR-3); `--verify-fresh` fails when a copy is stale (FR-6)   | Vitest with a temporary git repository |
| E2E         | plugin-install E2E copies the plugin as a marketplace install would and runs every skill's named commands, on 3 operating systems (FR-3, FR-6, NFR-5)      | Vitest E2E, Claude Code CLI 2.1.332    |
| E2E         | dry run of the release flow on a fork: version PR rebuilds all 10 copies, guard passes for it, tag points at a fresh bundle (FR-5, FR-6, NFR-4)            | GitHub Actions on a fork               |
| Load        | fresh-bundle build time in the `test` job, median of 5 runs, at most 60 s added (NFR-2)                                                                    | GitHub Actions job timings             |
