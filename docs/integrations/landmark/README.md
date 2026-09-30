# Landmark Philippines integration notes

Initial retailer: <https://www.landmark.ph>.

Read [observations.md](observations.md) before investigating or changing integration behaviour. It separates original owner-reported evidence from the [2026-09-29 anonymous read-only probe](read-only-probe-2026-09-29.md) and tracks remaining unknowns. Neither is a supported public API contract.

Keep Landmark-specific endpoint evidence, response examples, session/location findings, and limitations here. Record the source, context, and uncertainty of new findings; redact account/session data from examples. Broader experiments belong in [investigations](../../investigations/README.md), with links rather than duplicate evidence.

Observed anonymous discovery/read routes are recorded in the probe. Mutation payloads, authenticated context, populated cart behaviour, and safe retry semantics remain unverified. Do not infer unobserved endpoints from WooCommerce resemblance.

The [signed-in read-only probe procedure](signed-in-read-probe-procedure.md) is **prepared but not executed**. It defines the repeatable, redacted method for establishing the operator's intended account/branch, populated cart structure, and cart-line-to-catalogue correspondence. Until it is run and its evidence reviewed, the signed-in context remains unverified.

[ADR-0006](../../adr/0006-dedicated-retailer-session-with-human-login-and-handoff.md) establishes the intended dedicated session, human login, best-effort sign-in retention, and stop to retailer automation at manual checkout handoff. This is an accepted design boundary, not evidence that session persistence or browser handoff has been validated.

Direct HTTP access, browser-context requests, browser library, session-storage mechanism, and fallback policy remain open [architecture questions](../../architecture/adr-questions.md). Any future integration work must respect the [agent safety contract](../../../AGENTS.md) and stop before final order/payment submission.
