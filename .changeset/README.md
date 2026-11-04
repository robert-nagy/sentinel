# Changesets

Every user-facing change needs a changeset. Run `npm run changeset`, pick the
semver bump and describe the change; commit the generated file with your PR.

On merge to `main`, the Release workflow collects pending changesets into a
"chore: version packages" PR. Merging that PR **stages** the new version on npm;
a maintainer then approves it with 2FA. See [docs/RELEASING.md](../docs/RELEASING.md).
