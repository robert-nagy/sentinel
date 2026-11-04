---
'@robert-nagy/sentinel': minor
---

Make issue trackers agent-native (ADR-0005): `issueProvider` now records intent only (`tracker`, `location`, `notes`, `labelMap`, `localDir`) and the agent reaches the tracker with its own MCP servers or CLIs. Add `sentinel issue resolve|detect|use|describe`, which decides deterministically which tracker to use (configured → the only reachable one that doesn't conflict with the git remote → ask → local fallback), and a built-in local Markdown tracker managed with `sentinel issue create|get|list|comment|label|close|reopen`. `sentinel issue duplicates` ranks candidate issues (listed by the agent, or from the local tracker) by title similarity. `sentinel pr create` now takes `--title` and no longer reads the issue. The built-in GitHub and custom issue providers, `issue link`, `issue describe-provider` and the `issueProvider.type`/`options` keys are removed.
