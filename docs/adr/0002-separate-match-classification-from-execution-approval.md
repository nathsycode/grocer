# ADR-0002: Separate match classification from execution approval

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This record defines V1 review and authorisation behaviour without selecting a UI technology or implementation state machine.

## Context

[GOAL.md](../../GOAL.md) uses green/yellow/orange/red to describe match confidence and required intervention. Its original green example allowed a uniquely corresponding Highlands Corned Beef product, while its yellow examples included choosing an unspecified size. A single discovered result does not by itself establish a user's preference for that size.

Match classification also cannot answer whether the user has authorised a cart change. In the interview, the owner chose:

- Yellow for an unspecified package size even when only one candidate is found and no remembered preference applies.
- Explicit approval of a concrete plan before green additions in V1.
- Separate explicit selection of yellow and orange choices before they are included in the plan approved for execution.

[ADR-0001](0001-requested-quantities-as-cart-targets.md) already requires explicit approval of reductions and defines quantity targets. This decision complements rather than replaces those rules.

## Decision

1. Keep match classification distinct from selection and execution approval. A colour is not mutation authority.
2. When a material preference such as package size is unspecified and no established preference resolves it, choosing it remains a yellow assumption even if discovery yields only one candidate. Candidate uniqueness alone is insufficient to make it green.
3. In V1, require explicit user approval of a concrete selected plan before cart additions, including green additions. Neither list submission nor a green classification is automatic approval.
4. Green matches may be preselected for review. Yellow recommendations and orange substitutions start unselected and require explicit selection of each uncertain choice before inclusion in the plan the user approves.
5. Selecting an uncertain choice does not alone execute it; the user subsequently approves the selected plan. Approval does not erase the choice's original assumption or substitution classification from the trace.
6. Permit execution of an approved subset while other requests remain unselected or unresolved. Show these omissions as unfulfilled, not silently skipped or successfully completed. Red items have no safe selectable match unless a revised choice is evaluated.
7. Preserve ADR-0001's explicit approval requirement for reductions; preselection of a green match does not authorise reducing an existing quantity.

### Concrete cases

| Situation | Review and execution treatment |
| --- | --- |
| “Highlands Corned Beef x2”; only a 260g product is found; no applicable remembered preference | Yellow size assumption; starts unselected. |
| Explicit product, size, and quantity are confidently matched | Green may be preselected, but still waits for plan approval. |
| A yellow recommendation is explicitly selected | Eligible for the selected plan, but not executable until plan approval. |
| Another brand is proposed as an orange substitution | Starts unselected; requires explicit selection and subsequent plan approval. |
| The user approves only the green subset | Execute only that approved subset; report excluded requests as unfulfilled. |

## Consequences

- V1 retains a deliberate approval step even for routine all-green lists, trading some speed for inspectability and control.
- Review must expose concrete products, quantities, assumptions, and substitutions sufficiently for selection and approval; the exact presentation is undecided.
- Classification, selection, and approval must remain distinguishable in the domain model and decision trace; this does not prescribe separate database tables or service components.
- The original green example must be clarified so a sole product result does not conceal an inferred package size.
- Remembered preferences may eventually affect classification, but do not remove V1's explicit plan approval requirement. Criteria for preference-based classification remain open.
- Automatic approval policies or bulk acceptance of uncertain choices are not introduced by this decision; changing V1's rule requires further deliberate agreement.
- Approval binding, expiry, price changes, concurrent edits, and execution-time revalidation remain unresolved and require follow-up design.

## Alternatives considered

- **Treat a sole corresponding candidate as green despite an unresolved size preference:** rejected for the no-preference example because discovery does not establish desired size.
- **Allow green additions automatically on list submission:** rejected for V1 in favour of explicit plan approval.
- **Offer opt-in automatic green approval in V1:** not selected; it can be reconsidered separately after the initial workflow is established.
- **Let one plan approval implicitly include all displayed yellow/orange choices:** rejected; each uncertain choice must first be explicitly selected.
- **Require every request to be resolved or explicitly skipped before any execution:** not selected; a visibly partial approved plan is permitted.
