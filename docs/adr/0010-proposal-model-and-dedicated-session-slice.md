# ADR-0010: Add a proposal-only model boundary and dedicated retailer session to the review slice

## Status

Proposed. This records the stack chosen to build the second implementation slice (ticket 03). It does not authorise live cart writes, and it does not settle the live discovery/mutation contract that ticket 02 still has to verify.

## Context

[ADR-0007](0007-proposal-only-llm-with-independent-matching-gates.md) requires a proposal-only model with no retailer tools and application-owned discovery and validation, but leaves the provider, prompts, schema, and budgets open. [ADR-0006](0006-dedicated-retailer-session-with-human-login-and-handoff.md) requires an isolated retailer session with direct human login and best-effort protected sign-in reuse, but leaves the browser library, storage mechanism, and protection details open. [ADR-0009](0009-rehearsal-slice-implementation-stack.md) chose a dependency-free Node.js rehearsal and explicitly deferred the live browser and model.

Ticket 03 asks the review slice to use observed catalogue/detail reads in a verified context, a configured model that only proposes, endpoint-aware identity/money normalization, and retained local sign-in separate from the safety journal. The signed-in context is not yet verified (ticket 02 is blocked on the operator's live run), so the live paths must fail closed rather than guess.

## Decision

For the review slice only:

1. **Model provider.** One OpenAI-compatible `/chat/completions` adapter, configured by `MODEL_BASE_URL`, `MODEL_API_KEY`, and `MODEL_NAME`. It sends no tools and a JSON response format, and works with OpenAI, Azure, or a local OpenAI-compatible server. A deterministic `controlled` proposer is the offline stand-in for tests and the demo; it is labelled as such and is not a model. When no provider is configured the run is recorded as an `offline fallback`.
2. **Independent validation lives in the application.** Providers return raw proposals. `validateProposal` and `validateRankings` in application code own structure checks, candidate-reference checks against discovered evidence, explicit-quantity and no-substitution cross-checks, and bounded field sizes. An omitted line stays visible and unresolved; a dropped restriction is restored; an invented product id is dropped. Model failure creates no run. Model-call attempts are bounded per proposer instance.
3. **Dedicated retailer session.** The backend owns a Playwright persistent context in an isolated profile under `.local/retailer-session/profile` with `0700` permissions, separate from the safety journal and never written to logs or model context. The browser library is imported lazily, so the dependency-free rehearsal runs without Playwright installed. Reads are gated on a verified account/branch; the real driver reports account/branch unknown until ticket 02 evidence establishes them, so the gate stays closed.
4. **Endpoint-aware normalization.** Product identity and money are normalized explicitly per observed route (search, detail, cart) in `src/retailer/normalize.js`. String and number ids are canonicalized; minor-unit and major-unit money are read according to the observed representation, and an unknown currency without a minor unit is left unresolved. Provenance and conflicts are preserved; a search hit is not treated as proof of identity or stock.
5. **Secrets.** Model credentials come from environment variables; retained sign-in lives under the gitignored `.local/` with restrictive permissions. Passwords, verification codes, header/nonce values, and account data never reach the model, journal, or committed files.
6. **No live write entry point.** This slice exposes no retailer mutation path. It ends at a reviewed, recorded approval; the UI and API never claim a real cart has been prepared.

## Consequences

- The review slice is usable offline with the controlled stand-in and fails closed on live context until ticket 02 is complete.
- The store validates provider output a second time, so a buggy or malicious provider cannot bypass the gates by returning pre-validated-looking items.
- Playwright remains an optional, `--no-save` dependency; tests exercise the session logic through an injected driver.
- The live discovery, mutation, and session-expiry behaviours remain unverified and are not established by this record.
- Provider prompts, evaluation, and false-green calibration remain open, as ADR-0007 states.

## Alternatives considered

- **Anthropic Messages API adapter:** deferred; one OpenAI-compatible adapter covers the current need and local servers.
- **Trusting provider-side validation:** rejected; application code must validate independently (ADR-0007).
- **App consuming redacted probe evidence files instead of owning the session:** not selected for the app boundary; the probe remains investigation tooling, and the app owns its session per ADR-0006.
- **Storing secrets in the OS keychain:** deferred; environment variables plus gitignored local state are sufficient for the single-user local slice.
- **Enabling live reads before ticket 02 evidence:** rejected; the session gate reports the account/branch as unknown and stays closed.
