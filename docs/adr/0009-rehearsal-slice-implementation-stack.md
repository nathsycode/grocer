# ADR-0009: Use a dependency-free Node.js rehearsal slice

## Status

Proposed. This records the stack chosen to build the first implementation slice (ticket 01). It does not select the stack for the later live-retailer or model slices.

## Context

[ADR-0001](0001-requested-quantities-as-cart-targets.md) through [ADR-0008](0008-minimal-durable-state-without-crash-resume.md) accept the V1 behaviour but deliberately choose no runtime, framework, store, or model. The [first build sequence](../architecture/README.md#first-build-sequence) and ticket 01 ask for one vertical slice using clearly labelled synthetic catalogue/cart data with no live retailer or model calls. The rehearsal needs to demonstrate approval binding, a durable journal, single execution ownership, restart inspection, and fail-closed storage behaviour without pulling in technology the later slices have not chosen.

The [architecture hypotheses](../architecture/README.md#current-hypotheses--not-decisions) name TypeScript/Node, Playwright, and SQLite as candidates. Playwright is only needed for the live dedicated retailer session ([ADR-0006](0006-dedicated-retailer-session-with-human-login-and-handoff.md)) and SQLite is a preference/history candidate; neither is required by a synthetic rehearsal.

## Decision

For the rehearsal slice only:

1. **Runtime:** Node.js (>= 20) using only built-in modules (`node:http`, `node:fs`, `node:path`, `node:crypto`, `node:test`) as ES modules. No runtime or build dependencies.
2. **Durability:** an append-only JSONL safety journal with `fsync` on each append, plus an exclusive lock file (`open(..., 'wx')`) for cross-process execution ownership. The journal is the source of truth; run state is folded from its records.
3. **Simulator:** a local JSON file representing the synthetic retailer cart and an idempotency-keyed operation log. It is pure local state and performs no network access.
4. **Review UI:** hand-written HTML, CSS, and browser JavaScript served by the same backend. No framework, bundler, or client dependency.
5. **Local access boundary:** the backend binds `127.0.0.1`, rejects non-loopback `Host`/`Origin`, and requires a per-session CSRF token on state-changing requests. No browser-automation, shell, or arbitrary network interface is exposed.
6. **Interpretation and matching:** deterministic application code, not a model. This stands in for the proposal-only LLM of [ADR-0007](0007-proposal-only-llm-with-independent-matching-gates.md) so that review, approval, and execution can be rehearsed without model calls.

The simulator is the smallest test/demo boundary for the later slices; it is not a second product and must not grow into one.

## Consequences

- There is no install or build step; the slice runs on a stock Node.js.
- An append-only JSONL journal is inspectable but is not a query engine. If inspection needs outgrow linear reads, a store choice can be revisited later.
- The deterministic interpreter does not exercise prompt-injection, extraction-omission, or model-failure behaviour; those remain to be covered when a real proposal-only model is introduced.
- The stack choice for live work — browser/session automation, session-state storage, model provider, and any persistent preference store — remains open and is not settled by this record.
- Hand-written UI keeps dependencies at zero at the cost of more markup and event wiring than a framework would provide.

## Alternatives considered

- **TypeScript with a build step:** deferred; no type surface yet justifies the toolchain for this slice.
- **SQLite for the journal:** deferred; append-only JSONL already provides the required durability, inspectability, and fail-closed unreadable-file behaviour.
- **Express or another HTTP framework:** not needed; `node:http` covers the handful of local routes.
- **A frontend framework:** not needed; the review UI is a single page with a small amount of state.
- **Playwright for the simulator:** rejected for this slice; it would imply a browser boundary the rehearsal does not have.
