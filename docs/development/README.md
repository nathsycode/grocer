# Development

## Current state

The repository now contains the first implementation slice (ticket 01): a local rehearsal of review → explicit approval → simulated cart change → verification. It uses **only synthetic catalogue and cart data** and makes **no live retailer or model calls**. The simulator is a local JSON file and cannot reach Landmark.

The rehearsal stack is recorded in [ADR-0009](../adr/0009-rehearsal-slice-implementation-stack.md) (Proposed). Live-retailer, session, and model stacks remain unchosen.

Read [AGENTS.md](../../AGENTS.md) before changes. The accepted decisions in [ADR-0001](../adr/0001-requested-quantities-as-cart-targets.md) through [ADR-0008](../adr/0008-minimal-durable-state-without-crash-resume.md) govern behaviour; the rehearsal implements them against synthetic data only.

## Setup

Node.js >= 20. There is no install or build step and no runtime dependency.

```sh
npm start     # launch the local backend and review UI on http://127.0.0.1:4180/
npm run demo  # run the full sample flow headlessly and print the trace
npm test      # run the offline automated checks (node:test)
```

Environment overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4180` | loopback port for the review UI |
| `REHEARSAL_DATA_DIR` | `.local` | local journal, lock, and simulator state |
| `REHEARSAL_STEP_DELAY_MS` | `250` | per-mutation delay so execution progress is visible |

## Layout

| Path | Responsibility |
| --- | --- |
| `src/catalog.js` | synthetic catalogue and size/money helpers |
| `src/domain.js` | deterministic interpretation, matching gates, plan, verification |
| `src/journal.js` | append-only durable safety journal and exclusive execution lock |
| `src/simulator.js` | local simulated retailer cart with idempotency-keyed operations |
| `src/store.js` | orchestration, run state, one cart-changing execution owner |
| `src/server.js` | loopback HTTP surface with Host/Origin/CSRF guards |
| `public/` | hand-written review UI |
| `scripts/demo.js` | reproducible sample flow |

## Local state and safety

- `.local/` is gitignored. It holds `journal.jsonl` (the safety journal), `execution.lock`, and `simulator.json` (the fake retailer).
- Deleting `.local/` is a fresh start. Do **not** delete it to escape a blocked run: an unresolved mutation attempt is intentionally retained and must be resolved through read-only reconciliation. Deleting history is exactly the force-unlock shortcut the design forbids.
- The backend binds `127.0.0.1` and rejects non-loopback `Host`/`Origin` and missing CSRF tokens on state-changing requests. No browser, shell, or arbitrary network interface is exposed.
- There is no order or payment path. Cart actions reach only the local simulator.

## Validation

`npm test` runs offline. It covers the sample flow, no-op rerun, unapproved and approved reductions, approval binding and reevaluation, duplicate execution, cross-process execution ownership, storage failure before and after dispatch, tab disconnection, backend restart, uncertain outcomes, and unreadable journal state. Tests inject faults locally and have no retailer effects.

There are no live-retailer tests; the live slices are not implemented. Do not describe the rehearsal as a verified real cart.
