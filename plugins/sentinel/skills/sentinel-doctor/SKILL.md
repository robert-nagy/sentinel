---
name: sentinel-doctor
description: Checks that sentinel can run in this repository (Node, git, gh, config). Use when the user asks whether sentinel is set up correctly or when a sentinel command fails unexpectedly.
---

# sentinel doctor

Placeholder skill that proves the bundled CLI runs from a plugin install. M3 replaces it with the
real workflow skills.

1. Run `node scripts/sentinel.mjs doctor --json` (the path is relative to this skill's folder).
2. Report each check that is not `pass`, with the `hint` it carries.
3. If `node` is missing or older than 22, stop and tell the user: sentinel needs Node.js 22 or newer.
