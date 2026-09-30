# ADR-0008: Keep minimal durable state without crash-resume

## Status

Accepted

Explicitly accepted by the project owner to conclude the MVP architecture session. This record freezes the first usable slice without selecting a storage technology or claiming retailer recovery guarantees.

## Context

[ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md) prohibits retrying uncertain mutations automatically. [ADR-0004](0004-single-user-fixed-context-and-one-cart-changing-run.md) retains execution ownership during unresolved pauses. A process restart must not erase either restriction.

The owner wants one workable MVP rather than further architecture expansion. Seamless recovery and preference learning are not needed to demonstrate approved, verified cart preparation.

## Decision

1. Keep a local durable safety journal containing the original request, reviewed choices and relevant evidence, approval, minimal shopping-context references, relevant cart observations, mutation attempts/outcomes, and execution-ownership status. Retain enough to explain approved versus observed changes, not raw browser/network dumps. Retailer sign-in state remains separate sensitive state under [ADR-0006](0006-dedicated-retailer-session-with-human-login-and-handoff.md).
2. Durably record each intended mutation before dispatch. Record subsequent outcome and verification separately. If required storage fails, issue no further mutations; failure to persist a result after dispatch leaves an unresolved attempt, not permission to resend.
3. Do not implement continuation of an interrupted run after backend restart in the MVP. Restore its recorded state for inspection and read-only reconciliation, not replay. Closing only the review tab remains different: [ADR-0005](0005-local-browser-ui-with-backend-owned-execution.md) permits the still-running backend to continue approved work.
4. Once prior operations are safely accounted for and ownership can be released, create a fresh plan from the actual context/cart and obtain new approval. Do not reuse old additions or approval. In-process reapproval pauses remain governed by ADR-0003.
5. While an earlier mutation remains uncertain, retain the execution block. A matching cart snapshot, restart, new approval, or deletion of history is not proof that an earlier request cannot still apply. Missing or unreadable expected journal state is not a safe empty run. Do not provide a force-unlock shortcut in the MVP.
6. Defer learned preferences, purchase history, concurrent planning, automatic recovery, and interrupted-run continuation. Keep the first slice to one list, explicit review/approval, approved cart changes, verification, and manual handoff, subject to the accepted safety policies.

## Consequences

- A useful happy-path MVP does not require seamless recovery. An uncertain retailer request may block further assistant cart changes pending investigation; do not promise every interruption is automatically recoverable.
- Evidence sufficient for safe ownership release depends on retailer behaviour still requiring investigation. Implementation must not invent completion or cancellation guarantees.
- Journal transactions, process exclusion, storage choice, protection/retention, and detection of missing state are implementation work, not additional features or selected technologies here.
- The architecture interview can stop here. Remaining backlog questions are not all prerequisites to a first vertical slice; resolve a question when it blocks that slice or a safety requirement.
- This record authorises no implementation, model calls, browser login, or live retailer actions.

## Alternatives considered

- **Memory-only execution state:** rejected; restart could hide unresolved mutations and ownership.
- **Resume the unfinished plan after restart:** deferred; fresh planning after safe reconciliation is sufficient initially.
- **Build preference/history features before cart preparation works:** deferred to keep the MVP bounded.
