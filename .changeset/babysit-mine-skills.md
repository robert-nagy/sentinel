---
'@robert-nagy/sentinel': minor
---

Add the `sentinel-babysit` and `sentinel-mine` skills. `sentinel-babysit` drives `sentinel babysit` until CI is green or sentinel gives up; `sentinel-mine` writes a feature-gap list and files only the gaps a human approves. `sentinel-sdlc` and `sentinel-sdlc-auto` now hand the pull request to the babysit loop instead of leaving CI to the user.
