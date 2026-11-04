/** Technical design document written before any code for an issue. */
export const RFC_TEMPLATE = `# RFC: {{TITLE}}

> Issue: {{ISSUE}} | Created: {{DATE}} | Status: Draft

## Summary

TODO: One paragraph: what changes and why.

## Motivation

TODO: The problem, the issue it comes from, and what happens if nothing changes.

## Detailed design

TODO: Architecture and component changes. Name the files, modules and boundaries involved.

## API changes

TODO: New or changed endpoints, commands, types and their compatibility impact. Write "None" if there are none.

## Data changes

TODO: New or changed entities, migrations and backfills. Write "None" if there are none.

## Test plan

- Unit: TODO
- Integration: TODO
- E2E: TODO

## Rollout and rollback

TODO: How it ships (flags, phases) and how to undo it.

## Risks and alternatives

TODO: What could go wrong, and the alternatives that were rejected with the reason.

## Open questions

TODO: Anything that needs an answer before implementation starts.

## Approval

- [ ] Design reviewed and approved. Implementation does not start until this is checked.
`;
