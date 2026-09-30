# ADR-0005: Use a local browser UI with backend-owned execution

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This decision chooses the V1 application shape and UI-disconnection behaviour, not a runtime, framework, storage engine, or browser-automation library.

## Context

[ADR-0004](0004-single-user-fixed-context-and-one-cart-changing-run.md) scopes V1 to one operator, one Landmark account, one configured location, and one cart-changing execution owner. The owner only needs access from the computer running the assistant; phone and remote access are not V1 requirements.

[ADR-0002](0002-separate-match-classification-from-execution-approval.md) requires concrete product review, explicit selection of yellow/orange choices, and explicit plan approval. The owner chose a local browser UI over terminal prompts or a native desktop window for this review experience.

The owner also chose to let a still-running local backend continue approved work after the review tab closes. Closing the UI cannot reliably cancel a request already sent to the retailer.

## Decision

1. Run the V1 assistant backend on the operator's computer and provide a browser-based review UI on that same computer. A separately hosted application service, phone access, and remote review are outside V1 scope.
2. Use the UI to enter lists, inspect concrete choices and alternatives, select uncertain choices, approve selected plans, and inspect execution progress and results. Follow ADR-0002's review rules rather than making chat alone the approval interface.
3. The local backend owns execution and its progress state independently of the review tab's lifetime. An approved run is not tied to an open UI connection or a browser page's continued JavaScript execution.
4. If the review tab closes or disconnects while the backend remains running, it may continue already approved work within the existing safety rules. Reopening the UI must show the current run's progress, result, or paused state without starting a new run or replaying mutations merely because of reconnection.
5. UI absence supplies no new approval. Price increases, expanded additions, uncertain mutation outcomes, and other conditions requiring review still pause execution under [ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md).
6. Closing the UI is neither cancellation nor release of execution ownership. ADR-0004's one-run ownership rule remains in force, including during unresolved pauses.

## Consequences

- A visual review interface supports comparing groceries and exposing assumptions at the cost of UI and local-backend work. No frontend framework, component library, transport protocol, port, or launcher is selected.
- V1 does not require independently hosted execution or remote-access infrastructure. The implementation must not introduce remote exposure by default; concrete local-access protections remain to be designed.
- The review page and the retailer interaction session are distinct responsibilities. This ADR does not decide whether the retailer session uses a managed browser, the user's ordinary browser, or a particular profile/storage-state mechanism.
- Continuation after closing the review tab depends on the backend and necessary retailer interaction facilities remaining available. It is not a guarantee of continuation after backend termination, browser/session loss, sleep, or computer shutdown.
- Reopening the UI while the backend stays alive requires retrieving its current state, not necessarily a database. Persistence, crash recovery, startup behaviour, and safe ownership release remain separate design questions.
- An explicit pause/cancel action, if introduced, needs defined semantics for already dispatched requests; it cannot be inferred from tab closure.
- Local application execution does not mean offline operation or that all data stays local. Landmark access requires network interaction, and local versus remote model inference and data-sharing limits remain undecided.
- Manual checkout is still the product boundary. Which browser/session presents the verified cart for handoff remains to be decided and investigated.

## Alternatives considered

- **Terminal review interface:** not selected; the owner prefers a visual local browser interface for product comparison and selection.
- **Native desktop window:** not selected; dedicated desktop packaging is not required for V1.
- **Phone review while a personal computer runs:** not selected; same-computer access is sufficient.
- **Access from anywhere without relying on the personal computer:** not selected; an independently hosted application service is not needed for V1.
- **Pause on detected UI disconnect:** not selected. Approved work may continue while the backend remains running, subject to the existing pause and approval policies.
- **Treat tab closure as cancellation:** rejected as an interpretation of the chosen lifecycle; it cannot reliably cancel already dispatched retailer operations.
