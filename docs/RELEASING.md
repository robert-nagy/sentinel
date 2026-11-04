# Releasing

sentinel uses [changesets](https://github.com/changesets/changesets) for versioning and
[npm staged publishing](https://docs.npmjs.com/staged-publishing) for releases. CI never
publishes on its own: it **stages** a version, and a maintainer **approves** it with 2FA.
See [ADR-0005](adr/0005-staged-publishing.md) for why.

## The flow

```
PR with a changeset ──merge──▶ "chore: version packages" PR (opened by CI)
                                     │ merge
                                     ▼
                     CI stages @robert-nagy/sentinel@X.Y.Z on npm   (not installable yet)
                                     │ maintainer approves with 2FA
                                     ▼
                     version is live on npm
                                     │ next scheduled or manual run
                                     ▼
                     CI creates tag vX.Y.Z and the GitHub release
```

1. **Add a changeset** to every user-facing PR: `npm run changeset`.
2. **Merge the "chore: version packages" PR** that CI keeps up to date. This bumps `package.json`
   and `CHANGELOG.md`.
3. **CI stages the version** (`scripts/stage-release.js`, `npm stage publish --provenance`). The
   run's summary says what was staged. CI stages only when the version in `package.json` changed
   in the push, so pushes made while a version waits for approval don't stage it again.
4. **Approve it.** Either:
   - npmjs.com → the package → **Staged Packages** → **Approve**, or
   - in a terminal with npm 11.15 or newer: `npm stage list`, then `npm stage approve <stage-id>`.

   Both ask for 2FA. To review first: `npm stage view <stage-id>` or
   `npm stage download <stage-id>` (the tarball CI built).

5. **Tag and GitHub release.** After approval, the next run of the workflow notices the version
   is live and creates `vX.Y.Z` and a GitHub release (notes from `CHANGELOG.md`). Runs happen
   every 6 hours, or immediately via Actions → Release → **Run workflow**.

### Rejecting or retrying

- Reject a staged version you don't want: `npm stage reject <stage-id>` (2FA) or the **Staged
  Packages** tab. A rejected version can be staged again.
- If staging failed (for example a permissions error), fix the cause and run Actions → Release →
  **Run workflow**. A manual run always attempts to stage, unless the version is already live.
- A version that is already staged cannot be staged again: approve or reject it first.

## One-time setup

1. **Trusted publisher** (npmjs.com → package → Settings → Trusted Publisher): GitHub Actions,
   user `robert-nagy`, repository `sentinel`, workflow filename **`publish.yml`**, environment empty.
   Tick **Allow npm stage publish**. Once a staged release has worked end to end, untick
   **Allow npm publish** so CI can no longer publish directly.
2. **Package access** (same page): "Require two-factor authentication and disallow tokens".
3. **Repository variable** `SENTINEL_RELEASE_ENABLED=true`
   (Settings → Secrets and variables → Actions → Variables).
4. **Repository setting**: Settings → Actions → General → Workflow permissions → allow GitHub
   Actions to create and approve pull requests (needed for the version PR).

No npm token is stored anywhere; CI authenticates with GitHub's OIDC identity.

## Why the workflow is shaped this way

- npm's short-lived trusted-publishing tokens can run `npm stage publish` but not `npm stage list`,
  so CI cannot ask npm what is already staged. It decides from git instead (did the version change
  in this push?).
- Approval happens outside GitHub, so no GitHub event announces it. The tag job polls npm
  (`npm view`) and acts once the version is live.
- changesets' own `publish` command calls plain `npm publish`, so the workflow uses
  `changesets/action` only to open the version PR.

## Checking provenance after the first staged release

npm's documentation does not say whether a staged version keeps its provenance attestation. After
the first approval, confirm the package page shows the "built and signed on GitHub Actions"
provenance badge, or run `npm audit signatures` in a project that installs it. If it is missing,
open an issue: releases would still be safe, but unattested.

## Local scripts

`scripts/release-utils.js` holds the pure decision logic (tested in
`test/unit/release-utils.test.js`). `scripts/stage-release.js` and `scripts/tag-release.js` are the
CI entry points.
