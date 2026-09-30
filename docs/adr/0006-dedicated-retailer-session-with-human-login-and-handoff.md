# ADR-0006: Use a dedicated retailer session with human login and handoff

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This decision defines session ownership and human-interaction boundaries, not a browser library or session-storage mechanism.

## Context

[ADR-0005](0005-local-browser-ui-with-backend-owned-execution.md) selects a local review UI and backend-owned execution, but leaves the retailer interaction session separate. [ADR-0004](0004-single-user-fixed-context-and-one-cart-changing-run.md) limits V1 to one intended account/location context and one cart-changing execution owner.

The owner selected a dedicated retailer session, direct human login, best-effort reuse of locally retained sign-in, and a stop to retailer automation at manual checkout handoff.

Landmark's login requirements, session persistence, cart identity, and cross-browser cart behaviour remain [uninvestigated](../integrations/landmark/observations.md). These choices describe intended product behaviour, not proven integration capabilities.

## Decision

1. Use a dedicated Landmark browser session isolated from the operator's everyday browser session. Do not attach to or import the everyday browser profile by default. A separate window alone is not proof of session isolation.
2. The operator performs login and any required human verification directly in the dedicated retailer browser. The assistant waits rather than performing credential-based login. V1 does not collect or store the operator's Landmark password or one-time verification codes in application configuration, prompts, logs, or traces.
3. After authentication, establish the intended account/location context and relevant cart state before further cart actions. Login success alone does not validate an old plan, authorise a context change, or resolve an uncertain earlier mutation.
4. Try to retain the dedicated sign-in between application launches using protected local session state. Reuse is best-effort: expiry or invalid state requires human authentication again. Session restoration is not automatic restoration of approval or permission to resume uncertain execution.
5. Hand a safely prepared, verified cart to the operator in that dedicated browser session for manual checkout. Do not rely on cart transfer to the everyday browser. Leave the dedicated browser available for human interaction.
6. At handoff, stop automated retailer reads, navigation, and mutations for the run, including browser and any HTTP integration paths. Do not continue monitoring checkout or repair subsequent manual cart edits. This is a control boundary, not an instruction to submit an order or payment.
7. A later shopping run requires fresh context/cart checks and its own approval. Retained sign-in or the old approved target does not authorise continued automation after handoff.

## Consequences

- Human login and checkout require a usable visible retailer browser at those points. Headed versus headless operation during other stages and the browser library remain undecided.
- Session state can grant account access without a password. It must be treated as sensitive, kept out of committed fixtures/logs/model context, and protected locally. Isolation is not a substitute for access controls.
- Persistent browser profiles and exported storage state remain alternative mechanisms, neither selected. Storage location, access controls, encryption, expiry, deletion, and any reset procedure still need design and investigation.
- Stopping automation must cover all retailer-action paths, not just hiding or disconnecting the review UI. How to enforce this and leave the retailer browser usable remains open.
- A partially fulfilled grocery list can still have a verified approved subset for handoff. An unresolved mutation outcome is different: [ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md) forbids treating an uncertain run as safely complete merely because one cart observation meets the target. Handoff does not bypass that rule.
- Leaving the browser available does not guarantee it survives backend termination. Browser-process lifetime, safe ownership release, and recovery remain unresolved.
- The application will not observe or confirm a completed purchase through post-handoff retailer monitoring in V1. A prepared cart must not be recorded as a verified purchase.
- No live login, session capture, browser probing, or cart action is authorised by this documentation decision.

## Alternatives considered

- **Reuse the everyday browser session:** not selected; the owner prefers separation from ordinary browsing.
- **Assistant-managed credential login:** not selected; the operator logs in directly.
- **Fresh retailer session for every application launch:** not selected; best-effort protected sign-in reuse is preferred.
- **Transfer checkout to another browser:** not required; use the dedicated session without assuming cross-browser cart behaviour.
- **Continue read-only monitoring after handoff:** not selected; stop retailer automation and leave subsequent checkout activity to the operator.
