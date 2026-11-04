# ADR-0005: Release through npm staged publishing

- **Status:** Accepted
- **Date:** 2026-11-04
- **Supersedes:** the publish step described in the M0 plan (`changeset publish` from CI)

## Context

Releases were published straight from GitHub Actions with npm trusted publishing (OIDC). That
removes long-lived tokens, but anything that can run in the publish workflow can still ship a
release: a compromised dependency, a malicious change that gets merged, or a hijacked workflow.
sentinel writes instructions and configuration into people's AI coding tools, so a malicious
release would be unusually harmful.

npm's [staged publishing](https://docs.npmjs.com/staged-publishing) adds a human step: CI runs
`npm stage publish`, the package waits in a queue and is not installable, and a maintainer
approves it with 2FA. npm recommends pairing it with a trusted publisher limited to staging.

## Decision

- CI stages releases (`npm stage publish`); a maintainer approves each one with 2FA.
- The npm trusted publisher is moved to "Allow npm stage publish" only, once a staged release has
  worked end to end.
- Staging is decided from git, not from npm: trusted-publishing tokens cannot run
  `npm stage list`, so CI stages only when the version in `package.json` changed in the push (or
  on a manual run).
- Tags and GitHub releases are created by a separate job after the version is live on npm, since
  approval happens outside GitHub.
- `changesets/action` is kept only for the version PR; its `publish` command is not used.

## Consequences

- Every release needs about a minute of human attention. Releases are infrequent, so this is
  acceptable.
- A compromised workflow can stage a package but cannot make it installable.
- The release is no longer one click: tags and GitHub releases appear after approval (within 6
  hours, or on a manual run).
- Open point: npm's docs don't say whether staged versions keep provenance attestations. To be
  verified on the first release (see docs/RELEASING.md).
- The workflow depends on npm 11.15 or newer and Node 22.14 or newer.
