import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, parseSize, sizeEquals, formatMoney } from '../src/catalog.js';
import {
  interpretRequest,
  discoverCandidates,
  classify,
  computePlan,
  verifyCart,
  revalidateApproval,
} from '../src/domain.js';

const item = (over = {}) => ({
  id: 'item-1',
  raw: 'Highlands Corned Beef 150g x2',
  name: 'Corned Beef',
  brand: 'Highlands',
  variant: null,
  size: parseSize('150g'),
  quantity: 2,
  restrictions: { noSubstitution: false },
  ...over,
});

test('parseSize normalises within a dimension only', () => {
  assert.equal(parseSize('0.5kg').value, 500);
  assert.equal(parseSize('500 g').value, 500);
  assert.ok(sizeEquals(parseSize('1kg'), parseSize('1000g')));
  assert.ok(sizeEquals(parseSize('1 L'), parseSize('1000 ml')));
  assert.ok(!sizeEquals(parseSize('500g'), parseSize('500ml')));
  assert.ok(!sizeEquals(parseSize('2 x 250g'), parseSize('500g')));
});

test('formatMoney uses minor units', () => {
  assert.equal(formatMoney(4690), 'PHP 46.90');
});

test('interpretation keeps raw text beside brand, size, and quantity', () => {
  const [first] = interpretRequest('Highlands Corned Beef 150g x2');
  assert.equal(first.raw, 'Highlands Corned Beef 150g x2');
  assert.equal(first.brand, 'Highlands');
  assert.equal(first.size.value, 150);
  assert.equal(first.quantity, 2);
});

test('an unspecified size stays yellow even when only one candidate exists', () => {
  const unspecified = {
    ...item({ raw: 'McCormick Italian Seasoning x1', name: 'Italian Seasoning', brand: 'McCormick', size: null, quantity: 1 }),
  };
  const candidates = discoverCandidates(unspecified).filter((c) => c.color !== 'red');
  assert.equal(candidates.length, 1, 'expected exactly one candidate for this rehearsal item');
  assert.equal(candidates[0].color, 'yellow', 'a sole candidate must not become green by uniqueness');
});

test('a different size is an orange substitution', () => {
  const c = discoverCandidates(item()).find((x) => x.product.id === 'hl-beef-260g');
  assert.equal(c.color, 'orange');
  assert.equal(c.selectable, true);
});

test('contradictory evidence is non-selectable red', () => {
  const c = discoverCandidates(item()).find((x) => x.product.id === 'conflict-beef-150g');
  assert.equal(c.color, 'red');
  assert.equal(c.selectable, false);
});

test('an explicit no-substitution prohibition makes a different brand non-selectable', () => {
  const restricted = item({ restrictions: { noSubstitution: true } });
  const cdo = discoverCandidates(restricted).find((x) => x.product.id === 'cdo-beef-150g');
  assert.equal(cdo.color, 'red');
  assert.equal(cdo.selectable, false);
  // Without the prohibition the same candidate is a selectable orange alternative.
  const allowed = discoverCandidates(item()).find((x) => x.product.id === 'cdo-beef-150g');
  assert.equal(allowed.color, 'orange');
});

test('quantity is a target total, not an increment', () => {
  const [parsed] = interpretRequest('Highlands Corned Beef 150g x2');
  const plan = computePlan([parsed], { 'item-1': { productId: 'hl-beef-150g' } }, { 'hl-beef-150g': 1 }, 'ctx', 1);
  assert.equal(plan.actions[0].kind, 'add');
  assert.equal(plan.actions[0].units, 1);
  assert.equal(plan.actions[0].to, 2);
});

test('a cart already at target needs no addition', () => {
  const [parsed] = interpretRequest('Highlands Corned Beef 150g x2');
  const plan = computePlan([parsed], { 'item-1': { productId: 'hl-beef-150g' } }, { 'hl-beef-150g': 2 }, 'ctx', 1);
  assert.equal(plan.actions[0].kind, 'none');
});

test('excess proposes a reduction that is not executable without approval', () => {
  const [parsed] = interpretRequest('Pasta Roma Fusilli 500g x2');
  const unapproved = computePlan([parsed], { 'item-1': { productId: 'pr-fusilli-500g' } }, { 'pr-fusilli-500g': 3 }, 'ctx', 1);
  assert.equal(unapproved.actions[0].kind, 'reduce');
  assert.equal(unapproved.actions[0].executable, false);

  const approved = computePlan(
    [parsed],
    { 'item-1': { productId: 'pr-fusilli-500g', approveReduction: true } },
    { 'pr-fusilli-500g': 3 },
    'ctx',
    1,
  );
  assert.equal(approved.actions[0].executable, true);
});

test('verification keeps different configurations and unrelated contents as extras', () => {
  const [parsed] = interpretRequest('Highlands Corned Beef 150g x2');
  const plan = computePlan([parsed], { 'item-1': { productId: 'hl-beef-150g' } }, { 'hl-beef-150g': 1 }, 'ctx', 1);
  const result = verifyCart(plan, { 'hl-beef-150g': 2, 'hl-beef-260g': 1, 'mccormick-seasoning-200g': 1 });
  assert.equal(result.fulfilled.length, 1);
  assert.deepEqual(
    result.extras.map((e) => e.productId).sort(),
    ['hl-beef-260g', 'mccormick-seasoning-200g'],
  );
});

test('verification reports an unapproved reduction as retained excess', () => {
  const [parsed] = interpretRequest('Pasta Roma Fusilli 500g x2');
  const plan = computePlan([parsed], { 'item-1': { productId: 'pr-fusilli-500g' } }, { 'pr-fusilli-500g': 3 }, 'ctx', 1);
  const result = verifyCart(plan, { 'pr-fusilli-500g': 3 });
  assert.equal(result.discrepancies.length, 1);
  assert.match(result.discrepancies[0].note, /not approved/i);
});

test('revalidation pauses on a concurrent cart change or a price rise', () => {
  const approval = {
    revision: 1,
    contextId: 'ctx',
    actions: [
      {
        productId: 'hl-beef-150g',
        product: { name: 'Highlands Corned Beef 150 g' },
        from: 1,
        priceMinor: 4690,
        priceDisplay: 'PHP 46.90',
      },
    ],
  };
  const ok = revalidateApproval(approval, { revision: 1, contextId: 'ctx', cart: { 'hl-beef-150g': 1 } });
  assert.equal(ok.ok, true);

  const cartChanged = revalidateApproval(approval, { revision: 1, contextId: 'ctx', cart: {} });
  assert.equal(cartChanged.ok, false);

  const priceRise = revalidateApproval(approval, {
    revision: 1,
    contextId: 'ctx',
    cart: { 'hl-beef-150g': 1 },
    catalog: CATALOG.map((p) => (p.id === 'hl-beef-150g' ? { ...p, priceMinor: 9999 } : p)),
  });
  assert.equal(priceRise.ok, false);

  const revisionChanged = revalidateApproval(approval, { revision: 2, contextId: 'ctx', cart: { 'hl-beef-150g': 1 } });
  assert.equal(revisionChanged.ok, false);
});
