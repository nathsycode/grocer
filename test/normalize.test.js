import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProductId,
  normalizeMoney,
  normalizeObservedProduct,
  mergeObservedEvidence,
} from '../src/retailer/normalize.js';

// Representations below are taken from the 2026-09-29 anonymous read-only probe
// (docs/integrations/landmark/read-only-probe-2026-09-29.md) and the original
// owner-reported cart excerpt. They are observed shapes, not a guaranteed
// contract; the normalizer must handle the differences explicitly.

test('normalizeProductId accepts the observed string and number id representations', () => {
  assert.equal(normalizeProductId('27213'), '27213');
  assert.equal(normalizeProductId(27213), '27213');
  assert.equal(normalizeProductId(' 39943 '), '39943');
});

test('normalizeProductId rejects values that are not product identifiers', () => {
  assert.equal(normalizeProductId(null), null);
  assert.equal(normalizeProductId(undefined), null);
  assert.equal(normalizeProductId(''), null);
  assert.equal(normalizeProductId('   '), null);
  assert.equal(normalizeProductId({ id: 1 }), null);
  assert.equal(normalizeProductId(true), null);
});

test('normalizeMoney reads a minor-unit cart representation without rescaling', () => {
  // Observed cart excerpt: price "46900", currency_code "PHP", minor_unit 2.
  const money = normalizeMoney({ amount: '46900', currency: 'PHP', minorUnit: 2 });
  assert.equal(money.minor, 46900);
  assert.equal(money.currency, 'PHP');
  assert.equal(money.display, 'PHP 469.00');
  assert.equal(money.format, 'minor');
  assert.equal(money.unresolved, false);
});

test('normalizeMoney reads a major-unit catalogue representation and scales explicitly', () => {
  // Observed search/detail: amount 87.5 or "87.5", currencyCode "Php".
  for (const amount of [87.5, '87.5']) {
    const money = normalizeMoney({ amount, currency: 'Php', scale: 'major' });
    assert.equal(money.minor, 8750);
    assert.equal(money.display, 'PHP 87.50');
    assert.equal(money.format, 'major');
    assert.equal(money.unresolved, false);
  }
});

test('normalizeMoney refuses to guess a scale when the endpoint does not state one', () => {
  // A bare "46900" could be 469.00 or 46,900.00 depending on the route.
  const money = normalizeMoney({ amount: '46900', currency: 'PHP' });
  assert.equal(money.minor, null);
  assert.equal(money.unresolved, true);
  assert.match(money.reason, /minor unit|scale/i);
});

test('normalizeMoney rejects an empty amount rather than resolving it to zero', () => {
  const money = normalizeMoney({ amount: '', currency: 'PHP', scale: 'major' });
  assert.equal(money.minor, null);
  assert.equal(money.unresolved, true);
});

test('normalizeMoney displays with the supplied exponent, not a currency default', () => {
  const money = normalizeMoney({ amount: '12345', currency: 'PHP', minorUnit: 3 });
  assert.equal(money.minor, 12345);
  assert.equal(money.display, 'PHP 12.345');
});

test('a cart price missing its minor unit stays unresolved instead of guessing', () => {
  const line = normalizeObservedProduct(
    { id: 39943, key: 'k', type: 'simple', quantity: 1, prices: { price: '46900', currency_code: 'PHP' } },
    { source: 'cart' },
  );
  assert.equal(line.money.minor, null);
  assert.ok(line.unresolved.some((u) => /price/i.test(u)));
});

test('normalizeMoney keeps currency and flags an unknown currency without a minor unit', () => {
  const money = normalizeMoney({ amount: 10, currency: 'XYZ' });
  assert.equal(money.minor, null);
  assert.equal(money.currency, 'XYZ');
  assert.equal(money.unresolved, true);
  assert.match(money.reason, /minor unit/i);
});

test('normalizeMoney rejects non-numeric amounts rather than guessing', () => {
  const money = normalizeMoney({ amount: 'free', currency: 'PHP' });
  assert.equal(money.minor, null);
  assert.equal(money.unresolved, true);
});

test('normalizeObservedProduct reads a search result shape with provenance', () => {
  const product = normalizeObservedProduct(
    {
      id: '27213',
      title: 'Highlands Gold Corned Beef 150g',
      sku: 'MKT-14069',
      type: 'simple',
      availableForSale: true,
      isOpenWeight: false,
      priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } },
    },
    { source: 'search' },
  );
  assert.equal(product.productId, '27213');
  assert.equal(product.sku, 'MKT-14069');
  assert.equal(product.type, 'simple');
  assert.equal(product.money.minor, 8750);
  assert.equal(product.money.currency, 'PHP');
  assert.equal(product.provenance.source, 'search');
  assert.equal(product.provenance.idType, 'string');
  assert.deepEqual(product.unresolved, []);
});

