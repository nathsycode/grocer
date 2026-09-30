# ADR-0011: Add executor revalidation and a manual-checkout handoff boundary

## Status

Proposed. This records the offline-testable part of ticket 04 (verified live cart
and handoff) built on the ticket 01 execution framework. It does **not** authorise
live cart writes, and it does not establish the Landmark mutation contract that
ticket 02 still has to verify.

## Context

[ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md) requires the
executor to pause on a stale approval, a changed cart, or a unit-price increase.
[ADR-0006](0006-dedicated-retailer-session-with-human-login-and-handoff.md)
requires manual checkout to use the dedicated retailer browser and requires
handoff to stop automated retailer reads, navigation, and mutations while leaving
the browser usable; it records that how to enforce that boundary "remains open".

Ticket 04 is blocked by ticket 03, which is blocked on ticket 02's signed-in
evidence. Its live mutation contract cannot be established without a separately
authorised probe, so live writes stay disabled. The executor revalidation and the
handoff boundary are testable offline against the synthetic simulator.

## Decision

1. **Executor-owned pre-dispatch revalidation.** Immediately before each dispatch,
   the store re-checks the shopping context, the cart quantity, the unit price, and
   the product identity against the stored approval, and it re-checks that the
   product's evidence is not conflicting. A product that has been removed from the
   catalogue, whose evidence becomes conflicting, or that keeps its id but changes
   brand, name, variant, or size is not the approved product: execution pauses for
   renewed review. The same enforceable checks are shared by pre-execution
   revalidation and per-dispatch execution so they cannot drift. A unit-price
   decrease may proceed, but the lower observation is recorded and reported rather
   than silently dispatched at the stale price. The model never participates in
   any of these checks.
2. **Handoff is a terminal, recorded run state.** `checkout_handoff` is appended to
   the safety journal and the run becomes `handed-off`. Handoff re-reads the current
   durable journal state and the live lock holder instead of trusting cached flags,
   so another process's unresolved mutation or ownership is seen. It is refused
   while a mutation outcome is unresolved, while ownership is held, while execution
   is in flight, or before a verified result exists, so an uncertain outcome cannot
   be hidden behind a handoff. The verification is bound to the plan revision,
   context, and approval it observed, so a changed plan cannot reuse an older
   verification. Handoff is terminal: correction, selection, review, and approval
   are refused afterwards, and a later run needs fresh checks and its own approval.
   The prepared cart is recorded as prepared, never as a verified purchase.
3. **Handoff stops automation but keeps the browser.** The dedicated session sets a
   stopped flag that refuses every later context check and cart read. Reads already
   in flight observe the stop and refuse, and handoff waits for them before
   detaching the browser's read-only route guard, so no retailer read can start or
   complete after handoff returns and authority cannot be restored. The operator's
   own manual checkout interactions are not mediated by the application. The browser
   is not closed. After handoff, execution and reconciliation for that run are
   refused.
4. **No live mutation path is added.** The retailer session still exposes only
   context verification, cart reads, and handoff. There is no endpoint, driver
   method, or UI action that writes to Landmark.

## Consequences

- The simulator can now demonstrate and test the whole approved flow through safe
  handoff, including identity drift, conflicting evidence, a mid-execution context
  change, a price decrease, verification reuse after a plan change, and the
  stop-to-automation step, without touching a real cart.
- Handoff is a run-level boundary. It does not release an unresolved mutation,
  delete history, or force-unlock a blocked run.
- The live mutation contract, price/tax semantics, session-expiry handling, and a
  live read-after-write demonstration remain unverified and are not established by
  this record. Ticket 04 stays blocked until they are.

## Alternatives considered

- **Hand off while an uncertain mutation is open:** rejected; it would present an
  unresolved outcome as a prepared cart, which ADR-0003 and ADR-0006 forbid.
- **Close the retailer browser at handoff:** rejected; the operator needs it for
  manual checkout.
- **Keep the read-only guard active after handoff:** rejected; it would keep the
  application between the operator and their own checkout interactions.
- **Build a mutation probe now:** rejected; it needs separate operator
  authorisation and live contract evidence that does not yet exist.
