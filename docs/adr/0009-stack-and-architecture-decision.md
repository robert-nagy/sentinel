# ADR-0009: The stack and architecture are decided during setup and recorded

- **Status:** Accepted (implemented for issue #44)
- **Date:** 2026-11-27
- **Related:** [ADR-0002](0002-no-llm-calls.md) (sentinel never calls an LLM),
  [ADR-0003](0003-skills-as-canonical-workflows.md) (skills are the workflows),
  [RFC for issue #44](../rfcs/issue-44.md)

## Context

`sentinel setup` confirmed one ecosystem and the test tooling, and nothing else. The language and
frameworks per layer, the architecture and the folder layout were left to whichever pull request
first needed them. In a real project an unattended `sentinel-sdlc-auto` run chose JavaScript,
Fastify and a flat layout in its RFC. The user wanted C# with vertical slices around a pure domain
project, plus React and TypeScript, so the pull request had to be rebuilt, and nothing in the
repository said which architecture later work must follow.

## Decision

1. `sentinel-setup` decides the stack per layer, the architecture and the folder layout with the
   user, with a STOP after each: the agent proposes 2 to 3 named architectures with trade-offs
   tied to the domain answers and their level of domain-driven design (`none`, `tactical`,
   `strategic`), and the user picks.
2. sentinel checks the decision in code (`sentinel setup --architecture <file>`: layers, paths,
   lengths, secrets) and records it twice: `.sentinel/architecture.json`, which the CLI and the
   skills read, and an ADR under `docs/adr/` in the target repository for people, generated from
   the JSON. The JSON is the source; the ADR is rewritten from it with `--force`.
3. `--stack` and the decision can name several ecosystems with a folder each, and the generated
   workflows set up every toolchain.
4. `sentinel-sdlc` and `sentinel-sdlc-auto` read the decision (`sentinel architecture show`)
   before the RFC and name it, with every departure, in the RFC's "Stack and architecture"
   section. When nothing is recorded and an issue needs such a choice, both skills stop and ask.
   This is the one extra stop in the unattended skill: an unattended run never picks a stack or
   an architecture for the project.
5. The reviewer checks for architecture drift (category `architecture`).

## Consequences

- The agent does the proposing (ADR-0002 holds); sentinel only validates and records.
- Repositories set up earlier have no decision. They lose nothing: the first issue that needs a
  choice stops and asks, and re-running setup records it.
- Path-level drift is checked by the reviewer, not in code. A deterministic check that maps diff
  paths to folder purposes was rejected for now because it would give too many false positives.
