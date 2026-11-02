# @robert-nagy/sentinel

## 0.1.0

### Minor Changes

- 8b14b1c: Project foundation: TypeScript CLI skeleton with `sentinel --version` and `sentinel doctor` (Node.js, git, git repository, GitHub CLI and auth, Windows `core.longpaths` checks; `--json` output).

### Patch Changes

- 496cc63: `sentinel doctor` is faster and more robust: independent git and gh checks run concurrently, every external command is bounded to 10 s, and a timed-out command is reported as a warning instead of being mistaken for a failure (e.g. "not authenticated").
