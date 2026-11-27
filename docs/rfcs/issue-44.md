# RFC: Decide the tech stack, architecture and folder layout during setup

> Issue: #44 | Created: 2026-11-27 | Status: Implemented (unattended run, `sentinel-sdlc-auto`)

## Summary

`sentinel-setup` gains a decision step after the domain interview: the stack per layer (backend,
frontend, database and so on), a named architecture picked from 2 to 3 proposals with their
trade-offs, and the top-level folder layout, each confirmed by the user at a STOP. sentinel checks
the decision in code and records it twice in the target repository: `.sentinel/architecture.json`
(read by the CLI, the SDLC skills and the reviewer) and an ADR,
`docs/adr/NNNN-stack-and-architecture.md`, for people. `--stack` accepts several ecosystems with
paths, so a .NET backend plus a Node frontend gets both toolchains in the generated workflows. The
SDLC skills read the decision before the RFC, name it in a new RFC section, and stop to ask when
an issue needs a stack or architecture choice that is not recorded, also in the unattended skill.

## Motivation

Issue #44. In tape-craft, setup confirmed only `node`. The first feature issue left the language
and framework to its pull request, and an unattended run picked JavaScript, Fastify and a flat
layout in its RFC, with no approval step. The user wanted C#/ASP.NET Core with vertical slices
around a pure domain project, plus React/TypeScript. A whole feature PR had to be rebuilt, and
nothing in the repository says which architecture later work must follow. Without this change,
every unattended first feature keeps making the project's biggest decisions alone.

## Detailed design

### The decision file (`src/core/architecture.ts`, new)

`ARCHITECTURE_FILE = '.sentinel/architecture.json'`, validated with zod (`decisionSchema`):

```json
{
  "version": 1,
  "decidedAt": "2026-11-27T12:00:00.000Z",
  "adr": "docs/adr/0001-stack-and-architecture.md",
  "layers": [
    {
      "name": "backend",
      "path": "src/backend",
      "ecosystem": "dotnet",
      "language": "C#",
      "frameworks": ["ASP.NET Core"]
    },
    {
      "name": "frontend",
      "path": "src/web",
      "ecosystem": "node",
      "language": "TypeScript",
      "frameworks": ["React", "Vite"]
    },
    { "name": "database", "language": "SQL", "frameworks": ["PostgreSQL"] }
  ],
  "architecture": {
    "style": "Vertical slices around a pure domain project",
    "ddd": "tactical",
    "principles": ["SOLID"],
    "rationale": "One small team; features ship end to end; the domain stays free of I/O."
  },
  "alternatives": [
    { "style": "Clean Architecture", "reason": "More layers and mapping than a team of 2 needs." }
  ],
  "folders": [
    { "path": "src/backend/Domain", "purpose": "Entities and rules, no I/O" },
    { "path": "src/backend/Features", "purpose": "One folder per vertical slice" }
  ]
}
```

- `layers`: 1–10. `name` is a short lower-case slug, unique. `ecosystem` is optional (a database
  layer has none) and one of `ECOSYSTEMS`; `path` is optional, relative, without `..`, and
  required when `ecosystem` is set and more than one layer has one (the workflows need a
  working directory per project). `frameworks`: 0–10 names.
- `architecture.ddd`: `none | tactical | strategic` (tactical = entities, value objects and
  aggregates in code; strategic = also bounded contexts as modules). `principles`: 0–10.
  `rationale` is required: it is what the reviewer and the next RFC read.
- `alternatives`: 1–4, the proposals the user did not pick and why, so AC-2's trade-offs are kept.
- `folders`: 1–40 relative paths with a purpose, unique.
- Text fields are capped (style 120, rationale and reasons 600, purpose 200), single-line where it
  matters, and scanned with `findSecrets`; `sentinel:managed` markers are rejected.

The skill writes the decision without `version`, `decidedAt` and `adr`; sentinel adds them.

Functions: `validateDecision(json)` (returns problems like `issue lint` does),
`parseDecision(text)`, `renderDecisionAdr(decision, number, date)`, `adrPath(names)` (reuses the
number of an existing `*-stack-and-architecture.md`, otherwise the next free `NNNN` in
`docs/adr/`), `plannedProjects(decision)` (one `plannedProject` per layer with an ecosystem, at
its `path`), and `formatDecision(decision)` for plain output.

### CLI

- `sentinel setup --architecture <file>`: validate the file (exit 2 with `problems` when it is
  invalid), then write `.sentinel/architecture.json` and the ADR. Refuses to overwrite either
  without `--force`; honours `--dry-run`. Combines with `--workflows` and `--readme` in one call.
