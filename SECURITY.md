# Security policy

## Supported versions

sentinel is pre-0.1.0. Security fixes go to the latest release and to `main`; older releases are
not patched.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
[Report a vulnerability](https://github.com/robert-nagy/sentinel/security/advisories/new)
(the repository's **Security** tab, then **Report a vulnerability**).

Include what you found, how to reproduce it, the affected version or commit, and the impact you
expect. You can expect an acknowledgement within a few days and a status update as the report is
triaged. Fixes are released with a GitHub Release and credited in the advisory unless you prefer
otherwise.

## Scope

In scope:

- The sentinel CLI and the bundled `scripts/sentinel.mjs` (for example command or path injection
  through arguments, unsafe file writes outside the repository, or leaking secrets into output or
  state files).
- The skills, the reviewer sub-agent and the guardrail rules, where a flaw would let an agent
  bypass a guardrail (pushing to the default branch, force-pushing, merging).
- The release workflows and the committed bundle (for example a bundle that does not match the
  source it claims to be built from).

Out of scope:

- Vulnerabilities in the AI tools that host the plugin, in `gh`, in git, or in your issue tracker;
  report those to their maintainers.
- Behaviour of a model you chose to run, including prompt-injection content you feed it. sentinel
  adds guardrails and checks but does not control the model.
- Findings that need an attacker who already controls your machine or repository.

sentinel does not call a model, hold tracker credentials or send data to a service of its own. It
runs `git` and `gh` with the permissions of the user who runs it.
