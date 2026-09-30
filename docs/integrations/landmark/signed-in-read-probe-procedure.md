# Landmark signed-in read-only probe — procedure

Status: **prepared, not executed.** No signed-in evidence exists yet. This page
describes a repeatable, read-only procedure and the evidence it produces. It
records no live observation; do not read it as verification of the operator's
account, branch, or cart.

Purpose: complete the ticket 02 investigation gate (see
`.scratch/grocer-mvp/issues/02-verify-signed-in-context-and-cart-reads.md`,
local-only) by connecting the operator's actual signed-in shopping context to
catalogue and cart reads, and by capturing enough observed structure for the
application to distinguish a known cart from an uncertain one.

Scope: reads only. No additions, removals, quantity changes, account/location
changes, order or payment actions, and no automatic retry of a write. A later
mutation experiment needs its own explicit scope and approval.

## Authorisation and human prerequisites

Live interaction waits for the operator to explicitly resume the paused
investigation. Do not open a browser or run the probe merely because this
procedure exists.

Before running:

- The operator is at the keyboard for the whole run.
- The operator knows the intended Landmark account and branch/location, and
  will confirm both on screen.
- Sign-in and any verification codes happen **in the browser**, never in the
  terminal, chat, prompts, fixtures, or logs.
- The everyday browser profile is not used. The probe creates its own isolated
  persistent profile under `.local/` (gitignored).

## Setup

The probe is investigation tooling, not application code, and adds no project
dependency. Playwright is installed without touching `package.json`:

```bash
npm install --no-save playwright@1.63.0
# only if not using the system Chrome channel:
npx playwright install chromium
```

## Procedure

```bash
node scripts/landmark-probe.js
```

The probe opens a dedicated headed browser and walks through these steps. It
pauses for Enter at each one.

1. Sign in directly in the browser and confirm the intended account and branch.
2. Confirm (y/N) that the signed-in account is the intended one. Answering N
   stops the probe: it records a blocker and closes without reading the cart.
3. Type the branch/location label the storefront shows (no personal data).
4. Optionally add a free-text note about the context.
5. Open the cart page in the browser. The probe records the resulting reads.
6. Open one simple, fixed-unit product page **from the cart** (click the
   product, not Add to Cart).

The read-only guard is installed only after step 4, because sign-in itself is a
POST that the guard would block. During steps 1–4 sign in and stop: do not
browse or click anything else in the storefront, and do not follow any redirect
the login flow offers.

After step 4 the guard is active: every non-GET/HEAD request to `landmark.ph`
is aborted, non-rendering cross-origin requests are aborted, checkout/logout
navigation is blocked, and **redirects are never followed**. Playwright routes
only the first request of a redirect chain, so following one would contact a URL
the gate never classified; the probe re-issues each same-origin request with
redirects disabled, refuses the redirect, and records its redacted destination.
A blocked redirect is a blocker to read, not a silent failure — open the
destination URL directly if that read is genuinely needed.

The guard is a safety net, not a licence to mutate — do not click Add to Cart.

Do not add items to manufacture a populated cart. If the cart is empty, that is
the observation, and the probe records it as a blocker. An empty cart is not
sufficient populated-line evidence, and creating a fixture would invalidate the
investigation.

The probe writes a redacted evidence file to
`.local/landmark-probe/evidence/landmark-read-probe-<timestamp>.json` and closes
the browser. Pass `--keep-open` to leave the browser available; the persistent
profile keeps best-effort sign-in for a later run. Closing the probe does not
delete the profile.

## What is recorded, and what is never recorded

Recorded:

- Redacted `/api/` JSON response bodies and query parameters observed during
  the read-only phase.
- Request **header names** present on those reads (for example `cookie`,
  `authorization`, `lm-public-api-key`) — names only, never values.
- Cookie **names** with domain, path, and flags — never values.
- Browser storage **key names** only, per page.
- The operator's asserted branch label and account confirmation.
- Blocked requests, with method, redacted URL, and reason.

Never recorded or emitted:

- Cookie, header, session, nonce, or token values.
- Names, emails, phones, addresses, or billing/shipping fields.
- **Product and account names.** A `name` field cannot be told apart from a
  person's name, so it is withheld. Identify products by `id` and `sku`.
- Error or status message text; use the HTTP status and error `code` instead.
- Cart-line key values. A cart line is represented by its product `id` plus a
  short digest and length for the line `key`, so runs can be correlated
  without publishing the key.
- Page HTML, screenshots, traces, or raw network dumps.

Redaction is **fail-closed**: a value is published only when its field name is
on a small allowlist (`id`, `sku`, `type`, `quantity`, `price`, `amount`,
`currency_code`, `currency_minor_unit`, `substoreAlias`, and similar). Every
other field keeps its name, type, and size but not its value, for example
`"name": "<omitted:string:12>"`. Opaque identifiers and secrets become
`"<opaque:digest:length>"`; personal fields become `"<redacted:personal>"`.
Long or opaque URL path segments are digested too, not just the query string.

Redaction is enforced by `redactEvidence`, `redactQuery`, `redactUrl`, and
`extractCartLines` in [scripts/landmark-probe.js](../../../scripts/landmark-probe.js),
covered by `test/landmark-probe.test.js`.

## Review before sharing

