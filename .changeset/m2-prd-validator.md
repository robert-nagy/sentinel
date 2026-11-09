---
'@robert-nagy/sentinel': minor
---

Add the PRD quality loop: `sentinel prd validate <file> [--scores scores.json]` checks structure (context, FR-n with Given/When/Then, measurable NFRs, security, data models, API contracts, test matrix) and ambiguity, caps each score dimension at what the structure supports, and decides accept / refine / escalate (mean ≥ 85, each dimension ≥ 70, three refinements). Iteration state is kept per PRD; `sentinel prd status <slug>` shows it. Exit codes: 0 accept, 2 refine, 3 escalate.
