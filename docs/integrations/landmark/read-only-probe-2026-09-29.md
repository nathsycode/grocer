# Landmark anonymous read-only probe — 2026-09-29

## Scope and method

The owner explicitly authorised read-only investigation, with human-performed login if needed and no cart mutations, orders, or payment. This probe remained **anonymous**: no login, intended account, or configured branch was established.

Date is from the investigation host's UTC clock. Tools were Python's HTTP client and an existing Playwright 1.62.1 installation driving system Chrome 151.0.7922.108. Each browser run used a fresh, temporary context; no everyday browser profile was reused. Browser requests were restricted to same-origin GET/HEAD, with checkout/logout navigation blocked, service workers disabled, and third-party requests blocked. No buttons that add products were used.

Only selected public product fields, response shapes, statuses, header names, and presence/count checks were emitted. No API-header values, nonces, cookies, account information, screenshots, traces, or raw response files were retained. Browser contexts were closed after each probe. No project dependencies or application files were added.

These are bounded observations, not a supported API contract or proof of authenticated behaviour.

## Observed routes

| Request/source | Observation |
| --- | --- |
| `GET https://www.landmark.ph/` | HTTP 200; title “Landmark PH - Supermarket.” Public product cards render without login. |
| Homepage browser requests to `/api/products` | HTTP 200; observed query names include `substoreId`, `page`, `limit`, and `categoryId`. Their full semantics were not tested. |
| `https://www.landmark.ph/search?q=Highlands+Corned+Beef` | Rendered “200 products found,” including several Highlands sizes/variants and other brands. This is not proof of an exact or exhaustive search. |
| `GET /api/products/search-page/v4?substoreAlias=mkt&searchKeywords=Highlands%20Corned%20Beef` from the storefront | HTTP 200; response was an array of 200 products. A header-free Python GET of the same route returned 403. |
| `https://www.landmark.ph/products/highlands-corned-bf-gold-150gm-2/27213` | Rendered “Highlands Gold Corned Beef 150g,” ₱87.50, and an Add to Cart control. The control was not used. |
| Storefront `GET /api/products/27213` | HTTP 200 with product detail. |
| `GET /api/cart` without the storefront's public API header | HTTP 403 in both Python and an anonymous browser fetch; JSON message “You do not have access to this resource,” error “Forbidden.” |
| Anonymous browser `GET /api/cart` with the observed public API header | HTTP 200 with top-level `cart` and `nonce` fields. The cart's `items` array was empty. |

The search route above was observed in actual browser traffic, not inferred from WooCommerce conventions. Its default `substoreAlias=mkt` was supplied by the storefront. This does **not** establish the operator's intended branch or an authoritative alias-to-branch mapping.

The product page also attempted an ancillary related-products request that redirected (308) and returned 404 at `/api/products/related/24217,24214,24181,24164,24216/substore`. Main product detail still rendered. Do not infer that all discovery routes work.

## Public header and anonymous cart limits

Successful product requests carried a header named `lm-public-api-key`. Their observed request headers contained neither `Cookie` nor `Authorization`. The header value was kept transiently inside the probe process and used only for a same-origin cart GET; it was not printed or stored.

Adding that observed header changed the anonymous browser cart result from 403 to 200. Thus the earlier 403 is **not evidence that login is required for every cart read**. Conversely, this comparison does not establish all required headers, header stability, authenticated access rules, or direct-HTTP equivalence to browser execution.

The successful cart response had this observed structure (field names only):

```text
cart
  items          # empty array in this anonymous observation
  itemsCount
  total
  coupon
nonce            # string present; value not retained
```

No cookies were present in the fresh browser context before or after that cart read. An empty anonymous response is not proof of a persistent guest cart, authenticated cart identity, or the operator's actual cart. No populated cart-line schema or mutation nonce semantics were verified.

## Product representations differ by endpoint

For the public 150g example:

| Field | Search response | Detail response |
| --- | --- | --- |
| `id` | String `"27213"` | Number `27213` |
| `title` | `Highlands Gold Corned Beef 150g` | Same title |
| `sku` | `MKT-14069` | Same SKU |
| `type` | `simple` | `simple` |
| `availableForSale` | `true` | `true` |
| `priceRange.minVariantPrice.amount` | Number `87.5` | String `"87.5"` |
| `priceRange.minVariantPrice.currencyCode` | `Php` | `Php` |

The displayed price was ₱87.50. Another search result, Highlands Gold Corned Beef 320g (`id` string `"27185"`), had numeric amount `179` and displayed ₱179.00. These catalogue examples appear to represent major currency units; do not apply the original reported cart-item minor-unit interpretation to every endpoint.

Search also supplied `handle`, descriptions, images, categories, `options`, and `isOpenWeight`; the inspected simple products had empty `options`. Detail included `variantIds`, `relatedIds`, `attributes`, and `meta_data`. This probe did not establish variant rules, canonical package-size fields, stock quantities, or the reliability/freshness of `availableForSale`.

## MVP implications and remaining work

- **Supported by this probe:** anonymous candidate discovery and a simple product detail are feasible through observed frontend HTTP routes. Product IDs and money need explicit endpoint-aware normalization; raw equality/types are not uniform.
- **Matching implication:** search returned other brands and variants despite the query. Search rank is not constraint satisfaction; enforce ADR-0007's independent gates.
- **Not yet established:** the intended signed-in account/branch, populated cart identity and line fields, sign-in retention, branch effects, or safe read-only reconciliation of the operator's cart.
- **Not authorised or tested:** cart additions, quantity changes, removal, order/payment submission, retries, or mutation recovery. Nothing here establishes safe ownership release after an uncertain write.
- **Next human prerequisite:** sign in directly in a dedicated session and confirm the intended account/branch before investigating that cart. Do not copy credentials, session values, or nonces into chat or documentation.
- **Separate later permission required:** any controlled cart-mutation probe, including its exact product, quantity, existing-cart treatment, and verification plan.

Sources are the live storefront pages and browser-request routes listed above. Static search-page assets were also inspected to confirm use of the `q` query parameter; changing asset filenames are not proposed integration interfaces. An initial search snapshot was taken before results rendered; the confirmed observation waited for the visible product-count result rather than treating network idleness as proof of UI readiness.
