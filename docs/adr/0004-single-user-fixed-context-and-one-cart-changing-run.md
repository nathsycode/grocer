# ADR-0004: Scope V1 to one user, fixed shopping context, and one cart-changing run

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This decision constrains V1 scope and coordination without choosing deployment, authentication, or locking technology.

## Context

A personal grocery assistant does not necessarily need household collaboration, separate customer accounts, or branch comparison. Those capabilities would introduce preference ownership, approval authority, session isolation, and cart coordination requirements before the first usable version.

The project owner selected one operator, one Landmark account, and one configured branch/location context for V1. The owner also chose one cart-changing run at a time, including when a run is paused.

[ADR-0001](0001-requested-quantities-as-cart-targets.md) requires accounting for existing cart contents. [ADR-0002](0002-separate-match-classification-from-execution-approval.md) requires explicit plan approval. [ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md) pauses remaining execution on invalid approval or uncertain mutations and prohibits automatic timeout retries.

Landmark's account, session, and branch/location mechanisms remain [uninvestigated](../integrations/landmark/observations.md). The configured context below is a domain requirement, not an asserted retailer field or API contract.

## Decision

1. V1 supports one operator and personal shopping preferences. Household collaboration, multiple approvers, and independent-user accounts are outside V1. This does not require preference learning to ship in the first implementation.
2. V1 targets one intended Landmark account. Switching among multiple retailer accounts is outside scope.
3. V1 targets one configured branch/location context. Per-run location selection, automatic branch choice, and cross-branch shopping comparison are outside scope. The actual account and location values are not selected or recorded by this ADR.
4. An unexpected account or configured-context change must pause execution rather than silently carrying approval into the new context. The system must establish the intended context before cart actions; uncertainty is not permission to proceed.
5. Permit at most one cart-changing run to own execution against the configured cart at a time. A second run may not mutate that cart while the earlier run remains active or paused and unresolved.
6. A timeout-induced pause does not automatically release execution ownership. Starting a new run must not become a way to bypass the earlier run's unresolved mutation outcome or no-retry policy.

## Consequences

- V1 avoids household preference arbitration, multi-user tenancy, multi-account switching, and automatic store optimization.
- Single-user scope does not imply a local-only application, remove the need for access control in a hosted deployment, or select a session/authentication approach.
- Context verification must be designed against observed retailer behaviour; this ADR does not assume a stable account, cart, or branch identifier is available from an API.
- The one-run rule applies across assistant entry points, not merely within a single tab or process. Its enforcement mechanism remains undecided.
- Coordination among assistant runs does not lock Landmark against manual user edits or retailer-side changes. ADR-0003's revalidation and pause rules still apply.
- A paused run can block later execution. Safe recovery, abandonment, crash/restart behaviour, and ownership release require explicit design; neither closing the UI nor declaring a run abandoned proves an in-flight retailer operation has stopped.
- The ownership acquisition point and whether additional read-only planning may run concurrently remain open. This decision governs cart mutation authority, not a final workflow state machine.
- Supporting a different account/location or more users later requires deliberate scope and design review, not silently broadening this configuration.

## Alternatives considered

- **Household collaboration in V1:** not selected; only the operator's personal shopping workflow is required initially.
- **Multiple independent shoppers:** not selected; multi-user product capabilities are outside V1.
- **Multiple personal Landmark accounts:** not selected; one intended account is sufficient.
- **Explicit branch/location choice per run:** not selected; V1 targets one configured context.
- **Assistant-selected branch/location:** not selected; availability/value-based location comparison is outside V1.
- **Overlapping independently approved cart-changing runs:** not selected; V1 serializes execution ownership rather than requiring interleaved plan coordination.
- **Treating a timeout pause as release of the cart:** rejected because the earlier operation may still apply, and a new run could duplicate or conflict with it.
