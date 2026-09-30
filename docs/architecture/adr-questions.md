# Questions for the ADR grilling session

The initial MVP architecture interview is complete under [ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md). This is a remaining-work backlog, not a design proposal or a requirement to settle every question before building. Learned preferences, purchase history, concurrent planning, automatic recovery, and interrupted-run continuation are deferred; resolve other questions when they block the first safe vertical slice. Accepted decisions are linked under the relevant topic; remaining questions stay open. Candidate technologies are not selections. Use [GOAL.md](../../GOAL.md) as product intent and [Landmark observations](../integrations/landmark/observations.md) as limited evidence; record agreed architecture choices through the [ADR convention](../adr/README.md).

## Runtime / language

Accepted constraints: [ADR-0004](../adr/0004-single-user-fixed-context-and-one-cart-changing-run.md) establishes a single-user, single-account, fixed-context V1. [ADR-0005](../adr/0005-local-browser-ui-with-backend-owned-execution.md) selects a local backend and same-computer browser review UI; approved execution is independent of the review tab's lifetime.

- What makes TypeScript/Node preferable or inferior to alternatives for this workload and its maintenance needs?
- How should the local backend be launched, stopped, and packaged without introducing unnecessary service infrastructure?
- What process-lifecycle and session constraints follow from local execution, including sleep, shutdown, and restarting after unresolved mutations?

## Browser boundary

Related accepted decision: [ADR-0006](../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md) uses an isolated retailer session, direct human login, best-effort protected sign-in reuse, and manual checkout in that session. Library, storage, and process-lifetime mechanisms remain open.

- If Playwright is adopted, which responsibilities belong to it: session establishment, authentication, location selection, discovery, mutation, fallback, or handoff?
- Given visible human login and checkout, should other stages also remain headed, and how should intervention and browser-process lifetime work?
- Should sessions use a persistent browser profile or exported storage state, and how would expiry, isolation, and recovery differ?
- What is the browser fallback philosophy: which failures justify it, and which require stopping for review?

## Landmark API integration

- Should requests use direct HTTP, the browser's request context, page execution, or some combination, and what evidence is needed to choose?
- How should undocumented endpoints and their assumptions be isolated from product/domain logic?
- How should endpoint or schema drift be detected before it causes incorrect interpretation or cart mutation?
- When should API failure trigger UI fallback versus a hard stop, especially after an uncertain mutation result?

## Product discovery

- What evidence would justify using a search endpoint rather than scraping, and what fallback is acceptable?
- How should queries be generated from loose requests while preserving explicit brand, size, variant, and quantity constraints?
- What normalized candidate data is needed, and how should missing or conflicting retailer attributes be represented?
- How should variants and parent products be distinguished without guessing their identity?
- How should discovery account for stock, selected branch/location, and data freshness?

## Matching

Related accepted decisions: [ADR-0002](../adr/0002-separate-match-classification-from-execution-approval.md) classifies unresolved size preferences as yellow even with a sole candidate and separates classification from approval. [ADR-0007](../adr/0007-proposal-only-llm-with-independent-matching-gates.md) gives application code independent evidence/constraint gates; model confidence cannot override them. Conflicting identity/size requires resolved retailer evidence, and an explicit no-substitution prohibition requires request revision before a conflicting alternative becomes selectable. Scoring and calibration remain open.

- Within those gates, which ranking tasks benefit from deterministic scoring versus model judgement?
- What normalization and semantic-equivalence rules implement the gates, and which evidence supports aliases without allowing unsupported model assumptions?
- What retailer evidence and source-precedence rules can resolve conflicting product attributes, and how should unresolved facts remain explicit?
- How should confidence be calibrated against actual correctness rather than model self-confidence?
- What ambiguity thresholds distinguish green, yellow, orange, and red, and how should false-green outcomes be evaluated?
- Should the LLM see all candidates or a pre-filtered shortlist, and how should filtering avoid excluding the correct product?

## Execution model

Related accepted decisions: [ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md) settles default quantity targets and treatment of existing contents; [ADR-0002](../adr/0002-separate-match-classification-from-execution-approval.md) requires explicit V1 plan approval and explicit selection of yellow/orange choices. [ADR-0003](../adr/0003-pause-on-invalid-approval-or-uncertain-mutations.md) settles price-increase reapproval, expanded additions after concurrent edits, execution pauses, and no automatic retry of timed-out mutations; observed target satisfaction remains distinct from unknown request outcome. [ADR-0004](../adr/0004-single-user-fixed-context-and-one-cart-changing-run.md) binds V1 to one configured account/location context and one cart-changing run at a time, retaining ownership during unresolved pauses. Detailed recovery, context-verification mechanisms, and other concurrent-edit cases remain open.

- How should a plan-first, execute-second workflow represent and bind approval to specific products, quantities, and assumptions?
- What approval states and policy-based approvals are needed, and what changes should invalidate an existing approval?
- How can cart mutations be made effectively idempotent when undocumented endpoints may not offer idempotency guarantees?
- Given ADR-0003 and ADR-0008, what evidence permits safe resolution of an interrupted run and release for a fresh plan? If that evidence is unavailable, keep execution blocked rather than implementing resume or force-unlock.
- What should reconciliation compare, when should it run, and who may authorise corrective actions?
- How should pre-existing cart contents, merged lines, concurrent user edits, and partial execution be handled without destructive surprises?
- When is execution ownership acquired, how is it enforced across entry points and restarts, and what evidence permits release after a pause or abandonment?
- Deferred beyond the first slice: if concurrent read-only planning is introduced later, how should plans be revalidated before acquiring execution ownership?

