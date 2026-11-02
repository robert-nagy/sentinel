# Changesets

Every user-facing change needs a changeset. Run `npm run changeset`, pick the
semver bump and describe the change; commit the generated file with your PR.

On merge to `main`, the Release workflow collects pending changesets into a
"chore: version packages" PR. Merging that PR publishes to npm with provenance.
