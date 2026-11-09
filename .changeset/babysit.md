---
'@robert-nagy/sentinel': minor
---

Add `sentinel babysit <pr> [--once]`: reads CI results through `gh`, parses failed logs (tsc, eslint, vitest/jest, pytest, go, dotnet, cargo, generic stack traces) into a failure packet with a stable signature, re-runs a suspected infrastructure failure once, hands real failures to the agent (exit 2), and gives up with a PR comment (exit 3) after the attempt budget, three fixes of the same failure, or the timeout.
