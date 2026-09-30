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
