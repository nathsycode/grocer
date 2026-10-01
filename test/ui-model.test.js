import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { DEMO_CART } from '../src/index.js';
import {
  buildItems,
  sortItems,
  previewPlan,
  samePlan,
  priceIncreases,
  checkRevisedPlan,
  runRows,
  handoffView,
  correctedItems,
  preservedSelections,
  itemClass,
  formatMinor,
} from '../public/model.js';

async function fresh(text = 'Highlands Corned Beef 150g x2\nPasta Roma Fusilli 500g x2') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-ui-'));
  const store = createStore({ dataDir, stepDelayMs: 0 });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  await store.planRun(text);
  return store;
}

const cartOf = (store) => store.snapshot().cart;

test('the preview treats quantity as a target total against the existing cart', async () => {
  const store = await fresh();
  const run = store.snapshot().run;
  const views = buildItems(run, cartOf(store));
  const preview = previewPlan(views);
  const beef = preview.actions.find((a) => a.productId === 'hl-beef-150g');
  assert.equal(beef.kind, 'add');
  assert.equal(beef.units, 1, 'target 2, one already in the cart');
  const fusilli = preview.actions.find((a) => a.productId === 'pr-fusilli-500g');
  assert.equal(fusilli?.kind, 'reduce', 'cart holds 3, target is 2');
  assert.equal(fusilli.executable, false, 'a reduction is not executable without its own approval');
  assert.equal(preview.totalMinor, beef.units * beef.priceMinor);
});

test('the preview matches the plan the backend actually reviews', async () => {
  const store = await fresh();
  const run = store.snapshot().run;
  const preview = previewPlan(buildItems(run, cartOf(store)));
  const plan = store.reviewPlan(run.runId);
  assert.equal(samePlan(preview, plan), true);

  // A cart change the screen has not seen must be detected, not approved.
  store.simulator.seedCart({ ...DEMO_CART, 'hl-beef-150g': 2 });
  const drifted = store.reviewPlan(run.runId);
  assert.equal(samePlan(preview, drifted), false);
});

test('approving a reduction is reflected in the preview and still matches the backend', async () => {
  const store = await fresh();
  const run = store.snapshot().run;
  const selections = JSON.parse(JSON.stringify(run.selections));
  selections['item-2'].approveReduction = true;
  store.setSelections(run.runId, selections);
  const next = store.snapshot().run;
  const views = buildItems(next, cartOf(store));
  assert.equal(views.find((v) => v.item.id === 'item-2').needsReduction, true);
  const preview = previewPlan(views);
  assert.equal(samePlan(preview, store.reviewPlan(next.runId)), true);
});

test('unselected and unresolved items stay out of the plan and are reported separately', async () => {
  const store = await fresh('Highlands Corned Beef 150g x2\nFresh Salmon Fillet 300g');
  const run = store.snapshot().run;
  const views = buildItems(run, cartOf(store));
  const preview = previewPlan(views);
  assert.equal(preview.unresolved.length, 1);
  assert.equal(preview.actions.some((a) => a.itemId === 'item-2'), false);
  assert.equal(sortItems(views)[0].cls !== 'green', true, 'items needing the user sort before exact matches');
});

test('item class is the best selectable colour, else red', () => {
  assert.equal(itemClass([]), 'red');
  assert.equal(itemClass([{ selectable: false, color: 'green' }]), 'red');
  assert.equal(itemClass([{ selectable: true, color: 'orange' }, { selectable: true, color: 'yellow' }]), 'yellow');
  assert.equal(itemClass([{ selectable: true, color: 'orange' }, { selectable: true, color: 'green' }]), 'green');
});

