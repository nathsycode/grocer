import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactEvidence,
  redactQuery,
  redactUrl,
  classifyRequest,
  extractCartLines,
  dedupeObservations,
  RETAILER_ORIGIN,
} from '../scripts/landmark-probe.js';

// The probe's only irrecoverable failure is leaking personal data or secrets
// into the evidence file, so the redaction rules are the part worth checking.

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

test('secrets and opaque identifiers become a digest plus length, never the value', () => {
  const nonce = 'e3efe0ad5b37b75621ec60cc1d3176ef';
  const redacted = redactEvidence({ nonce, customer_id: 39943 });
  assert.deepEqual(redacted.nonce, { redacted: true, digest: redacted.nonce.digest, length: 32 });
  assert.deepEqual(redacted.customer_id, {
    redacted: true,
    digest: redacted.customer_id.digest,
    length: 5,
  });
  assert.equal(redactEvidence({ customer: { id: 1 } }).customer, '<redacted:opaque-subtree>');
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(nonce));
});

test('cart-line keys are digested even though their field name is generic', () => {
  const key = 'a'.repeat(32);
  const redacted = redactEvidence({ items: [{ key, id: 39943 }] });
  assert.equal(redacted.items[0].id, 39943);
  assert.equal(redacted.items[0].key.redacted, true);
  assert.equal(redacted.items[0].key.length, 32);
  assert.doesNotMatch(JSON.stringify(redacted), new RegExp(key));
});

test('public catalogue fields survive redaction unchanged', () => {
  const redacted = redactEvidence({
    id: '27213',
    sku: 'MKT-14069',
    title: 'Highlands Gold Corned Beef 150g',
    price: 87.5,
    currencyCode: 'Php',
  });
  assert.deepEqual(redacted, {
    id: '27213',
    sku: 'MKT-14069',
    title: 'Highlands Gold Corned Beef 150g',
    price: 87.5,
    currencyCode: 'Php',
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
  assert.equal(query.searchKeywords.redacted, true);
});

test('blocked-request URLs keep the context and never render an object as text', () => {
  const url = redactUrl(`${RETAILER_ORIGIN}/api/cart/item?substoreAlias=mkt&searchKeywords=milk`);
  assert.match(url, /substoreAlias/);
  assert.match(url, /mkt/);
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
    classifyRequest({ ...base, method: 'GET', url: `${RETAILER_ORIGIN}/products/x/27213`, isNavigation: true }),
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
  assert.equal(lines[0].lineKey.redacted, true);
  assert.doesNotMatch(JSON.stringify(lines), new RegExp('b'.repeat(32)));
});

test('cart-line extraction reports an empty cart rather than inventing lines', () => {
  assert.deepEqual(extractCartLines({ cart: { items: [] } }), []);
  assert.equal(extractCartLines({ cart: {} }), null);
  assert.equal(extractCartLines(null), null);
});

test('identical observations collapse into one entry with a repeat count', () => {
  const read = { method: 'GET', path: '/api/cart', status: 200, body: { cart: { items: [] } } };
  const other = { method: 'GET', path: '/api/products/1', status: 200, body: { id: 1 } };
  const deduped = dedupeObservations([read, other, { ...read }]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0].seen, 2);
  assert.equal(deduped[1].seen, 1);
});
