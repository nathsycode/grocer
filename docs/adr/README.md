# Architecture decision records

Use ADRs for consequential architecture choices and trade-offs. The bootstrap established this convention; the architecture interview now adds records without implementing the system.

## Records

- [ADR-0001: Interpret requested quantities as cart targets](0001-requested-quantities-as-cart-targets.md) — Accepted.
- [ADR-0002: Separate match classification from execution approval](0002-separate-match-classification-from-execution-approval.md) — Accepted.
- [ADR-0003: Pause on invalid approval or uncertain mutations](0003-pause-on-invalid-approval-or-uncertain-mutations.md) — Accepted.
- [ADR-0004: Scope V1 to one user, fixed shopping context, and one cart-changing run](0004-single-user-fixed-context-and-one-cart-changing-run.md) — Accepted.
- [ADR-0005: Use a local browser UI with backend-owned execution](0005-local-browser-ui-with-backend-owned-execution.md) — Accepted.
- [ADR-0006: Use a dedicated retailer session with human login and handoff](0006-dedicated-retailer-session-with-human-login-and-handoff.md) — Accepted.
- [ADR-0007: Use a proposal-only LLM with independent matching gates](0007-proposal-only-llm-with-independent-matching-gates.md) — Accepted.
- [ADR-0008: Keep minimal durable state without crash-resume](0008-minimal-durable-state-without-crash-resume.md) — Accepted.
- [ADR-0009: Use a dependency-free Node.js rehearsal slice](0009-rehearsal-slice-implementation-stack.md) — Proposed.

## Convention

- Use sequential, four-digit filenames with a short kebab-case title: `0001-title-of-decision.md`, `0002-title-of-decision.md`.
- Begin a debated choice as **Proposed**. Change it to **Accepted** only after explicit agreement in the architecture discussion; listing a candidate technology is not acceptance.
- Use **Rejected** for a considered proposal that was not adopted. Use **Superseded** when a later accepted ADR replaces an earlier one, and link the records in both directions.
- Preserve decision history. Record material changes through a new ADR rather than silently rewriting an accepted rationale.
- Link relevant product requirements and investigation evidence. Separate observed facts from hypotheses in the context.
- Keep each record focused on a coherent decision. Describe resulting architecture in [architecture/](../architecture/README.md) once accepted.

The [question backlog](../architecture/adr-questions.md) seeds the next grilling session; it is not a set of preselected answers or a required one-question-per-ADR mapping.

## Minimal template

Choose one status from the options below.

```markdown
# ADR-NNNN: Title

## Status

Proposed | Accepted | Superseded | Rejected

## Context

## Decision

## Consequences

## Alternatives considered
```