test('a price rise after approval is detected and a revised plan is bounded by what was shown', async () => {
  const store = await fresh('Highlands Corned Beef 150g x3');
  const run = store.snapshot().run;
  const plan = store.reviewPlan(run.runId);
  const product = store.catalog.find((p) => p.id === 'hl-beef-150g');
  const originalMinor = product.priceMinor;
  assert.equal(priceIncreases(plan, store.snapshot().catalog).length, 0);

  product.priceMinor = originalMinor + 500;
  const [rise] = priceIncreases(plan, store.snapshot().catalog);
  assert.equal(rise.approvedMinor, originalMinor);
  assert.equal(rise.nowMinor, originalMinor + 500);

  const revised = store.reviewPlan(run.runId);
  assert.deepEqual(checkRevisedPlan(revised, plan, { 'hl-beef-150g': rise.nowMinor }), []);
  // If the price moves again beyond what the user was shown, consent does not cover it.
  product.priceMinor = originalMinor + 900;
  const again = store.reviewPlan(run.runId);
  assert.equal(checkRevisedPlan(again, plan, { 'hl-beef-150g': rise.nowMinor }).length, 1);
  // A product the user never approved is rejected outright.
  const stranger = { actions: [{ ...again.actions[0], productId: 'unknown', product: { name: 'Mystery' } }] };
  assert.match(checkRevisedPlan(stranger, plan, {})[0], /not part of the plan/);
});

test('run rows and the handoff view come from observed state, not from mutation responses', async () => {
  const store = await fresh('Highlands Corned Beef 150g x2');
  const run0 = store.snapshot().run;
  store.reviewPlan(run0.runId);
  store.approvePlan(run0.runId);
  store.startExecution(run0.runId);
  while (store.executing) await new Promise((r) => setTimeout(r, 5));
  const snap = store.snapshot();
  const run = snap.run;
  assert.equal(run.status, 'completed');

  const rows = runRows(run, snap.attempts, snap.catalog);
  assert.deepEqual(rows.map((r) => r.state), ['verified in cart']);

  const H = handoffView(run, buildItems(run, snap.cart));
  assert.equal(H.verified, 1);
  assert.equal(H.total, 1);
  assert.equal(H.clean, true);
  assert.equal(H.discrepancies, 0);
  assert.equal(H.addedMinor, store.catalog.find((p) => p.id === 'hl-beef-150g').priceMinor);
  assert.ok(H.extras.length > 0, 'unrelated pre-existing cart lines are reported as untouched');
});

test('a verification discrepancy is shown as trouble, never as a clean cart', () => {
  const run = {
    plan: {
      actions: [
        {
          itemId: 'a',
          raw: 'x',
          kind: 'add',
          units: 1,
          target: 2,
          priceMinor: 100,
          productId: 'p1',
          product: { brand: 'B', name: 'N', sizeDisplay: '1 kg' },
        },
      ],
      unfulfilled: [],
    },
    verification: {
      fulfilled: [],
      discrepancies: [{ productId: 'p1', expected: 2, observed: 1, note: 'Observed quantity does not match the approved target.' }],
      extras: [],
      unfulfilled: [],
      priceDecreases: [],
    },
  };
  const H = handoffView(run, [{ item: { id: 'a' }, cls: 'green', picked: { color: 'green' }, target: 2 }]);
  assert.equal(H.clean, false);
  assert.equal(H.verified, 0);
  assert.equal(H.stats.trouble, 1);
  assert.equal(H.rows[0].result, 'Discrepancy');
});

test('a correction carries only the edited field and keeps other explicit choices', async () => {
  const store = await fresh();
  const before = store.snapshot().run;
  const items = correctedItems(before, 'item-1', 'quantity', 3);
  assert.equal(items.find((i) => i.id === 'item-1').quantity, 3);
  assert.equal(items.find((i) => i.id === 'item-2').quantity, before.items[1].quantity);

  const after = store.correctRequest(before.runId, items);
  const kept = preservedSelections(before, after, 'item-1');
  assert.equal(kept['item-2']?.productId, before.selections['item-2']?.productId);
  assert.equal(kept['item-1']?.productId, 'hl-beef-150g', 'the edited item takes the fresh default');
});

test('minor units format like the backend', () => {
  assert.equal(formatMinor(12850), 'PHP 128.50');
});