test('normalizeObservedProduct reads a detail shape where the same id is a number', () => {
  const product = normalizeObservedProduct(
    {
      id: 27213,
      title: 'Highlands Gold Corned Beef 150g',
      sku: 'MKT-14069',
      type: 'simple',
      priceRange: { minVariantPrice: { amount: '87.5', currencyCode: 'Php' } },
    },
    { source: 'detail' },
  );
  assert.equal(product.productId, '27213');
  assert.equal(product.provenance.idType, 'number');
  assert.equal(product.money.minor, 8750);
});

test('normalizeObservedProduct reads a cart line and keeps the line key separate from the product id', () => {
  const line = normalizeObservedProduct(
    {
      key: 'e3efe0ad5b37b75621ec60cc1d3176ef',
      id: 39943,
      type: 'simple',
      quantity: 1,
      name: 'McCormick Italian Seasoning 200g',
      sku: 'TNM-5263',
      prices: { price: '46900', currency_code: 'PHP', currency_minor_unit: 2 },
    },
    { source: 'cart' },
  );
  assert.equal(line.productId, '39943');
  assert.notEqual(line.lineKey, line.productId);
  assert.match(line.lineKey, /^e3efe0ad/);
  assert.equal(line.quantity, 1);
  assert.equal(line.money.minor, 46900);
});

test('normalizeObservedProduct records missing price as unresolved instead of inventing one', () => {
  const product = normalizeObservedProduct({ id: '27213', title: 'x', sku: 'S', type: 'simple' }, { source: 'search' });
  assert.equal(product.money.minor, null);
  assert.ok(product.unresolved.some((u) => /price/i.test(u)));
});

test('mergeObservedEvidence treats a matching search and detail read as one product', () => {
  const search = normalizeObservedProduct(
    { id: '27213', title: 'Highlands Gold Corned Beef 150g', sku: 'MKT-14069', type: 'simple', priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } } },
    { source: 'search' },
  );
  const detail = normalizeObservedProduct(
    { id: 27213, title: 'Highlands Gold Corned Beef 150g', sku: 'MKT-14069', type: 'simple', priceRange: { minVariantPrice: { amount: '87.5', currencyCode: 'Php' } } },
    { source: 'detail' },
  );
  const merged = mergeObservedEvidence([search, detail]);
  assert.equal(merged.productId, '27213');
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.evidence.length, 2);
  assert.equal(merged.money.minor, 8750);
});

test('mergeObservedEvidence surfaces a price conflict rather than picking a side', () => {
  const search = normalizeObservedProduct(
    { id: '27213', title: 'x', sku: 'S', type: 'simple', priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } } },
    { source: 'search' },
  );
  const detail = normalizeObservedProduct(
    { id: 27213, title: 'x', sku: 'S', type: 'simple', priceRange: { minVariantPrice: { amount: '179', currencyCode: 'Php' } } },
    { source: 'detail' },
  );
  const merged = mergeObservedEvidence([search, detail]);
  assert.ok(merged.conflicts.some((c) => /price/i.test(c)));
});

test('mergeObservedEvidence refuses to merge two different product ids', () => {
  const a = normalizeObservedProduct({ id: '27213', sku: 'A', type: 'simple' }, { source: 'search' });
  const b = normalizeObservedProduct({ id: 27185, sku: 'B', type: 'simple' }, { source: 'search' });
  assert.throws(() => mergeObservedEvidence([a, b]), /same product/i);
});

test('mergeObservedEvidence surfaces identity conflicts, not just money', () => {
  const a = normalizeObservedProduct(
    { id: '27213', title: 'Highlands Gold Corned Beef 150g', sku: 'MKT-14069', type: 'simple', priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } } },
    { source: 'search' },
  );
  const b = normalizeObservedProduct(
    { id: 27213, title: 'Highlands Gold Corned Beef 260g', sku: 'MKT-99999', type: 'simple', priceRange: { minVariantPrice: { amount: '87.5', currencyCode: 'Php' } } },
    { source: 'detail' },
  );
  const merged = mergeObservedEvidence([a, b]);
  assert.ok(merged.conflicts.some((c) => /title/i.test(c)));
  assert.ok(merged.conflicts.some((c) => /sku/i.test(c)));
});

test('mergeObservedEvidence surfaces a currency conflict even when minor amounts match', () => {
  const a = normalizeObservedProduct(
    { id: '27213', title: 'x', sku: 'S', type: 'simple', priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'Php' } } },
    { source: 'search' },
  );
  const b = normalizeObservedProduct(
    { id: '27213', title: 'x', sku: 'S', type: 'simple', priceRange: { minVariantPrice: { amount: 87.5, currencyCode: 'USD' } } },
    { source: 'detail' },
  );
  const merged = mergeObservedEvidence([a, b]);
  assert.ok(merged.conflicts.some((c) => /price|currency/i.test(c)));
});
