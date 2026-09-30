# Investigations

Use this directory for bounded research and experiments that test assumptions without silently making architecture decisions. No new investigation was performed during bootstrap; supplied Landmark findings live in [integration observations](../integrations/landmark/observations.md).

## Investigation index

- [2026-09-29: Landmark anonymous read-only probe](../integrations/landmark/read-only-probe-2026-09-29.md) — observed public discovery, simple-product detail, and an empty anonymous cart read; signed-in context and mutations remain unverified. Retailer-specific evidence is kept in the integration directory rather than duplicated here.
- [Landmark signed-in read-only probe procedure](../integrations/landmark/signed-in-read-probe-procedure.md) — **prepared, not executed.** Repeatable read-only method for the operator's intended account/branch, populated cart structure, and cart-line-to-catalogue correspondence. No signed-in evidence exists yet.

For each investigation, record:

- The question or hypothesis and why it matters.
- Date, source, environment, and relevant session/store context, without secrets or personal data.
- Method, authorised scope, and redacted evidence.
- Observed results, interpretations, limitations, and remaining unknowns, clearly separated.
- Links to relevant integration references, product specifications, or proposed ADRs.

An inconclusive result is valid; report it rather than promoting a guess to a fact. Move consequential choices through [ADRs](../adr/README.md). Avoid duplicating authoritative retailer evidence across files.

Live-site experiments must respect [AGENTS.md](../../AGENTS.md): understand current state before mutations, avoid destructive or unapproved changes, verify authorised mutations, and never submit orders or payments within the initial scope.
