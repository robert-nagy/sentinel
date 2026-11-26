---
'@robert-nagy/sentinel': minor
---

Add the `sentinel-review` skill: a stand-alone review of uncommitted work plus the branch's changes against its pull request's target branch (or the default branch when there is no pull request), or of staged work, a base ref or a given pull request, using the `sentinel-reviewer` sub-agent (or its checklist inline) and reporting findings without editing files. The reviewer now accepts an explicit scope, reviews uncommitted and untracked changes and compares against the pull request's target branch by default, and checks for logic errors and broken edge cases.
