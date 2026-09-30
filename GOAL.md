# Goal: an AI-assisted grocery shopping assistant

## Problem

A loose grocery list rarely specifies every brand, package size, or variant. Turning it into an online cart requires searching, interpreting intent, comparing products, checking availability, and resolving substitutions. Blind automation risks buying the wrong groceries; doing everything manually repeats familiar work.

## Product vision

Reduce grocery-shopping effort while preserving user control wherever product identity or preference is uncertain. The assistant should explain its choices, learn ordinary preferences over time, and prepare a cart the user can trust.

Landmark Philippines (<https://www.landmark.ph>) is the initial retailer, not necessarily the permanent product boundary. Future retailers need not behave like Landmark; this intent does not require a multi-store framework now.

## Core user journey

1. Provide an informal list, for example:

   ```text
   Full cream milk
   Corned beef Highlands x2
   Tulip Luncheon meat/Spam x2
   Corned beef for pasta (CDO) x2
   Fusilli pasta 500g x2
   ```

2. Interpret the list as structured requirements, preserving explicit attributes and separating unknowns from assumptions. Package size and purchase quantity are distinct. Show the original text and interpreted constraints together during plan review, allowing correction before approval.
3. Search the retailer's catalogue and identify candidates against those requirements.
4. Classify matches by confidence and required intervention; explain recommendations and proposed substitutions.
5. Present ambiguous choices, alternatives, and unavailable items for review. Establish an approved plan without hiding unresolved items.
6. Add approved products to the cart.
7. Verify the resulting cart against the approved plan and report discrepancies or unresolved requests.
8. Hand off to the user for final checkout and payment on Landmark.

An illustrative end state is:

```text
Cart ready — approved items added and verified
14 requested items
12 exact/high-confidence
1 recommendation requiring review (not added)
1 unresolved (not added)

Review cart → continue to Landmark checkout manually
```

This is a product outcome, not a prescribed UI or data schema. A partially fulfilled list must remain visibly partial.

## Behavioural principles

- **Assistant, not blind automation:** correctness and inspectability matter more than appearing autonomous. Ask for review rather than risk a materially wrong purchase.
- **Explicit assumptions:** choosing an unspecified brand, size, or variant is a preference decision. Make that choice and its basis visible; inference is not an explicit user instruction.
- **Respect constraints:** never silently broaden brand, variant, quantity, or size. Confidence does not justify violating an explicit requirement. An explicit no-substitution restriction must be revised before a conflicting alternative becomes selectable.
- **Bounded model authority:** in V1, the LLM makes proposals without retailer tools; application code owns discovery, independent matching checks, and approved execution. Missing or conflicting product evidence is not an unspecified preference or something confidence can repair. See [ADR-0007](docs/adr/0007-proposal-only-llm-with-independent-matching-gates.md).
- **Conservative substitution:** a close substitute is not the requested product. In V1, substitutions need explicit selection and approval; policy-based substitution consent is a future consideration.
- **Traceable outcomes:** connect each request to candidates, decisions, approvals, cart changes, and verification. Unavailable or unsafe matches remain visible rather than disappearing.
- **Preference learning:** repeated approvals may eventually become remembered preferences. Repeatedly approving Arla Full Cream 1L for “full cream milk” could make a later “milk” request higher-confidence. Preferences must remain overrideable, context-sensitive, and subordinate to current explicit instructions; repetition is not blanket substitution consent.

## Confidence and review model

These are working product labels, not numeric thresholds or a scoring algorithm. V1 separates classification from permission to execute, as established in [ADR-0002](docs/adr/0002-separate-match-classification-from-execution-approval.md).

| Label | Meaning | Expected treatment |
| --- | --- | --- |
| Green | High-confidence match to the request; e.g. a verified corresponding product for “Highlands Corned Beef 150g x2”, without unresolved material assumptions. | May be preselected, but requires explicit plan approval before execution. |
| Yellow | The request can be satisfied, but an unspecified preference was chosen; e.g. a brand/size for “full cream milk”, equivalent variants, or a price/value/quality choice. | Show the recommendation and assumption; require explicit selection before inclusion in the plan approved for execution. |
| Orange | A meaningful substitution; e.g. proposing another brand when Highlands is unavailable. | Require explicit selection before inclusion in the plan approved for execution. |
| Red | No sufficiently safe match: unavailable with no safe alternative, unrelated results, conflicting critical attributes, or unsafe ambiguity. | Do not silently add anything; leave unresolved and explain why. |

Unavailable requested products may lead to an orange substitution proposal or a red unresolved item; availability alone does not authorise a replacement. A sole candidate with an unresolved package-size preference remains yellow, not green. Users may approve a selected subset while excluded requests remain visibly unfulfilled. Detailed approval binding and confidence calibration remain open for design.

## Scope

- V1 serves one operator using one intended Landmark account and one configured branch/location context; see [ADR-0004](docs/adr/0004-single-user-fixed-context-and-one-cart-changing-run.md).
- V1 runs on the operator's computer with a local browser review UI. Closing that review tab does not cancel approved work while the backend remains running; see [ADR-0005](docs/adr/0005-local-browser-ui-with-backend-owned-execution.md).
- Initially support Landmark catalogue discovery, requirement interpretation, matching, review, approved cart population, and verification.
- Make requested quantities, package sizes, assumptions, alternatives, and unresolved items understandable to the user.
- Finish with a prepared, verified cart and manual checkout handoff. Verification covers the approved work without silently discarding pre-existing cart contents.
- The user logs in directly and takes over checkout in a dedicated retailer browser session. At handoff, retailer automation stops; subsequent manual activity is neither monitored nor repaired by the assistant. See [ADR-0006](docs/adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md).

## Non-goals

- Learned preferences, purchase history, concurrent planning, automatic recovery, and continuation of interrupted runs after backend restart in the first usable slice; see [ADR-0008](docs/adr/0008-minimal-durable-state-without-crash-resume.md). Minimal durable safety records are still required.
- Household collaboration, independent-user accounts, multi-account switching, or per-run/automatic branch selection in V1.
- Automatically submitting the final order or payment in the initial product.
- Maximising list completion through unapproved guesses or substitutions.
- Granting the model unrestricted browser or network action authority.
- Guaranteeing retailer inventory or undocumented endpoint stability.
- Delivering a universal retailer framework or remote/phone access in V1.

## Success criteria

- Explicit product requirements and quantities survive interpretation and matching without silent changes.
- Every proposed choice has an inspectable rationale and review status; assumptions and substitutions are visible before execution.
- Only approved choices are added, and resulting products and quantities are verified against the plan.
- Failures, unsafe matches, and cart discrepancies are reported honestly rather than counted as successful fulfilment.
- Routine shopping requires less repeated effort while uncertain decisions remain under user control.
- No final order or payment is submitted by the initial system.

Measurable acceptance targets and evaluation methods belong in later product specifications.

## Longer-term direction

Learn repeat preferences with user control, improve recommendation quality and review efficiency, and consider additional retailer integrations when justified by real needs. Any expansion into checkout automation requires a separate, explicitly approved architecture decision and evidence that the added authority is safe.

The MVP architecture interview is complete. Remaining implementation choices and investigations are tracked in the [question backlog](docs/architecture/adr-questions.md); they are not all prerequisites to building the first safe vertical slice.
