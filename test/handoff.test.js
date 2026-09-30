// Offline checks for ticket 04's execution hardening and manual-checkout
// handoff. Everything here runs against the synthetic simulator: no retailer,
// no model, no live write. Faults are injected locally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { DEMO_CART, DEMO_REQUEST } from '../src/index.js';

const SELECTIONS = {
  'item-1': { productId: 'hl-beef-150g' },
  'item-2': { productId: 'pr-fusilli-500g' },
};

function newStore({ faults = {}, cart = DEMO_CART } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-handoff-'));
  const store = createStore({ dataDir, stepDelayMs: 0, faults });
  store.load();
  if (cart) store.simulator.seedCart(cart);
  return store;
}

async function waitIdle(store, timeoutMs = 3000) {
  const start = Date.now();
  while (store.executing) {
    if (Date.now() - start > timeoutMs) throw new Error('execution did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function countRecords(store, type) {
  return store.journal.readAll().filter((r) => r.type === type).length;
}

async function completedRun(store) {
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  await waitIdle(store);
  return run.runId;
}

test('handoff after a verified run is terminal and stops automated activity', async () => {
  const store = newStore();
  const runId = await completedRun(store);
  assert.equal(store.snapshot().run.status, 'completed');

  const handedOff = store.handoff(runId);
  assert.equal(handedOff.status, 'handed-off');
  assert.match(handedOff.handoff.note, /not a recorded purchase/i);
  assert.equal(countRecords(store, 'checkout_handoff'), 1);

  // No further automated mutation or read-based reconciliation for this run.
  assert.throws(() => store.startExecution(runId), (err) => err.code === 'handed-off');
  assert.throws(() => store.reconcile(runId), (err) => err.code === 'handed-off');
  assert.throws(() => store.handoff(runId), (err) => err.code === 'handed-off');
  assert.equal(countRecords(store, 'mutation_intent'), 1, 'handoff must not replay a mutation');
});

test('a later run still requires its own fresh checks and approval after handoff', async () => {
  const store = newStore();
  const first = await completedRun(store);
  store.handoff(first);

  // A new run is allowed, but it must go through review and approval again.
  const second = store.createRun(DEMO_REQUEST);
  assert.equal(second.status, 'review');
  assert.equal(second.approval, null);
  assert.throws(() => store.startExecution(second.runId), (err) => err.code === 'no-approval');
});

test('handoff is refused while an uncertain mutation outcome is unresolved', async () => {
  const store = newStore({ faults: { 'hl-beef-150g': 'timeout-unknown' } });
  const runId = await completedRun(store);
  assert.equal(store.snapshot().blocked.kind, 'uncertain');
  assert.throws(() => store.handoff(runId), (err) => err.code === 'uncertain');
  assert.equal(countRecords(store, 'checkout_handoff'), 0);
});

test('handoff is refused before the plan has been executed and verified', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  assert.throws(() => store.handoff(run.runId), (err) => err.code === 'not-verified');
  assert.equal(countRecords(store, 'checkout_handoff'), 0);
});

test('a partial verified run can be handed off and still reports its discrepancies', async () => {
  const store = newStore();
  const runId = await completedRun(store);
  const verification = store.snapshot().run.verification;
  assert.ok(verification.discrepancies.length >= 1, 'the unapproved reduction is a discrepancy');

  const handedOff = store.handoff(runId);
  assert.equal(handedOff.handoff.discrepancies, verification.discrepancies.length);
  assert.equal(handedOff.handoff.fulfilled, verification.fulfilled.length);
});

test('a product identity change after approval pauses instead of dispatching', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  // Same id, different configuration: a different product.
  store.catalog = store.catalog.map((p) =>
    p.id === 'hl-beef-150g' ? { ...p, size: { ...p.size, value: 999, display: '999 g' } } : p,
  );
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
  assert.equal(countRecords(store, 'mutation_intent'), 0, 'no mutation may be dispatched');
});

test('a product removed from the catalogue after approval pauses instead of dispatching', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.catalog = store.catalog.filter((p) => p.id !== 'hl-beef-150g');
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
  assert.equal(countRecords(store, 'mutation_intent'), 0);
});

test('a shopping-context change after approval requires renewed approval', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.context = { ...store.context, contextId: 'a-different-branch' };
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
  assert.equal(countRecords(store, 'mutation_intent'), 0);
});

// --- Review fixes: fail-closed identity, per-dispatch context, terminal handoff ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a product whose evidence becomes conflicting after approval pauses instead of dispatching', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.catalog = store.catalog.map((p) =>
    p.id === 'hl-beef-150g' ? { ...p, evidenceConflict: true, evidenceNote: 'now conflicting' } : p,
  );
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
  assert.equal(countRecords(store, 'mutation_intent'), 0, 'no mutation may be dispatched');
});

