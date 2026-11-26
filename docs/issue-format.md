# Issue format

The format `sentinel-intake` writes and `sentinel issue lint` checks ([ADR-0007](adr/0007-issue-intake-format.md)).
It is meant to be read by people and to be the input `sentinel-prd` and `sentinel-sdlc` start from.

There are two kinds, **feature** and **bug**. The body is Markdown with fixed `##` headings, in
the order below. Leave optional sections out when there is nothing to say; never write "N/A".

## Metadata (labels, not body text)

| Neutral label                                                           | Set by                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| `kind/feature`, `kind/bug`                                              | the kind                                       |
| `kind/chore`, `kind/refactor`                                           | added to a feature for work with no user story |
| `priority/critical`, `priority/high`, `priority/medium`, `priority/low` | proposed by the agent, confirmed by the user   |

Labels go through `issueProvider.labelMap` to the tracker's own label, issue type or priority
(for example Jira's _Highest_, _High_, _Medium_, _Low_, or Linear's _Urgent_, _High_, _Medium_,
_Low_). The local tracker keeps them in front matter.

| Priority   | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `critical` | Outage, data loss or security hole, with no workaround; drop other work |
| `high`     | Many users blocked, or a committed deadline; only a poor workaround     |
| `medium`   | A real cost, but a workaround exists; the default when unsure           |
| `low`      | Nice to have; no one is blocked                                         |

The agent proposes a priority from Problem (features) or Impact and Frequency (bugs), gives a
one-line reason, and the user confirms or changes it at the approval stop.

## Feature

**Title:** an imperative verb and an object, at most 72 characters. Example: `Export invoices as CSV`.

| Section                  | Required | Content                                                                                    |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `## Problem`             | yes      | Who is affected, what they cannot do today, what it costs them.                            |
| `## User story`          | yes      | One or more `As a <role>, I want <capability>, so that <benefit>.`                         |
| `## Acceptance criteria` | yes      | Checklist of `AC-n: Given <state>, when <action>, then <observable result>.`, at least one |
| `## Out of scope`        | no       | Bullets of what this issue will not do.                                                    |
| `## Constraints`         | no       | Performance, security, compatibility, data or deadline limits, with numbers and units.     |
| `## Context`             | no       | Links, related issues, code pointers (`path:line`), prior art.                             |
| `## Attachments`         | no       | See [Attachments](#attachments).                                                           |

```md
## Problem

Accountants export invoices by copying rows from the table into a spreadsheet, about 40 minutes
at each month-end close, and rows get missed.

## User story

As an accountant, I want to export a month's invoices as CSV, so that I can import them into
the ledger without retyping.

## Acceptance criteria

- [ ] AC-1: Given 120 invoices dated in March, when I export March, then the CSV has 120 rows
      and the header `number,date,customer,net,vat,gross`.
- [ ] AC-2: Given a user without the `billing:read` role, when they request an export, then
      the server returns 403 and no file.

## Out of scope

- PDF export.

## Constraints

- An export of 10 000 invoices finishes in under 5 s.
```

## Bug

**Title:** `<component>: <symptom>`, at most 72 characters. Example: `checkout: total ignores discount code`.

| Section                  | Required | Content                                                                                |
| ------------------------ | -------- | -------------------------------------------------------------------------------------- |
| `## Summary`             | yes      | One or two sentences: what breaks, and for whom.                                       |
| `## Steps to reproduce`  | yes      | Numbered steps a stranger can repeat from a clean start.                               |
| `## Expected`            | yes      | What should happen, specifically.                                                      |
| `## Actual`              | yes      | What happens; error text verbatim, in a code block.                                    |
| `## Environment`         | yes      | Version or commit, OS, runtime, browser, relevant config.                              |
| `## Frequency`           | no       | `always`, `intermittent (n of m tries)` or `once`.                                     |
| `## Impact`              | no       | Who and how many are affected; the workaround, if any.                                 |
| `## Suspected cause`     | no       | Code pointers the agent found while investigating. Marked as a guess.                  |
| `## Acceptance criteria` | yes      | At least `AC-1`, built from the steps and Expected, so the fix gets a regression test. |
| `## Attachments`         | no       | See [Attachments](#attachments).                                                       |

The agent asks for Frequency and Impact when it needs them to propose a priority.

## Attachments

Each attachment is one bullet: the file name, what it shows, and how it was attached.

```md
## Attachments

- `checkout-error.png`: the total after applying `SPRING10` (uploaded)
- `server.log`: request trace for the failing order (inline, below)
- `recording.mp4`: the steps above, 40 s (pending upload)

<details><summary>server.log (lines 1–80 and 921–1000 of 1000)</summary>

…
</details>
```

`sentinel issue attachments <files…> --json` decides how each file is attached:

| File                                          | Handling                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Text, up to 200 lines                         | inlined in a `<details>` block                                           |
| Text, longer                                  | inlined, first and last 80 lines, with a marker for the cut              |
| Text containing a secret pattern              | **blocked** until the user redacts it                                    |
| Image, video or other binary                  | `attach` with the tracker's tool if it can upload; else _pending upload_ |
| Over the size cap (10 MB images, 25 MB other) | rejected, with the reason                                                |

For _pending upload_ files the agent tells the user, after filing, exactly which files to drag
into the issue (GitHub has no upload API). The local tracker stores files under
`<localDir>/attachments/<id>/` and links them by relative path.

## Lint rules

`sentinel issue lint <file> --kind feature|bug [--title <title>] --json` exits 0 when the issue may
be filed, 2 with a list of problems otherwise. The file is the body; the title comes from `--title`,
or from a first line `# <title>` when `--title` is left out. Issues opened through the GitHub issue
forms render each field as a `###` heading and do not pass as they are: `sentinel-intake` can
rewrite them into the format. The checks:

- the title matches the kind's rule and is at most 72 characters;
- every required section is present, in order, and not empty;
- no unknown, duplicated or empty sections, and no text before the first heading;
- every acceptance criterion has `AC-n:` (numbered from 1, in order) and Given, when and then;
- every user story reads `As a …, I want …, so that ….`; bug steps are a numbered list; Frequency
  is one of the three forms;
- no template hint comment, no placeholder (`TODO`, `TBD`, `N/A`, `<role>`) and no term from the PRD ambiguity list ("fast",
  "user-friendly", "etc." …);
- no secret pattern anywhere in the body, including inlined attachments;
- inlined text respects the limits above.

## How `sentinel-prd` uses an issue

| Issue section        | PRD section                                                            |
| -------------------- | ---------------------------------------------------------------------- |
| Problem, User story  | 1. Context & Problem Statement                                         |
| Acceptance criteria  | 2. Functional Requirements (one `FR-n` each, its Given/When/Then kept) |
| Constraints          | 3. Non-Functional Requirements, 4. Security                            |
| Out of scope         | 1. Context (non-goals)                                                 |
| Context, Attachments | read for background; linked from the PRD                               |
