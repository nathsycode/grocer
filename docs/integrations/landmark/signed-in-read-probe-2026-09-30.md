# Signed-in read-only probe attempt — 2026-09-30

Status: **attempted; insufficient evidence to verify signed-in cart integration.**

## Provenance

The operator ran `scripts/landmark-probe.js` in its dedicated browser and supplied
`.local/landmark-probe/evidence/landmark-read-probe-2026-09-30T16-39-57-410Z.json`.
The probe records a start at `2026-09-30T16:32:59.986Z` and finish at
`2026-09-30T16:39:57.410Z`. Inspection was local, using a second redaction pass;
no additional retailer request was made during review. Raw evidence and the
browser profile remain local and are not committed.

## Known observations

- The operator confirmed the intended account and supplied a branch label. This
  is a human assertion, not independently established account/branch detection.
- Capture contains no `GET /api/cart` observation and no cart-line evidence.
- `GET /api/products/47812` returned HTTP 200 JSON, with numeric product ID
  `47812`, SKU `TNM-34960`, type `simple`, and price amount `"205.75"` with
  currency code `"Php"`. This is product-detail evidence only, not verified cart
  correspondence or a complete package/configuration identity contract.
- Related-product reads used `/api/products/related/<ids>/substore/158`.
  That observed route does not establish which configured branch `158` represents.
- `GET /api/checkout/promos2` returned HTTP 200 with an empty JSON array. This
  incidental background read is not evidence of order or payment submission.
- The active guard blocked `POST /api/cart/batch` as a non-read method and
  blocked two cross-origin Facebook POST requests.
- No cart-to-product correspondence was established. The probe reported missing
  cart capture, missing correspondence, and cross-origin blocks.

## Operator-reported incident and uncertainty

The operator reported accidentally removing cart items. The timing relative to
read-only guard activation, and whether a persistent cart change succeeded, are
not yet established. The blocked batch request cannot prove either successful
removal or unchanged cart contents. No original-cart snapshot was captured.
There was no authorised automatic restoration, rollback, or fixture creation.

Possible explanations for missing cart capture include an already-loaded cart
before capture began, cached frontend state, or a different cart-read path.
These are **hypotheses**, not observed contracts. The method and semantics of
`/api/cart/batch` remain unknown; a POST must not be allowed merely because the
frontend uses it while displaying a cart.

## Remaining gate

Ticket 02 stays blocked. First establish the incident timing and resolve any
suspected guard failure before another live run. A separately confirmed narrow
read-only attempt can then capture a fresh cart read and product correspondence
if available, without changing existing contents. Account/branch mapping,
populated-cart semantics, authentication-failure signals, and live cart writes
remain unverified. Do not infer variant, open-weight, package-size, update,
removal, retry, or idempotency semantics from this attempt.
