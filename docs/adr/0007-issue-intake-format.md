# ADR-0007: A standard issue format, written by an intake interview and checked in code

- **Status:** Accepted (planned; implemented in M9)
- **Date:** 2026-11-26
- **Related:** [ADR-0002](0002-no-llm-calls.md) (sentinel never calls an LLM),
  [ADR-0005](0005-agent-native-issue-trackers.md) (trackers reached through the agent's tools)

## Context

`sentinel-prd` and `sentinel-sdlc` start from an issue, but nothing shapes what goes into one.
Issues arrive as free text: features without a stated problem or a testable outcome, bugs without
steps to reproduce or an environment. The PRD agent then has to guess, or ask the same questions
the reporter could have answered at filing time.

Research on 2026-11-26:

- **Community intake skills.** Several Claude Code skills already interview the user and run
  `gh issue create` (for example _pluginslab/issue_ and _issue-interview_). They are tied to
  GitHub and have no fixed body format, so the next agent cannot rely on any section existing.
- **Spec-driven toolkits.** GitHub Spec Kit writes specs as prioritised user stories with
  Given/When/Then acceptance scenarios. BMAD-Method stories use "As a / I want / So that" plus
  testable acceptance criteria, and are the developer agent's only input.
- **Bug reports.** Bugzilla/Jira templates and the incident report of ISO/IEC/IEEE 29119-3 agree
  on a core: summary, steps to reproduce, expected result, actual result, environment, plus
  frequency, impact and attachments.
- **No single standard.** No body like an RFC or ISO standard defines an issue format. The
  closest things to a shared standard are the Connextra user story, Gherkin Given/When/Then and
  the defect-report fields above, which most trackers' templates already use.
- **Attachments.** GitHub has no public API for issue attachments: uploads go through the web
  UI only (10 MB for images, 25 MB for other files), and `gh` cannot upload. Jira, Linear and
  the local tracker can store files through their own tools.

## Decision

1. **Reuse the widely used conventions; do not invent a new format.** A _feature_ is a problem
   statement, a Connextra user story and Gherkin acceptance criteria. A _bug_ is the classic
   defect report. Only two kinds: chores and refactors are filed as features with a
   `kind/chore` or `kind/refactor` label. The full format is in
   [docs/issue-format.md](../issue-format.md).
2. **Markdown body with fixed `##` headings.** It renders on every tracker and survives
   format conversion by connectors. Kind and priority are labels mapped through `labelMap`, not
   body text. Optional sections are left out when empty, so bodies stay short.
3. **One definition, enforced in code.** `src/core/issue-format.ts` defines the sections per
   kind. It drives `sentinel issue template <kind>`, `sentinel issue lint <file>` and the GitHub
   issue forms that `sentinel-setup` writes. The skill cannot file an issue that fails lint
   (exit 2); there is no scoring loop, because PRDs are scored later anyway.
4. **A new skill, `sentinel-intake`, does the interview.** It starts from what the user wrote,
   asks only about missing or vague sections, one question at a time with a suggested answer,
   and reads the codebase instead of asking when it can. It checks for duplicates, shows the
   final issue and **stops for approval** before `create`. It can also take an existing issue
   id and rewrite it to the format (`update`), posting the original body as a comment so
   nothing is lost.
5. **Attachments: tracker-native, otherwise inline or a manual step.**
   `sentinel issue attachments <files…>` decides per file, deterministically: small text files
   (logs, configs, stack traces) are inlined in collapsed blocks, trimmed to head and tail if
   long; images and binaries are uploaded with the tracker's own tool when it can upload;
   otherwise they are listed as _pending upload_ and the user drags them into the issue once.
   Text with secrets blocks filing until redacted. The local tracker stores files next to the
   issue.
6. **`sentinel-prd` reads the sections.** It maps them onto the PRD (problem → Context,
   acceptance criteria → `FR-n` scenarios, constraints → NFRs and Security) instead of starting
   from free text.

## Consequences

- Every issue filed by sentinel has the same sections, so `sentinel-prd` and `sentinel-sdlc`
  can rely on them, and human readers know where to look.
- Two new neutral tracker verbs: `update` (replace an issue's title or body) and `attach`
  (store a file on an issue). Skills still never hard-code a tracker's CLI or API.
- Attachments to GitHub need one manual step from the user until GitHub offers an upload API.
  This is said up front, not hidden.
- Issues filed outside sentinel (by hand, by other tools) are not forced into the format;
  `sentinel-intake` can convert them on request, and GitHub issue forms help reporters who use
  the browser.
- The format is a contract between skills. Changing a heading is a breaking change for
  `sentinel-prd` and the issue forms, and needs a changeset.

## Sources

- GitHub Docs, _Syntax for issue forms_ and _Attaching files_ (docs.github.com).
- GitHub Spec Kit templates (github.com/github/spec-kit).
- BMAD-Method story template and story-draft checklist (bmad-method on npm).
- Atlassian, _Bug report template_; TechTarget, _What details to include on a software defect
  report_.
- ISO/IEC/IEEE 29119-3, _Software testing — Test documentation_ (incident report).
