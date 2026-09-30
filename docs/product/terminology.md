# Working terminology

These terms describe the product, not final types, database entities, or a pipeline architecture. The confidence/review policy is defined in [GOAL.md](../../GOAL.md#confidence-and-review-model).

| Term | Definition |
| --- | --- |
| Requested item | One grocery requirement derived from the user's list, preserving explicit attributes, quantity, and unknowns. Original text remains distinguishable from interpretation and visible during plan review. |
| Explicit prohibition | A stated restriction such as “Highlands only—no substitutions.” Under [ADR-0007](../adr/0007-proposal-only-llm-with-independent-matching-gates.md), a conflicting alternative requires request revision before becoming selectable; ordinary approval does not waive it. |
| Shopping context | The intended retailer account and branch/location context within which discovery, approval, and cart work apply. V1 uses one configured context; its retailer representation remains uninvestigated. |
| Shopping run | One attempt to turn a grocery list into a reviewed, approved, and verified cart outcome. It is not the review tab's lifetime; closing the tab does not cancel it under [ADR-0005](../adr/0005-local-browser-ui-with-backend-owned-execution.md). Detailed recovery remains undecided. |
| Review UI | The assistant's local browser interface for inspecting choices, selecting uncertain items, approving plans, and viewing run state. Distinct from the retailer interaction session and manual checkout page. |
| Dedicated retailer session | A Landmark browser session isolated from everyday browsing, used for direct human login, approved cart work, and manual checkout. V1 attempts protected local sign-in reuse; the persistence mechanism remains undecided. |
| Session state | Browser/session data that may maintain retailer access. It is sensitive and distinct from a shopping run's approval, execution history, or proof of purchase. |
| Manual checkout handoff | Transfer of a safely prepared, verified cart to the user in the dedicated retailer session. Automated retailer reads, navigation, and mutations stop for that run under [ADR-0006](../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md). |
| UI disconnection | Loss of the review page's connection to the still-running backend, including tab closure. It does not cancel approved work, grant new approval, or release execution ownership. |
| Execution ownership | The exclusive right of one cart-changing run to execute against the configured cart. An unresolved pause does not release it; see [ADR-0004](../adr/0004-single-user-fixed-context-and-one-cart-changing-run.md). This does not lock out manual retailer edits. |
| Target quantity | The desired total of the exact selected product/configuration in the cart, including verified matching units already present; not the number to add. See [ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md). |
| Pre-existing cart contents | Products and quantities present before the proposed shopping changes; matching units can contribute to a target, while unrelated products and different configurations remain separate. |
| Candidate | A discovered retailer product being evaluated for a requested item; discovery is not approval. |
| LLM proposal | Model-produced interpretation, query, ranking, classification suggestion, or rationale. It is subject to application validation and grants no retailer-action authority. |
| Matching gate | An application-enforced evidence or constraint check that model judgement cannot override. Passing gates is necessary, not sufficient, for green classification. |
| Evidence conflict | Contradictory claims about a candidate's material attributes. Unresolved identity/size conflicts make the candidate non-selectable until retailer evidence resolves them, unlike an unspecified user preference. |
| Match | An assessed relationship between a requested item and a candidate, including relevant constraints and uncertainty; not necessarily permission to add it. |
| Recommendation | A proposed choice with its rationale and visible assumptions, commonly used when an unspecified preference must be resolved. |
| Substitution | A proposed product that meaningfully differs from the request, such as a different brand when a brand was specified. It is not an exact match. |
| Cart line | An entry in the retailer cart representing a product/configuration and a quantity. It is distinct from the original grocery request. |
| Product ID | A retailer identifier for a catalogue product. Its relationship to variants still requires investigation. |
| Cart-line key | An identifier for a particular cart entry, separate from the product ID. Landmark key generation, lifetime, and stability are not yet established. |
| Green | A high-confidence match with no unresolved material assumptions; may be preselected but requires explicit plan approval in V1. |
| Yellow | A satisfiable request requiring an unspecified preference choice; assumptions must be visible. |
| Orange | A meaningful substitution proposal; in V1 it starts unselected and requires explicit selection before inclusion in the approved plan. |
| Red | No sufficiently safe match; leave unresolved rather than silently adding a product. |
| Selection | Inclusion of a concrete choice in the plan presented for approval; not permission to execute it. Green may be preselected, while yellow/orange require explicit selection in V1. |
| Plan approval | The user's explicit authorisation to execute the concrete selected plan in V1, separate from match classification and selection; see [ADR-0002](../adr/0002-separate-match-classification-from-execution-approval.md). |
| Approved plan | The selected products, target quantities, and intended cart changes explicitly authorised by the user in V1. Unapproved proposals are not executable parts of the plan; reductions of existing quantities require explicit approval under [ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md). |
| Reconciliation | Comparing actual cart state with the approved plan, accounting for pre-existing contents, and reporting discrepancies. The comparison itself does not authorise corrective mutations. |
| Approval validity | Whether newly observed conditions still fall within the reviewed permission to execute. Price increases and expansion of an approved addition require reapproval under [ADR-0003](../adr/0003-pause-on-invalid-approval-or-uncertain-mutations.md). |
| Unknown mutation outcome | Insufficient evidence to determine whether a cart-changing request applied or may still apply; a timeout is not proof of failure. |
| Observed target satisfaction | A verified cart observation matches the selected product/configuration and target quantity. It does not establish which request caused that state or guarantee no later change. |
| Execution pause | A stop to issuing further cart mutations while retaining and checking actual state. It does not cancel in-flight retailer operations or authorise rollback or retry. |
| Safety journal | Minimal durable records of requests, reviewed choices, approval, relevant observations, mutation attempts/outcomes, and execution ownership. Under [ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md), intent is recorded before dispatch; the journal supports inspection and reconciliation, not automatic replay or proof of purchase. |

Package size describes the contents of one purchased unit; quantity describes how many units are requested. For example, “Fusilli pasta 500g x2” specifies both rather than a single 1kg package.
