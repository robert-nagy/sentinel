---
'@robert-nagy/sentinel': patch
---

`sentinel worktree prune` now also asks GitHub whether a pull request from the branch was merged, so squash- and rebase-merged worktrees are cleaned up. If the code host is unavailable it warns and falls back to the local check.