test('a context change between dispatches pauses the remaining actions', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-context-mid-'));
  const store = createStore({ dataDir, stepDelayMs: 60 });
  store.load();
  store.simulator.seedCart({ 'hl-beef-150g': 1 });
  const run = store.createRun('Highlands Corned Beef 150g x2\nTulip Luncheon Meat 150g x1');
  store.setSelections(run.runId, {
    'item-1': { productId: 'hl-beef-150g' },
    'item-2': { productId: 'tulip-luncheon-150g' },
  });
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  while (countRecords(store, 'mutation_intent') < 1) await sleep(5);
  // The first dispatch is done; change context during the inter-dispatch delay.
  store.context = { ...store.context, contextId: 'a-different-branch' };
  await waitIdle(store);
  assert.equal(countRecords(store, 'mutation_intent'), 1, 'the second action must not be dispatched');
  assert.equal(store.snapshot().run.status, 'paused');
});

test('handoff re-reads durable state and refuses while another process has an unresolved mutation', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-handoff-durable-'));
  const owner = createStore({ dataDir, stepDelayMs: 0, faults: { 'tulip-luncheon-150g': 'timeout-unknown' } });
  owner.load();
  owner.simulator.seedCart({ 'hl-beef-150g': 1 });
  const run1 = owner.createRun('Highlands Corned Beef 150g x2');
  owner.setSelections(run1.runId, { 'item-1': { productId: 'hl-beef-150g' } });
  owner.reviewPlan(run1.runId);
  owner.approvePlan(run1.runId);
  owner.startExecution(run1.runId);
  await waitIdle(owner);
  assert.ok(owner.snapshot().run.verification, 'the first run is verified');

  // A second store loads the verified state before the unresolved run exists.
  const stale = createStore({ dataDir, stepDelayMs: 0 });
  stale.load();

  const run2 = owner.createRun('Tulip Luncheon Meat 150g x1');
  owner.setSelections(run2.runId, { 'item-1': { productId: 'tulip-luncheon-150g' } });
  owner.reviewPlan(run2.runId);
  owner.approvePlan(run2.runId);
  owner.startExecution(run2.runId);
  await waitIdle(owner);
  assert.equal(owner.snapshot().blocked.kind, 'uncertain');

  assert.throws(() => stale.handoff(run1.runId), (err) => err.code === 'uncertain');
  assert.equal(countRecords(stale, 'checkout_handoff'), 0);
});

test('a handed-off run cannot be reopened by correcting, re-selecting, reviewing, or approving', async () => {
  const store = newStore();
  const runId = await completedRun(store);
  store.handoff(runId);

  assert.throws(
    () =>
      store.correctRequest(runId, [
        { id: 'item-1', raw: 'Highlands Corned Beef 150g x9', name: 'Corned Beef', brand: 'Highlands', sizeText: '150g', quantity: 9 },
      ]),
    (err) => err.code === 'handed-off',
  );
  assert.throws(() => store.setSelections(runId, SELECTIONS), (err) => err.code === 'handed-off');
  assert.throws(() => store.reviewPlan(runId), (err) => err.code === 'handed-off');
  assert.throws(() => store.approvePlan(runId), (err) => err.code === 'handed-off');
  assert.equal(store.snapshot().run.status, 'handed-off');
  assert.throws(() => store.reconcile(runId), (err) => err.code === 'handed-off');
  assert.throws(() => store.handoff(runId), (err) => err.code === 'handed-off');
});

test('handoff is refused when the plan changed after the recorded verification', async () => {
  const store = newStore();
  const runId = await completedRun(store);
  store.correctRequest(runId, [
    { id: 'item-1', raw: 'Highlands Corned Beef 150g x9', name: 'Corned Beef', brand: 'Highlands', sizeText: '150g', quantity: 9 },
    { id: 'item-2', raw: 'Pasta Roma Fusilli 500g x2', name: 'Fusilli', brand: 'Pasta Roma', sizeText: '500g', quantity: 2 },
  ]);
  store.setSelections(runId, SELECTIONS);
  store.reviewPlan(runId);
  store.approvePlan(runId);
  assert.throws(() => store.handoff(runId), (err) => err.code === 'not-verified');
  assert.equal(countRecords(store, 'checkout_handoff'), 0);
});

test('a unit-price decrease is recorded, reported in verification, and surfaced at handoff', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.catalog = store.catalog.map((p) => (p.id === 'hl-beef-150g' ? { ...p, priceMinor: 4000 } : p));
  store.startExecution(run.runId);
  await waitIdle(store);

  assert.equal(store.simulator.cart()['hl-beef-150g'], 2, 'the decrease may proceed');
  const verification = store.snapshot().run.verification;
  assert.equal(verification.priceDecreases.length, 1);
  assert.equal(verification.priceDecreases[0].approvedMinor, 4690);
  assert.equal(verification.priceDecreases[0].observedMinor, 4000);

  const intent = store.journal.readAll().find((r) => r.type === 'mutation_intent');
  assert.equal(intent.observedPriceMinor, 4000, 'the observed decrease is preserved in the journal');

  const handedOff = store.handoff(run.runId);
  assert.equal(handedOff.handoff.priceDecreases, 1);
});
