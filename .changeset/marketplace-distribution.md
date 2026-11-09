---
'@robert-nagy/sentinel': patch
---

Stop publishing to npm (ADR-0006): the package is now private, the release workflow tags `vX.Y.Z` and creates a GitHub Release instead of running `npm publish`, and CI smoke-tests the built CLI directly instead of an installed tarball. sentinel will be distributed as a plugin marketplace from this repository.
