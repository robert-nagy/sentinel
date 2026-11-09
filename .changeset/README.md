# Changesets

Every user-facing change needs a changeset. Run `npm run changeset`, pick the
semver bump and describe the change; commit the generated file with your PR.

On merge to `main`, the Release workflow collects pending changesets into a
"chore: version packages" PR. Merging that PR tags `vX.Y.Z` and creates a GitHub
Release; nothing is published to npm (see `docs/adr/0006-marketplace-distribution.md`).