## State / memory

Related accepted decision: [ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md) requires a minimal durable safety journal, mutation intent before dispatch, and read-only reconciliation after restart rather than continuation. Storage failure blocks further mutations. Preference learning and purchase history below are future topics, not MVP requirements.

- Would SQLite or another minimal local store best support these durability requirements, process exclusion, and safe handling of missing or unreadable expected state?
- How should user preferences differ from approved request-to-product mappings and individual approval events?
- Given ADR-0006's stop to post-handoff retailer monitoring, is user-reported purchase history needed, and how should its provenance differ from verified cart preparation?
- How should substitution policies express scope and explicit consent without overriding current instructions?
- When should preferences or mappings expire, be versioned, or be revalidated after catalogue/location changes?
- How can users inspect, override, correct, and delete remembered choices?

## LLM boundary

Related accepted decision: [ADR-0007](../adr/0007-proposal-only-llm-with-independent-matching-gates.md) selects a proposal-only model with no retailer tools. Application code owns discovery, validation, approval, execution, and reconciliation. Interpretation is shown with original text within plan review, not a mandatory separate confirmation stage.

- What structured outputs and source references are required, and how should malformed, incomplete, or conflicting outputs be handled?
- How should interpretation preserve explicit restrictions and distinguish them from inferred preferences, including detecting semantic omissions beyond schema checks?
- How should application code constrain suggested queries to scoped discovery rather than arbitrary network/browser actions?
- What model-call budgets and error/retry limits are justified without treating model failure as permission to broaden the request?
- How should prompt injection in retailer-controlled product names, descriptions, or page content be contained?
- What evidence should guide provider/model selection, including quality, privacy, cost, and reproducibility?

## UI

Related accepted decision: [ADR-0005](../adr/0005-local-browser-ui-with-backend-owned-execution.md) selects a local browser review UI; closing it does not cancel approved backend execution. The UI framework and detailed layout remain open.

- What minimum browser UI and framework, if any, best support list entry, explicit selection, plan approval, and reconnecting to current run state?
- Given ADR-0007's integrated interpretation review, how should original text, extracted restrictions, assumptions, and corrections remain clear without overwhelming plan review?
- How should review queues distinguish assumptions, substitutions, unresolved items, and execution failures?
- How should alternatives expose differences in brand, variant, size, quantity, price, and availability without hiding trade-offs?
- What bulk approval actions are safe, and how should their scope and exclusions be made explicit?

## Testing

- Which matching behaviours require unit tests, and what examples should protect against silent constraint relaxation?
- How should extraction and matching evaluations cover omitted prohibitions, unsupported product IDs, conflicting evidence, unit/package distinctions, and false-green outcomes under ADR-0007?
- How should Landmark response fixtures be captured, redacted, versioned, and distinguished from illustrative examples?
- Which integration tests can run offline, and which genuinely require an authorised live session?
- Which flows require browser tests rather than unit or HTTP integration tests?
- How should tests prevent accidental real orders, cart pollution, destructive cleanup, or use of the wrong account/location?
- What contract/schema tests should detect drift, and what should happen when they fail?

## Observability

- Which structured log events are necessary to understand a shopping run and its failures?
- How should decision traces connect requested items, candidates, assumptions, approvals, mutations, and reconciliation results?
- Which API/network traces should be retained, for how long, and under what access controls?
- How should account/session data and personal information be redacted before logging or exporting diagnostics?

## Security / privacy

Related accepted decision: [ADR-0006](../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md) keeps credential entry with the user in the retailer browser; V1 does not collect/store Landmark passwords or verification codes. Retained session state is still sensitive.

- How should browser interaction and diagnostics avoid capturing credential entry or leaking retained session state?
- How should cookies and exported storage state be protected, scoped, expired, and removed?
- What address or account data is truly needed for cart preparation, and how can unnecessary collection be avoided?
- What privacy, retention, and deletion rules should apply to purchase history, preferences, and model-bound data?
- What local secret storage mechanism, if any, is justified by the chosen runtime and deployment shape?
- How should the local UI/backend restrict network exposure and reject unauthorised requests from other browser origins or local clients?

## Future retailer support

- What concrete evidence or second-retailer need would justify an adapter abstraction?
- What belongs in generic grocery domain logic versus Landmark-specific catalogue, session, and cart code?
- How should differences in retailer capabilities be represented without forcing every store into Landmark's behaviour?

## Checkout boundary

Related accepted decision: [ADR-0006](../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md) stops all retailer automation at handoff and leaves the dedicated session for manual checkout; it does not permit handoff to conceal unresolved mutation outcomes.

- Why does V1 stop at the cart, and which failure modes and user-control needs should be documented as its rationale?
- How should the manual handoff preserve the verified cart while making unresolved items and verification limits visible?
- How should handoff disable every automated retailer-action path while keeping the browser available, and what evidence permits safe execution-ownership release?
- What evidence, safeguards, consent model, and explicitly approved architecture decision would be required before any later checkout automation?
