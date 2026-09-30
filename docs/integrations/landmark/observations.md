# Landmark observations

**Observed, not guaranteed.**

## Provenance and limits

Source: manual browser inspection reported by the project owner in the bootstrap brief. These observations were transcribed here; this bootstrap did not make network requests or independently reproduce them. Inspection date, branch/location, authentication state, request headers, cookies, and complete payloads were not supplied.

Landmark's frontend exposes internal HTTP cart endpoints despite no documented public integration API being identified in the supplied investigation. This is evidence of frontend behaviour, not a claim of public support, stability, or exhaustive API discovery.

## Observed endpoints

```text
GET https://www.landmark.ph/api/cart
POST https://www.landmark.ph/api/cart/item
```

The GET endpoint was observed for cart access and the POST endpoint for a cart-item operation. No request body, required headers, response status guarantees, or retry/idempotency behaviour is established here. The GET response schema was not supplied.

## Reported cart-item response excerpt

An observed cart-item response included data resembling the following; this is an illustrative excerpt, not a complete captured contract or validated test fixture:

```json
{
  "key": "e3efe0ad5b37b75621ec60cc1d3176ef",
  "id": 39943,
  "type": "simple",
  "quantity": 1,
  "name": "McCormick Italian Seasoning 200g",
  "sku": "TNM-5263",
  "prices": {
    "price": "46900",
    "currency_code": "PHP",
    "currency_minor_unit": 2
  }
}
```

## Response-shape observations and limits

- Product ID (`id`) and cart-line key (`key`) are separate concepts and appear as separate fields. Their equality, derivation, or interchangeability must not be assumed.
- The excerpt includes type, quantity, name, SKU, and price metadata. A single `simple` example does not establish variant handling or general field guarantees.
- Prices appear to use minor currency units: `price` is a string, with PHP and a minor-unit exponent of 2. Under that interpretation, `"46900"` represents PHP 469.00. This is not a guarantee about all monetary fields, tax treatment, or current pricing.
- The shape strongly resembles WooCommerce cart/store representations. That resemblance is an investigation clue, not confirmation of backend implementation, API version, or compatibility with other WooCommerce routes.

## Subsequent read-only investigation

The [2026-09-29 anonymous probe](read-only-probe-2026-09-29.md) independently observed search, simple-product detail, and an empty anonymous cart read. It records actual routes, the public-header comparison, and differing ID/price representations without retaining header or nonce values. It does not verify the operator's account/branch, populated cart lines, or mutations. The original owner-reported evidence above remains separate.

The [signed-in read-only probe procedure](signed-in-read-probe-procedure.md) was attempted on [2026-09-30](signed-in-read-probe-2026-09-30.md). The operator confirmed the intended account, and a product-detail read succeeded, but no cart read or cart-line correspondence was captured. A cart batch POST was blocked. Operator-reported accidental removals have unresolved timing and outcome; no restoration was attempted. This partial evidence does **not** verify signed-in cart integration, account/branch mapping, or mutation semantics.

## Investigation checklist — not established in full

Some discovery and anonymous-read behaviour now has preliminary evidence in the probe; unchecked entries remain incomplete, not necessarily wholly uninvestigated.

- [ ] Product search endpoint: route, method, query behaviour, pagination, and response shape.
- [ ] Product detail endpoint: identity, attributes, pricing, and relation to search results.
- [ ] Location/branch selection: how selection is established and affects catalogue/cart state.
- [ ] Session/cookies: establishment, scope, expiry, and renewal.
- [ ] Authentication requirements: guest vs signed-in discovery and cart operations.
- [ ] Cart quantity update: route, payload, quantity semantics, and outcome verification.
- [ ] Cart item removal: route, identifier requirements, and safe verification.
- [ ] Inventory representation: availability, stock limits, freshness, and location dependence.
- [ ] Variant handling: parent/variant IDs, selectable attributes, and cart identity.
- [ ] Checkout handoff: how the prepared cart reaches manual checkout without order submission.
- [ ] Rate limiting: documented or observed limits and retry signals.
- [ ] CSRF/nonces: required protections, acquisition, scope, and lifetime.
- [ ] Bot/WAF behaviour: observed challenges and constraints; do not assume unattended access works.
- [ ] Failure/error response shapes: status codes, partial failures, and ambiguous mutation outcomes.
- [ ] Full cart response and mutation semantics: totals, line-key stability, duplicate additions, and idempotency.

Future entries should include reproducible context and redacted evidence. Keep open questions separate from verified findings; no unobserved endpoint shapes are implied by this checklist.
