# ADR-0007: Use a proposal-only LLM with independent matching gates

## Status

Accepted

Explicitly accepted by the project owner in the architecture interview after reviewing the rules and consequences. This decision defines authority and review boundaries, not a model provider, scoring algorithm, or implementation stack.

## Context

[GOAL.md](../../GOAL.md) requires explicit constraints to survive interpretation and matching. [ADR-0002](0002-separate-match-classification-from-execution-approval.md) separates classification, selection, and approval; confidence cannot grant cart authority.

The owner selected:

- A proposal-only model, with application-controlled discovery and execution.
- Explicit request revision before relaxing a stated no-substitution restriction.
- Resolved retailer evidence, rather than human attestation alone, before selecting a candidate with conflicting product identity/size data.
- Review of original text, interpreted constraints, and assumptions within plan review, without a mandatory separate interpretation-confirmation stage.

A deterministic checker cannot enforce a restriction absent from its input. Schema validity and a high model confidence score are not proof that extraction preserved the user's meaning. Likewise, retailer data is evidence to evaluate, not instructions to obey or a guaranteed source of consistent attributes.

## Decision

1. **Limit the LLM to proposals.** It may interpret requests, suggest search queries, rank supplied candidates, and propose classifications and concise rationales. It has no retailer search, browser, HTTP, or cart-action tools. Application code controls discovery, further evidence retrieval, validation, approval, execution, and reconciliation. Suggested queries are data for application-controlled discovery, not permission for arbitrary actions.
2. **Preserve and expose interpretation.** Keep original request text distinguishable from extracted requirements, inferred preferences, and unresolved interpretation. At plan review, show the source text and interpreted brand, variant, package size, quantity, and restrictions beside the proposed choice, including material assumptions. Allow correction and reevaluation before approval. A changed request cannot inherit approval for the affected old choice merely because its candidate is unchanged.
3. **Enforce independent validation gates.** Treat model output as untrusted proposals. Application code checks its structure, candidate references against discovered evidence, and applicable deterministic constraints. Invalid output or an invented/unobserved product reference cannot become executable merely because the model provides a plausible explanation. Missing facts must not be silently filled from model knowledge; the model cannot resolve contradictory retailer identity/size data by assertion.
4. **Separate evidence, constraints, and preference choices.** Distinguish a supported match, a known mismatch, and missing/conflicting evidence. A known material difference may be an orange substitution only where the request permits offering one and candidate identity is sufficiently established. Choosing an unspecified preference remains yellow under ADR-0002. An unresolved material identity/size conflict remains non-selectable; obtain retailer evidence that resolves it rather than disguising it as a yellow preference choice. Ordinary selection, plan approval, or human attestation alone does not waive that evidence requirement.
5. **Honour explicit prohibitions.** When the user says “Highlands only—no substitutions,” another brand is not a selectable orange choice under that request. Leave the item unresolved unless the user explicitly revises the restriction. Reevaluate the revised request, then apply normal classification, selection, and approval rules. Do not add a separate constraint-exception approval path in V1. A brand specified without a no-substitution prohibition can still have a visibly different, explicitly selected orange alternative under existing policy.
6. **Keep deterministic checks outside model judgement.** Code owns enforceable attribute comparisons, unambiguous unit conversion, package/quantity distinctions, and eligibility restrictions. For example, 0.5kg and 500g are equivalent mass descriptions; two 250g packages are not an exact match to one 500g package merely because their masses sum equally. Model ranking or confidence cannot overrule a failed gate. Passing all implemented gates is necessary, not sufficient, for green classification; detailed semantic-equivalence rules, scoring, and calibration remain open.
7. **Keep execution authority separate.** Neither model output nor successful matching creates approval, changes quantities, or bypasses execution pauses. [ADR-0001](0001-requested-quantities-as-cart-targets.md), ADR-0002, and [ADR-0003](0003-pause-on-invalid-approval-or-uncertain-mutations.md) continue to govern targets, approval, and uncertainty. Retailer text cannot alter these rules or become instructions to the application. A proposal-only boundary reduces action exposure but does not by itself eliminate prompt-injection or interpretation risks.

### Concrete cases

These are hypothetical policy examples, not verified Landmark capabilities.

| Situation | Required treatment |
| --- | --- |
| “Highlands only—no substitutions”; only CDO found | Unresolved under the current request; explicit request revision is needed before CDO can become selectable. |
| “Highlands 150g”; a clearly identified 260g product is available | Not an exact/green size match; may be proposed as an orange alternative absent a prohibition, with explicit selection and plan approval. |
| Candidate title says 150g but another supplied size attribute says 260g | Non-selectable until retailer evidence resolves the conflict; model confidence or a generic approval cannot choose which claim to trust. |
| User omitted size; candidate's own size is established | Yellow preference choice, not the evidence-conflict case above. |
| Model silently omits “no substitutions” during interpretation | A valid schema does not make the extraction correct. Preserve source text and expose interpreted restrictions in review; do not claim deterministic validation catches every semantic omission. |
| Model names a product ID absent from discovered candidate evidence | Do not accept it as a validated candidate. Discovery/evidence, not model invention, must establish the reference. |

## Consequences

- Matching has an explicit responsibility boundary between model suggestions and application enforcement; this does not require separate services or prescribe a schema.
- Candidate data needs provenance and a representation of missing/conflicting attributes. The normalized fields, source-precedence rules, and evidence sufficient to resolve conflicts still need investigation and design.
- Original text and interpretation must remain inspectable alongside choices. This trades review space for detection of extraction errors without an extra mandatory confirmation stage.
- Source references and schema checks help inspectability but cannot prove complete semantic preservation. Extraction evaluation, omitted-restriction cases, and false-green tests remain necessary; human review also is not a correctness guarantee.
- V1 may leave more items unresolved instead of accepting unsupported model knowledge or a human evidence waiver. The operator can still point the application toward retailer evidence, subject to safe application-controlled retrieval; a manual resolution workflow is not selected here.
- Provider/model, prompts, structured-output schema, query budgets, model-error handling, retry limits, normalization vocabulary, semantic-equivalence policy, scoring thresholds, and data retention remain open.
- This is documentation only. No model integration, test tooling, retailer action, or implementation is introduced.

## Alternatives considered

- **Restricted model discovery tools:** not selected for V1; suggested queries remain proposals executed under application control.
- **Approval-gated model cart tools:** not selected; the application owns execution without model tool calls.
- **Model confidence overrides deterministic failures:** rejected; confidence is not evidence or authority.
- **Dedicated approval to override “no substitutions”:** not selected; revise the request explicitly instead.
- **Human attestation resolves contradictory product facts:** not selected; require retailer evidence resolving the conflict.
- **Mandatory interpretation confirmation before matching:** not selected; interpretation is inspectable and correctable within plan review.
