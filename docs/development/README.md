# Development

## Current state

The repository contains two implementation slices:

- **Ticket 01** — a local rehearsal of review → explicit approval → simulated cart change → verification, using **only synthetic catalogue and cart data** with no live retailer or model calls. The simulator is a local JSON file and cannot reach Landmark.
- **Ticket 03** — an evidence-backed review slice: a proposal-only model boundary, application-controlled discovery and independent validation, endpoint-aware identity/money normalization, and a dedicated retailer-session boundary. It ends at a reviewed, recorded approval; **live cart writes remain disabled**, and the live signed-in context stays unverified until ticket 02 evidence exists.

The rehearsal stack is recorded in [ADR-0009](../adr/0009-rehearsal-slice-implementation-stack.md) (Proposed); the review-slice stack is in [ADR-0010](../adr/0010-proposal-model-and-dedicated-session-slice.md) (Proposed). Read [AGENTS.md](../../AGENTS.md) before changes. The accepted decisions in [ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md) through [ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md) govern behaviour.

## Setup

Node.js >= 20. There is no install or build step and no runtime dependency.

```sh
npm start         # launch the local backend and review UI on http://127.0.0.1:4180/
npm run demo      # run the full sample flow headlessly and print the trace
npm run demo:review  # offline evidence-backed review demo (no model call, no retailer)
npm test          # run the offline automated checks (node:test)
```

Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4180` | loopback port for the review UI |
| `REHEARSAL_DATA_DIR` | `.local` | local journal, lock, simulator, and retained session state |
| `REHEARSAL_STEP_DELAY_MS` | `250` | per-mutation delay so execution progress is visible |
| `MODEL_PROVIDER` | `none` | `openai-compatible` or `controlled`; otherwise the offline fallback |
| `MODEL_BASE_URL` | — | OpenAI-compatible base URL (for example `https://api.openai.com/v1`) |
| `MODEL_API_KEY` | — | model credential; never logged, journalled, or sent to the retailer |
| `MODEL_NAME` | — | model name |
| `MODEL_MAX_CALLS` | `4` | bounded model calls per proposer instance |
| `MODEL_TIMEOUT_MS` | `30000` | per-call timeout |
| `RETAILER_SESSION` | on | set to `off` to disable the dedicated retailer-session surface |
| `RETAILER_ACCOUNT` / `RETAILER_BRANCH` | — | the configured intended context the session must verify against |
| `RETAILER_CHANNEL` | `chrome` | Playwright browser channel |

Playwright is optional and `--no-save`; the rehearsal and tests run without it. Install it only for a live session: `npm install --no-save playwright@1.63.0`.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/catalog.js` | synthetic catalogue and size/money helpers |
| `src/domain.js` | deterministic interpretation, matching gates, plan, verification |
| `src/proposer.js` | proposal-only model boundary and independent validation |
| `src/retailer/normalize.js` | endpoint-aware product identity and money normalization |
| `src/retailer/read-only-guard.js` | shared request/redirect guard for the session and the ticket 02 probe |
| `src/retailer/session.js` | dedicated retailer session, verified-context gate, Playwright driver |
| `src/journal.js` | append-only durable safety journal and exclusive execution lock |
| `src/simulator.js` | local simulated retailer cart with idempotency-keyed operations |
| `src/store.js` | orchestration, run state, one cart-changing execution owner |
| `src/server.js` | loopback HTTP surface with Host/Origin/CSRF guards |
| `public/` | hand-written review UI |
| `scripts/demo.js` | reproducible sample flow (ticket 01) |
| `scripts/review-demo.js` | offline evidence-backed review demo (ticket 03) |
| `scripts/landmark-probe.js` | ticket 02 read-only investigation tooling (not application code) |

## Local state and safety

- `.local/` is gitignored. It holds `journal.jsonl` (the safety journal), `execution.lock`, `simulator.json` (the fake retailer), and `retailer-session/` (retained sign-in, `0700`).
- Retained sign-in is separate from the safety journal and must never reach logs, committed files, or model context. Expiry requires a fresh human login and never restores approval.
- Deleting `.local/` is a fresh start. Do **not** delete it to escape a blocked run: an unresolved mutation attempt is intentionally retained and must be resolved through read-only reconciliation. Deleting history is exactly the force-unlock shortcut the design forbids.
- The backend binds `127.0.0.1` and rejects non-loopback `Host`/`Origin` and missing CSRF tokens on state-changing requests. No browser, shell, or arbitrary network interface is exposed to the model.
- There is no order or payment path, and no live cart-write entry point in the review slice. Cart actions reach only the local simulator.

## Validation

`npm test` runs offline. It covers the sample flow, no-op rerun, unapproved and approved reductions, approval binding and reevaluation, duplicate execution, cross-process execution ownership, storage failure before and after dispatch, tab disconnection, backend restart, uncertain outcomes, unreadable journal state, proposal validation (dropped restrictions, invented ids, explicit brand/size/quantity cross-checks, inferred-vs-explicit attributes, unresolved-item gating), endpoint normalization and evidence conflicts, the shared read-only guard, and the fail-closed retailer-session gate. Tests inject faults locally and have no retailer effects.

There are no live-retailer or live-model tests. The live slices are not implemented, and the signed-in context remains unverified. Do not describe the rehearsal as a verified real cart.