Open the evidence file and confirm it contains no name, email, address, phone,
cookie value, header value, nonce, token, or 32-hex cart-line key. Every
withheld value appears as `<omitted:…>`, `<opaque:…>`, or `<redacted:…>`, so an
unexpected literal is easy to spot. Share only that file, not the profile
directory.

## Synthetic example of the evidence shape

The following is a **synthetic illustration** of the output shape, produced by
running the probe against a throwaway local fixture. It is not an observation
of Landmark and must not be cited as one.

```json
{
  "probe": { "name": "landmark-signed-in-read-probe", "version": 1, "retailerOrigin": "https://www.landmark.ph" },
  "authorisation": { "intendedAccountConfirmed": true, "assertedBranchLabel": "<operator-supplied label>", "operatorStatement": "" },
  "session": {
    "cookies": [{ "name": "<cookie name>", "domain": ".landmark.ph", "httpOnly": true, "secure": true }],
    "storageKeys": [{ "url": "https://www.landmark.ph/cart", "keys": { "localStorage": ["<key name>"], "sessionStorage": [] } }]
  },
  "observations": [
    {
      "method": "GET",
      "path": "/api/cart",
      "query": {},
      "status": 200,
      "requestHeaderNames": ["accept", "cookie", "referer", "user-agent"],
      "contentType": "application/json",
      "seen": 1,
      "cartLines": [
        {
          "productId": 39943,
          "productIdType": "number",
          "lineKey": "<opaque:5d72f08b0e17:32>",
          "type": "simple",
          "quantity": 1,
          "sku": "<public sku>",
          "price": "46900",
          "currency": "PHP",
          "minorUnit": 2
        }
      ],
      "body": { "cart": { "items": ["<as above>"], "itemsCount": 1, "total": 46900 }, "nonce": "<opaque:bdb339768bc5:32>", "customer": "<redacted:opaque-subtree>", "profile": { "name": "<omitted:string:12>" }, "meta_data": [{ "key": "<opaque:edb465624291:4>", "value": "<omitted:string:9>" }] }
    }
  ],
  "cart": { "observed": true, "sourcePath": "/api/cart", "lineCount": 1, "lines": ["<as above>"] },
  "productDetail": { "observed": true, "sourcePath": "/api/products/39943", "status": 200, "body": { "id": 39943, "type": "simple", "sku": "<public sku>", "title": "<omitted:string:34>", "priceRange": { "minVariantPrice": { "amount": 469, "currencyCode": "Php" } } } },
  "correspondence": {
    "productId": 39943,
    "productIdTypeDifference": false,
    "skuMatch": true,
    "typeMatch": true,
    "cartPrice": { "amount": "46900", "currency": "PHP", "minorUnit": 2 },
    "detailPrice": { "amount": 469, "currencyCode": "Php" },
    "note": "equality here is observed representation, not proof of identity rules"
  },
  "blockedRequests": [
    { "method": "POST", "url": "https://www.landmark.ph/api/cart/item", "reason": "non-read-method:POST" },
    { "method": "GET", "url": "https://www.landmark.ph/api/cart", "reason": "redirect-not-followed", "destination": "https://www.landmark.ph/checkout" }
  ],
  "blockers": []
}
```

## How to read the evidence against ticket 02

| Ticket question | Where the answer lives | Still requires |
| --- | --- | --- |
| Intended account/branch connected to reads | `authorisation.assertedBranchLabel`, `observations[].query.substoreAlias`/`substoreId`, `session.cookies` names | Operator confirmation; whether the alias is the configured branch is a judgement, not a field |
| Cart structure: product identity, line keys, quantities, prices, contents | `cart.lines`, `observations[].body.cart` | A **populated** cart; an empty cart is not sufficient evidence |
| Product id vs cart-line key | `cart.lines[].productId` and `cart.lines[].lineKey` | Confirming the key is stable across reads |
| Cart line ↔ catalogue/detail correspondence | `correspondence` | At least one supported simple, fixed-unit product in the cart |
| Read prerequisites | `observations[].requestHeaderNames`, `status`, `blockedRequests` | Comparing a successful read with a deliberately expired/absent session, which this run does not induce |
| Expired auth / wrong context / cart-read failure signals | `blockedRequests`, non-200 `observations`, `blockers` | Observed failure cases; the probe does not force them |

Product names are withheld, so use `id`/`sku` to identify a line. A blocked
`redirect-not-followed` entry with a login destination is itself evidence that
the session had expired.

A simple, fixed-unit product does not establish variant, open-weight, or
package-size semantics. Record those as unresolved unless a matching example is
observed separately.

The probe never induces a failure. Signals for expired authentication, a wrong
or unknown shopping context, and cart-read failure can only be recorded if they
occur naturally, or through a separate explicitly scoped step.

## Closing the session

Close the probe when finished or paused (the default). Keep it open only if the
operator explicitly asks to use the browser. Delete
`.local/landmark-probe/profile` to discard retained sign-in.

## Remaining blockers

- The probe has not been run against a signed-in Landmark session.
- No populated cart evidence, branch mapping, or failure-signal evidence exists.
- Whether the anonymous `substoreAlias=mkt` default relates to the configured
  branch is still unknown and must not be assumed.

Ticket 02 stays blocked until the operator runs this procedure and the redacted
evidence is reviewed.
