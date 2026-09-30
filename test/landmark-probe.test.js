import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactEvidence,
  redactQuery,
  redactUrl,
  classifyRequest,
  classifyResponse,
  extractCartLines,
  dedupeObservations,
  RETAILER_ORIGIN,
} from '../scripts/landmark-probe.js';

// The probe's only irrecoverable failure is leaking personal data or secrets
// into the evidence file, so the redaction rules are the part worth checking.
// Redaction is fail-closed: a field is published only if it is allowlisted.

test('personal fields are collapsed entirely, without a linkable digest', () => {
  const redacted = redactEvidence({
    email: 'shopper@example.com',
    phone: '+63 900 000 0000',
    billing: { first_name: 'Ada', address_1: '1 Example St' },
  });
  assert.equal(redacted.email, '<redacted:personal>');
  assert.equal(redacted.phone, '<redacted:personal>');
  assert.equal(redacted.billing, '<redacted:personal>');
  assert.doesNotMatch(JSON.stringify(redacted), /shopper@example\.com|Ada|Example St/);
});

test('unknown field names withhold their values instead of publishing them', () => {
  const redacted = redactEvidence({
    profile: { name: 'Ada Lovelace' },
    displayName: 'Ada',
    messages: ['Your order is ready, Ada'],
    meta_data: [{ key: 'note', value: 'call Ada on 0917' }],
    loyaltyTier: 'gold',
  });
  const json = JSON.stringify(redacted);
  assert.doesNotMatch(json, /Ada|Lovelace|0917|gold/);
  // Structure survives, so the field is still evidence that it existed.
  assert.equal(redacted.profile.name, '<omitted:string:12>');
  assert.equal(redacted.displayName, '<omitted:string:3>');
  assert.match(redacted.messages[0], /^<omitted:string:\d+>$/);
  assert.equal(redacted.loyaltyTier, '<omitted:string:4>');
});

test('secrets and opaque identifiers become a digest plus length, never the value', () => {
  const nonce = 'e3efe0ad5b37b75621ec60cc1d3176ef';
  const redacted = redactEvidence({ nonce, customer_id: 39943 });
  assert.match(redacted.nonce, /^<opaque:[0-9a-f]{12}:32>$/);
  assert.match(redacted.customer_id, /^<opaque:[0-9a-f]{12}:5>$/);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(nonce));
});

test('cart-line keys are digested even though their field name is generic', () => {
  const key = 'a'.repeat(32);
  const redacted = redactEvidence({ items: [{ key, id: 39943 }] });
  assert.equal(redacted.items[0].id, 39943);
  assert.match(redacted.items[0].key, /^<opaque:[0-9a-f]{12}:32>$/);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(key));
});

test('allowlisted catalogue fields survive redaction unchanged', () => {
  const redacted = redactEvidence({
    id: '27213',
    sku: 'MKT-14069',
    type: 'simple',
    availableForSale: true,
    priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } },
  });
  assert.deepEqual(redacted, {
    id: '27213',
    sku: 'MKT-14069',
    type: 'simple',
    availableForSale: true,
    priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } },
  });
});

test('redaction bounds array length and marks the truncation', () => {
  const redacted = redactEvidence({ items: Array.from({ length: 51 }, (_, i) => ({ id: i })) });
  assert.equal(redacted.items.length, 51);
  assert.equal(redacted.items[50], '<+1 more>');
});

test('query redaction keeps context parameters and digests anything else', () => {
  const query = redactQuery(
    new URLSearchParams({ substoreAlias: 'mkt', page: '2', searchKeywords: 'milk' }),
  );
  assert.equal(query.substoreAlias, 'mkt');
  assert.equal(query.page, '2');
  assert.match(query.searchKeywords, /^<opaque:[0-9a-f]{12}:4>$/);
});

test('URL redaction sanitises opaque path segments, not just the query', () => {
  const lineKey = 'e3efe0ad5b37b75621ec60cc1d3176ef';
  const url = redactUrl(`${RETAILER_ORIGIN}/api/cart/item/${lineKey}?substoreAlias=mkt`);
  assert.doesNotMatch(url, new RegExp(lineKey));
  assert.match(url, /<opaque:[0-9a-f]{12}:32>/);
  assert.match(url, /substoreAlias=mkt/);
});

test('URL redaction never renders a redacted value as object text', () => {
  const url = redactUrl(`${RETAILER_ORIGIN}/api/cart/item?substoreAlias=mkt&searchKeywords=milk`);
  assert.doesNotMatch(url, /object%20Object|object\+Object|\[object Object\]/);
  assert.doesNotMatch(url, /milk/);
});

test('the read-only gate allows retailer reads and rendering assets', () => {
  const base = { retailerOrigin: RETAILER_ORIGIN };
  assert.deepEqual(
    classifyRequest({ ...base, method: 'GET', url: `${RETAILER_ORIGIN}/api/cart` }),
    { action: 'allow' },
  );
  assert.deepEqual(
    classifyRequest({
      ...base,
      method: 'GET',
      url: 'https://cdn.example.com/app.js',
      resourceType: 'script',
    }),
    { action: 'allow' },
  );
  assert.deepEqual(
    classifyRequest({
      ...base,
      method: 'GET',
      url: `${RETAILER_ORIGIN}/products/x/27213`,
      isNavigation: true,
    }),
    { action: 'allow' },
  );
});

