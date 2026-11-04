---
'@robert-nagy/sentinel': minor
---

Add the issue tracker layer and code host: `sentinel issue get|list|create|comment|link|duplicates|describe-provider` (GitHub Issues via `gh`, or any tracker through the `custom` provider's command templates), and `sentinel pr create --issue <id>` (GitHub). `sentinel worktree prune` now also consults the code host for merged pull requests. Provider and authentication failures exit with code 4.
