---
'@robert-nagy/sentinel': patch
---

`sentinel doctor` is faster and more robust: independent git and gh checks run concurrently, every external command is bounded to 10 s, and a timed-out command is reported as a warning instead of being mistaken for a failure (e.g. "not authenticated").
