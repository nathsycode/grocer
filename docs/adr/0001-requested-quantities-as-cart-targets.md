# ADR-0001: Interpret requested quantities as cart targets

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This record specifies domain semantics, not an endpoint, persistence schema, or mutation algorithm.

## Context

[GOAL.md](../../GOAL.md) requires approved cart preparation and verification without silently discarding pre-existing contents. A request such as “Highlands Corned Beef x2” could mean adding two units or reaching two units in the cart. These interpretations produce different outcomes when the product is already present.

In the interview, the project owner chose:

- Two in total when one unit of the exact selected product is already present.
- Explicit approval before reducing an existing quantity that exceeds the request.
- Preserving a different package size separately, without counting it toward an explicitly requested size.

Landmark's full cart schema, quantity update behaviour, and variant identity remain [uninvestigated](../integrations/landmark/observations.md). The examples below are hypothetical domain cases, not verified integration capabilities.

## Decision

For a requested item with a resolved product and quantity:

1. Interpret the requested quantity as the desired total of that exact selected product/configuration in the cart, not as an increment.
2. Count existing units only when their product identity and configuration are verified to match the selection. Do not equate products merely by brand or similar names.
3. Include any shortfall in the proposed plan. Additions still require the applicable approval; this quantity rule does not independently authorise execution.
4. When the existing quantity exceeds the target, propose the reduction and require explicit approval of that reduction. General permission to add groceries does not authorise removal. Without approval, retain the existing quantity and report the discrepancy.
5. Preserve unrelated products and different configurations, including different package sizes, as separate pre-existing contents. Make these extra contents visible; do not count them toward or silently remove them to satisfy the request.
6. Verify against the desired total, not simply against the number of units added. Repeating the same request against an unchanged cart already at its target requires no further addition.

### Concrete cases

| Request | Existing cart contents | Planned outcome |
| --- | --- | --- |
| Exact product x2 | Same product x1 | Propose adding one to reach two. |
| Exact product x2 | Same product x2 | No quantity change needed. |
| Exact product x2 | Same product x3 | Propose reducing to two; execute the reduction only with explicit approval. Otherwise keep three and report excess. |
| Highlands Corned Beef 150g x2 | Highlands Corned Beef 260g x1 | Propose two 150g cans; preserve and show the separate 260g can. |

All cases assume verified identity and otherwise unchanged session/cart context. They do not grant permission for live-site actions during the documentation session.

## Consequences

- The plan needs to express desired totals and distinguish proposed additions from reductions; a list of blind “add N” commands is insufficient.
- An approved target is not evidence that it was achieved. Unapproved excess quantities remain visible discrepancies.
- Cart readiness must distinguish fulfilled requests from extra pre-existing contents; satisfying the list does not mean the cart contains only the list.
- No-op behaviour on an unchanged rerun is a domain requirement, not a claim that mutation retries are idempotent. Ambiguous responses and concurrent edits require a separate execution decision.
- Exact identity resolution, duplicate request lines, explicitly worded “add two more” requests, approval presentation, and changes between planning and execution remain open questions. This ADR does not settle them.

## Alternatives considered

- **Treat quantities as additions:** rejected for the default list semantics because the owner expects two total, not three, when one is already present.
- **Ask about every overlap:** not selected as the default; the chosen meaning is a desired total. Identity uncertainty can still require review.
- **Require an empty cart:** not selected; the desired behaviour accounts for existing contents without clearing them.
- **Automatically reduce excess quantities:** rejected without explicit approval of the reduction.
- **Never offer reductions:** not selected; an explicitly approved reduction may satisfy the target, subject to a safely implemented integration.
- **Count a different package size toward the request:** rejected for the explicit-size example. A substitution would require its own reviewed change of selection.