test('the read-only gate aborts mutations, cross-origin calls, and checkout navigation', () => {
  const base = { retailerOrigin: RETAILER_ORIGIN };
  assert.deepEqual(
    classifyRequest({ ...base, method: 'POST', url: `${RETAILER_ORIGIN}/api/cart/item` }),
    { action: 'abort', reason: 'non-read-method:POST' },
  );
  assert.deepEqual(
    classifyRequest({ ...base, method: 'DELETE', url: `${RETAILER_ORIGIN}/api/cart/item/1` }),
    { action: 'abort', reason: 'non-read-method:DELETE' },
  );
  assert.deepEqual(
    classifyRequest({ ...base, method: 'GET', url: 'https://tracker.example.com/pixel' }),
    { action: 'abort', reason: 'cross-origin' },
  );
  assert.deepEqual(
    classifyRequest({ ...base, method: 'GET', url: `${RETAILER_ORIGIN}/checkout`, isNavigation: true }),
    { action: 'abort', reason: 'blocked-navigation' },
  );
  assert.deepEqual(
    classifyRequest({ ...base, method: 'GET', url: `${RETAILER_ORIGIN}/logout`, isNavigation: true }),
    { action: 'abort', reason: 'blocked-navigation' },
  );
});

test('redirects are refused, so an unclassified destination is never contacted', () => {
  assert.deepEqual(classifyResponse({ status: 200, baseUrl: `${RETAILER_ORIGIN}/api/cart` }), {
    action: 'fulfill',
  });
  const toCheckout = classifyResponse({
    status: 302,
    location: '/checkout',
    baseUrl: `${RETAILER_ORIGIN}/api/cart`,
  });
  assert.equal(toCheckout.action, 'abort');
  assert.equal(toCheckout.reason, 'redirect-not-followed');
  assert.equal(toCheckout.destination, `${RETAILER_ORIGIN}/checkout`);

  const crossOrigin = classifyResponse({
    status: 302,
    location: 'https://evil.example/steal',
    baseUrl: `${RETAILER_ORIGIN}/api/cart`,
  });
  assert.equal(crossOrigin.action, 'abort');
  assert.equal(crossOrigin.destination, 'https://evil.example/steal');

  const noLocation = classifyResponse({
    status: 308,
    location: null,
    baseUrl: `${RETAILER_ORIGIN}/api/cart`,
  });
  assert.equal(noLocation.action, 'abort');
  assert.equal(noLocation.destination, null);
});

test('cart-line extraction separates product identity from the cart-line key', () => {
  const lines = extractCartLines({
    cart: {
      items: [
        {
          key: 'b'.repeat(32),
          id: 39943,
          type: 'simple',
          quantity: 2,
          name: 'McCormick Italian Seasoning 200g',
          sku: 'TNM-5263',
          prices: { price: '46900', currency_code: 'PHP', currency_minor_unit: 2 },
        },
      ],
    },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].productId, 39943);
  assert.equal(lines[0].productIdType, 'number');
  assert.equal(lines[0].quantity, 2);
  assert.equal(lines[0].sku, 'TNM-5263');
  assert.equal(lines[0].price, '46900');
  assert.equal(lines[0].currency, 'PHP');
  assert.equal(lines[0].minorUnit, 2);
  assert.match(lines[0].lineKey, /^<opaque:[0-9a-f]{12}:32>$/);
  assert.doesNotMatch(JSON.stringify(lines), /McCormick|b{32}/);
});

test('cart-line extraction cannot be used to publish a nested secret', () => {
  const lines = extractCartLines({
    cart: {
      items: [
        {
          id: { token: 'secret-token-value' },
          key: 'c'.repeat(32),
          type: { token: 'secret-token-value' },
          sku: { token: 'secret-token-value' },
          prices: { price: { token: 'secret-token-value' } },
        },
      ],
    },
  });
  assert.doesNotMatch(JSON.stringify(lines), /secret-token-value/);
  assert.equal(lines[0].productId, '<omitted:object>');
  assert.equal(lines[0].type, '<omitted:object>');
  assert.equal(lines[0].sku, '<omitted:object>');
  assert.equal(lines[0].price, '<omitted:object>');
});

test('cart-line extraction reports an empty cart rather than inventing lines', () => {
  assert.deepEqual(extractCartLines({ cart: { items: [] } }), []);
  assert.equal(extractCartLines({ cart: {} }), null);
  assert.equal(extractCartLines(null), null);
});

test('identical observations collapse and the latest read keeps the latest position', () => {
  const cartEmpty = { method: 'GET', path: '/api/cart', status: 200, body: { cart: { items: [] } } };
  const detail = { method: 'GET', path: '/api/products/1', status: 200, body: { id: 1 } };
  const cartPopulated = {
    method: 'GET',
    path: '/api/cart',
    status: 200,
    body: { cart: { items: [1] } },
  };

  // A -> B -> A leaves the final A last, so "latest cart read" is A, not B.
  const reordered = dedupeObservations([cartEmpty, detail, { ...cartEmpty }]);
  assert.equal(reordered.length, 2);
  assert.equal(reordered[0].path, '/api/products/1');
  assert.equal(reordered[0].seen, 1);
  assert.equal(reordered.at(-1).path, '/api/cart');
  assert.equal(reordered.at(-1).seen, 2);

  // A changed cart read is a distinct observation and stays the latest.
  const changed = dedupeObservations([cartEmpty, cartPopulated, { ...cartEmpty }]);
  assert.equal(changed.at(-1).body.cart.items.length, 0);
});