- `sentinel setup --stack <list>`: `<ecosystem>[:<path>]` separated by commas, for example
  `dotnet:src/backend,node:src/web`. One bare ecosystem still means the root (`node`). Unknown
  ecosystems, duplicate paths, absolute or `..` paths are rejected.
- In an empty repository without `--stack`, the planned projects come from the recorded decision's
  layers, so the workflows follow the decision.
- Every `setup --json` result gains `architecture: { path, recorded, adr }`; the plain output
  prints a line for it.
- `sentinel architecture show [--json]` (new `src/cli/architecture.ts`): prints the decision.
  Exit 0 when recorded, exit 2 (`Refine`) with `{ recorded: false }` when not, exit 5 (`Config`)
  when the file is invalid. The SDLC skills call it before the RFC.
- `renderReadme` takes the decision: a "Stack and architecture" section (style, DDD, principles,
  a layer list, link to the ADR) and, before any code exists, a containers diagram from the
  layers instead of the generic "Application" box.

### Skills, agents and templates

- `sentinel-setup`: "Confirm the stack" becomes "Decide the stack and architecture": (1) the stack
  per layer the domain needs, STOP; (2) 2 to 3 named architectures with trade-offs tied to the
  domain answers (scale, team size, complexity) and the DDD level of each, STOP; (3) the folder
  layout, STOP; (4) write the decision file and run `setup --architecture`. With existing code
  it shows the detected projects and layout and asks to confirm or correct (AC-5). With a
  recorded decision it asks whether it still holds.
- `sentinel-sdlc` and `sentinel-sdlc-auto`: before the RFC, `architecture show --json`. When no
  decision is recorded and the issue needs a language, framework, architecture or new top-level
  folder choice, STOP and ask (suggest `sentinel-setup`), also in the unattended skill; the
  "Decisions" section is identical in both and tested so.
- RFC template: a new "Stack and architecture" section that names the recorded decision and every
  departure (AC-6).
- `sentinel-reviewer` and `sentinel-review`: an "architecture drift" check against the decision.

## API changes

- New option `setup --architecture <file>`; `setup --stack` accepts a list (a single ecosystem
  still works unchanged).
- New command `sentinel architecture show`.
- `setup --json` gains the `architecture` field (additive).
- Library exports: `ARCHITECTURE_FILE`, `validateDecision`, `parseDecision`, `renderDecisionAdr`,
  `plannedProjects`, types `ArchitectureDecision`, `Layer`.

## Data changes

New committed file `.sentinel/architecture.json` and a new ADR in target repositories, both
written only on `setup --architecture`. No migration: repositories set up earlier have neither,
and the SDLC skills ask when an issue needs the decision.

## Test plan

- Unit: `test/unit/architecture.test.ts` (validation problems, secrets, path rules, ADR numbering
  and rendering, planned projects); `setup-cli.test.ts` (`--architecture` writes both files,
  refuses overwrite, `--dry-run`, invalid exit 2, multi-`--stack`, workflows from the decision
  with both toolchains, `architecture` in `--questions`); `architecture-cli.test.ts` (`show` exit
  0/2/5); `setup-templates.test.ts` (README section and diagram); `skills.test.ts` (Decisions
  section identical in both SDLC skills, setup STOPs, RFC template section).
- Integration: the CLI tests above run the real command tree against a temporary repository.
- E2E: `test/e2e/cli.test.ts` runs the built CLI: `setup --architecture` then `architecture show`.

## Rollout and rollback

Ships in the next minor release with a changeset. Everything is additive; to roll back, revert the
PR. Repositories that recorded a decision keep two inert files.

## Risks and alternatives

- **Only `domain.json`.** Rejected: the domain file holds interview answers keyed by question id;
  a structured decision with layers and folders would not fit, and people read ADRs, not JSON.
- **Only an ADR.** Rejected: the CLI and reviewer would have to parse Markdown.
- **Domain questions for the stack.** Rejected: the socratic engine asks free-text questions; the
  stack needs proposals and trade-offs from the agent (ADR-0002: sentinel never calls an LLM), so
  the skill proposes and sentinel validates and records.
- **A deterministic `architecture check` of diff paths.** Deferred: matching paths to folder
  purposes has many false positives; the reviewer checks drift with the decision in hand.
- Risk: the decision drifts as the project evolves. The RFC section makes departures explicit, and
  re-running setup with `--architecture --force` records a new decision and rewrites the ADR.

## Open questions

None.

## Approval

- [ ] Design reviewed and approved. Implementation does not start until this is checked.
