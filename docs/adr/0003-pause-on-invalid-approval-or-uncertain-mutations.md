# ADR-0003: Pause on invalid approval or uncertain mutations

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This is V1 execution policy, not evidence of implemented retailer guarantees.

## Context

[ADR-0001](0001-requested-quantities-as-cart-targets.md) defines desired cart quantities and approval of reductions. [ADR-0002](0002-separate-match-classification-from-execution-approval.md) requires approval of a concrete selected plan before execution.

Prices and cart contents may change between approval and execution. A mutation timeout leaves its outcome uncertain: the retailer may have applied it, may apply it later, or may not apply it at all. An unchanged cart read alone cannot establish failure or justify a retry.

The supplied [Landmark observations](../integrations/landmark/observations.md) establish neither atomic check-and-mutate operations nor idempotency, read-consistency, or request-completion guarantees. All scenarios in this ADR are hypothetical domain cases.

## Decision

### Approval limits

1. A unit-price increase from the approved price requires updated review and approval before executing the affected action. A decrease may proceed for the same product, configuration, and quantity, provided the other approved conditions remain valid; report the new price.
2. A target quantity does not authorise expanding a previously approved addition after a concurrent edit. If adding one was approved and an existing unit is then removed, do not add two under the old approval. Show the changed state and revised action for approval.
3. When any item requires reapproval, pause all remaining execution before issuing further mutations, rather than continuing apparently unaffected items automatically. Preserve and verify any changes already made and present the revised remainder for approval.

### Uncertain mutation outcomes

4. In V1, do not automatically retry a timed-out cart mutation. Pause further mutations and use read-only checks to reconcile where possible. If the outcome remains unresolved, report it as uncertain rather than as a definite failure.
5. A later read that verifies the expected product/configuration and target quantity may establish that the cart target is satisfied at that observation. It does not prove that the timed-out request caused that state or that a pending operation cannot affect it later.
6. Report target verification separately from mutation outcome: for example, “target verified in the observed cart; request outcome unknown.” Do not resend, silently resume, or describe the whole run as safely complete while that uncertainty remains. Remaining execution stays paused for review.
7. Pausing does not authorise automatic rollback, removal, or other corrective mutations. Preserve the actual state and seek the applicable approval for any proposed correction.

### Concrete cases

| Change or failure | V1 treatment |
| --- | --- |
| Same approved product's unit price increases before execution | Pause remaining execution; show the updated price and request renewed approval. |
| Same approved product's unit price decreases; other approved conditions remain valid | May execute the approved action and report the lower price. |
| Approved addition was one to reach two; someone removes the existing unit | Pause; propose the revised action rather than silently adding two. |
| A cart mutation times out; a read still shows the old quantity | Pause, do not automatically retry, and report uncertainty. |
| A later read verifies the target after the timeout | Record observed target satisfaction separately from unknown mutation outcome; keep execution paused for review. |

## Consequences

- Approval must retain enough information to compare reviewed prices and intended actions with newly observed conditions. The storage representation and validation mechanism remain undecided.
- One changed item interrupts the remainder of a run. This favours inspectability over independently progressing unaffected items in V1.
- The system must distinguish a known failure from an unknown mutation outcome, and distinguish both from verification of observed cart state.
- A pre-mutation check cannot eliminate the race between checking and writing without retailer-side guarantees. Post-mutation verification must surface discrepancies; the system must not promise atomic enforcement based on the current evidence.
- Pausing does not cancel an in-flight retailer operation. A later observation is a snapshot, not proof that no delayed mutation can occur.
- The detailed recovery/resume procedure, read-only polling limits, price/tax/discount normalization, approval expiry, session/store binding, and treatment of concurrent edits that reduce the required addition remain open.
- New approval alone does not prove that retrying an unresolved earlier mutation is safe. This ADR grants no retry or recovery-mutation authority beyond the rules above.

## Alternatives considered

- **Reapprove every price change, including decreases:** not selected; decreases may proceed when the rest of the approved conditions remain valid.
- **Permit price increases within an approved tolerance:** deferred; V1 requires reapproval for increases.
- **Treat price as informational until manual checkout:** not selected; price increases affect permission to prepare the cart.
- **Enforce a target regardless of changes to the required addition:** rejected for the concurrent-removal case; the original approval does not cover adding more units.
- **Continue unaffected items after another item needs reapproval:** not selected for V1; pause the remaining execution.
- **Automatically retry timeouts using future proven safeguards:** not selected for V1. The chosen policy is no automatic mutation retry after timeout.
- **Treat an unchanged read as proof of mutation failure:** rejected; a delayed application remains possible.
- **Require causal proof before recording any observed target satisfaction:** not selected. Target verification and mutation outcome are separate facts, with their respective limits preserved.
