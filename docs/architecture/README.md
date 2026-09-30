# Architecture

This directory will describe the architecture that emerges from accepted [ADRs](../adr/README.md): responsibilities, boundaries, data flows, and relevant diagrams. It does not replace decision records or host an invented final design.

The V1 application shape is accepted, but its implementation stack and detailed component design remain undecided. The product's initial checkout boundary is already defined in [GOAL.md](../../GOAL.md); how to enforce it remains a design topic.

## Accepted domain decisions

[ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md) defines requested quantities as desired totals for exact selected products/configurations. The eventual planning and reconciliation design must account for existing matching units, explicit approval of reductions, and preservation of separate pre-existing contents.

[ADR-0002](../adr/0002-separate-match-classification-from-execution-approval.md) keeps classification, selection, and execution approval distinct. V1 requires explicit plan approval even for green additions, with explicit selection of each yellow/orange choice. Implementation mechanisms remain open.

[ADR-0003](../adr/0003-pause-on-invalid-approval-or-uncertain-mutations.md) requires reapproval for price increases and expanded additions after concurrent edits, pausing the remaining execution. V1 does not automatically retry timed-out mutations. Observed target satisfaction and unknown request outcome remain separate facts. Recovery/resume mechanics and other concurrent-edit cases remain open.

[ADR-0004](../adr/0004-single-user-fixed-context-and-one-cart-changing-run.md) scopes V1 to one operator, one Landmark account, and one configured branch/location. Unexpected context changes pause execution. Only one cart-changing run may own execution against the cart, including during an unresolved pause. Context-verification evidence and ownership enforcement/release remain undecided.

## Accepted application shape

[ADR-0005](../adr/0005-local-browser-ui-with-backend-owned-execution.md) selects a local backend and same-computer browser review UI. The backend owns execution independently of the review tab: closing it permits already approved work to continue under the safety policies, and reopening retrieves current state rather than replaying actions. Remote access, a hosted application service, and native desktop packaging are not required. Runtime, frameworks, and transport remain open; the minimal restart policy is defined in ADR-0008 below.

## Accepted retailer-session boundary

[ADR-0006](../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md) selects an isolated retailer browser session, direct human login, and best-effort protected local sign-in reuse. Manual checkout uses that dedicated session; handoff stops automated retailer reads, navigation, and mutations for the run. Retained sign-in does not restore execution authority. Browser library, storage mechanism and protection details, process lifetime, and enforcement of the handoff boundary remain open.

## Accepted model and matching boundary

[ADR-0007](../adr/0007-proposal-only-llm-with-independent-matching-gates.md) limits the LLM to proposals without retailer tools. Application code controls discovery and execution and independently enforces evidence/constraint gates. Model confidence cannot override a failed gate; passing gates does not itself establish green classification. Semantic-equivalence rules, scoring, and calibration remain open.

Plan review exposes original text alongside interpreted constraints and assumptions. Explicit no-substitution restrictions require request revision before conflicting alternatives become selectable; contradictory material identity/size data requires resolved retailer evidence, not an approval waiver. Schema checks and review do not guarantee complete semantic preservation.

## Accepted MVP persistence and restart boundary

[ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md) requires minimal durable safety records, including mutation intent before dispatch and outcomes/verification afterward. Backend restart permits inspection and read-only reconciliation, not continuation or replay. Fresh planning and approval require safe resolution of earlier operations; uncertain outcomes retain the execution block. Storage mechanisms and retailer evidence for safe release remain implementation/investigation work.

Learned preferences, purchase history, concurrent planning, automatic recovery, and interrupted-run continuation are deferred. A safety journal does not imply an event-sourcing framework or a separate service.

## Current hypotheses — not decisions

The detailed browser/HTTP division remains a candidate for discussion:

- Landmark's browser-facing HTTP endpoints are used where investigation shows them reliable enough.
- Browser automation may support session establishment, user-performed authentication, configured-location setup, and suitable fallbacks within ADR-0006's accepted ownership and handoff boundary.

TypeScript/Node, Playwright, and SQLite have been mentioned as candidates for implementation, browser/session automation, and preference/history storage respectively. None is selected. LLM provider/model, UI framework, launch/packaging details, and any future retailer adapter interface are also undecided; the local application shape above is an accepted decision, not a hypothesis.

Restricted model authority and verified cart outcomes are product/safety constraints, not evidence that a specific permission system or reconciliation design has been chosen.

## First build sequence

The MVP architecture interview is complete. Do not expand the feature set to answer every [backlog question](adr-questions.md).

1. Separately authorise a narrow Landmark feasibility investigation: dedicated session/context, product discovery, cart identity, quantity changes, and verification. Record redacted evidence and limits in [investigations](../investigations/README.md) and [Landmark observations](../integrations/landmark/observations.md). No order/payment submission.
2. Use that evidence to choose the minimal implementation stack and build one vertical slice: list → interpretation/candidates → explicit review/approval → journalled cart changes → verification → manual handoff.
3. Validate the happy path and fail-closed paths, especially constraint violations, missing approval, storage failure, interruption, and uncertain mutation outcomes, before routine shopping use.

This sequence is a plan, not authorisation to implement or perform live retailer actions in this documentation session.
