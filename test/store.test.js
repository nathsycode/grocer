import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStore } from '../src/store.js';
import { Journal, JournalError, ExecutionLock } from '../src/journal.js';
import { DEMO_CART, DEMO_REQUEST } from '../src/index.js';

function newStore({ faults = {}, cart = DEMO_CART } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-store-'));
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

function waitForLine(child, needle, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`child process did not report ${needle}`));
    }, timeoutMs);
    rl.on('line', (line) => {
      if (line.includes(needle)) {
        clearTimeout(timer);
        rl.close();
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child process exited early (${code})`));
    });
  });
}

async function reviewAndExecute(store, selections) {
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, selections);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  await waitIdle(store);
  return run.runId;
}

const SELECTIONS = {
  'item-1': { productId: 'hl-beef-150g' },
  'item-2': { productId: 'pr-fusilli-500g' },
};

test('approved plan adds the shortfall, preserves extras, and withholds an unapproved reduction', async () => {
  const store = newStore();
  await reviewAndExecute(store, SELECTIONS);

  const cart = store.simulator.cart();
  assert.equal(cart['hl-beef-150g'], 2, 'target 2 from one existing unit adds one');
  assert.equal(cart['hl-beef-260g'], 1, 'different configuration preserved');
  assert.equal(cart['pr-fusilli-500g'], 3, 'unapproved reduction retained');
  assert.equal(cart['mccormick-seasoning-200g'], 1, 'unrelated contents preserved');

  const snapshot = store.snapshot();
  assert.equal(snapshot.run.status, 'completed');
  assert.equal(snapshot.run.verification.fulfilled.length, 1);
  assert.equal(snapshot.run.verification.discrepancies.length, 1);
  assert.match(snapshot.run.verification.discrepancies[0].note, /not approved/i);
  assert.deepEqual(
    snapshot.run.verification.extras.map((e) => e.productId).sort(),
    ['hl-beef-260g', 'mccormick-seasoning-200g'],
  );
  assert.equal(countRecords(store, 'mutation_intent'), 1, 'only the shortfall was dispatched');
});

test('an unchanged rerun at target performs no mutation', async () => {
  const store = newStore();
  await reviewAndExecute(store, SELECTIONS);
  const before = store.simulator.cart();

  store.createRun(DEMO_REQUEST);
  store.setSelections(store.currentRun().runId, SELECTIONS);
  store.reviewPlan(store.currentRun().runId);
  store.approvePlan(store.currentRun().runId);
  store.startExecution(store.currentRun().runId);
  await waitIdle(store);

  assert.deepEqual(store.simulator.cart(), before);
  assert.equal(countRecords(store, 'mutation_intent'), 1, 'rerun added no new mutation');
  assert.equal(store.snapshot().run.status, 'completed');
});

test('an explicitly approved reduction is executed', async () => {
  const store = newStore();
  const run = store.createRun('Pasta Roma Fusilli 500g x2');
  store.setSelections(run.runId, { 'item-1': { productId: 'pr-fusilli-500g', approveReduction: true } });
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  await waitIdle(store);
  assert.equal(store.simulator.cart()['pr-fusilli-500g'], 2);
});

test('a duplicate execution submission cannot execute a plan twice', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);

  store.startExecution(run.runId);
  await assert.rejects(async () => store.startExecution(run.runId), (err) => err.code === 'owned');
  await waitIdle(store);
  await assert.rejects(async () => store.startExecution(run.runId), (err) => err.code === 'already-executed');
  assert.equal(countRecords(store, 'mutation_intent'), 1);
});

test('storage failure before dispatch issues no mutation', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);

  const realAppend = store.journal.append.bind(store.journal);
  store.journal.append = (type, fields) => {
    if (type === 'mutation_intent') throw new JournalError('injected intent failure');
    return realAppend(type, fields);
  };

  store.startExecution(run.runId);
  await waitIdle(store);
  store.journal.append = realAppend;
  store.refresh();

  assert.equal(store.simulator.cart()['hl-beef-150g'], 1, 'no mutation reached the simulator');
  assert.equal(countRecords(store, 'mutation_intent'), 0);
  assert.equal(store.snapshot().run.status, 'paused');

  const result = store.reconcile(run.runId);
  assert.equal(result.stillBlocked, false);
  assert.equal(store.snapshot().ownership.held, false);
});

test('a dispatched but unrecorded result leaves an unresolved attempt that blocks execution', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);

  const realAppend = store.journal.append.bind(store.journal);
  store.journal.append = (type, fields) => {
    if (type === 'mutation_outcome') throw new JournalError('injected outcome failure');
    return realAppend(type, fields);
  };

  store.startExecution(run.runId);
  await waitIdle(store);
  store.journal.append = realAppend;
  store.refresh();

  assert.equal(store.simulator.cart()['hl-beef-150g'], 2, 'the mutation did reach the simulator');
  assert.equal(countRecords(store, 'mutation_outcome'), 0, 'the result was not recorded');
  assert.equal(store.snapshot().openAttempts.length, 1);
  assert.equal(store.snapshot().blocked.kind, 'uncertain');

  const other = store.createRun(DEMO_REQUEST);
  assert.throws(() => store.setSelections(other.runId, SELECTIONS), (err) => err.code === 'blocked');

  const result = store.reconcile(run.runId);
  assert.equal(result.stillBlocked, false, 'simulator operation status resolves the attempt');
  assert.equal(store.snapshot().ownership.held, false);
});

test('an unknown mutation outcome keeps execution blocked through reconciliation', async () => {
  const store = newStore({ faults: { 'hl-beef-150g': 'timeout-unknown' } });
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  await waitIdle(store);

  assert.equal(store.snapshot().blocked.kind, 'uncertain');
  assert.equal(store.snapshot().ownership.held, true, 'a paused unresolved run retains ownership');

  const result = store.reconcile(run.runId);
  assert.equal(result.stillBlocked, true);
  assert.equal(store.snapshot().ownership.held, true);

  const other = store.createRun(DEMO_REQUEST);
  assert.throws(() => store.setSelections(other.runId, SELECTIONS), (err) => err.code === 'blocked');
});

test('a timed-out but applied mutation is resolved by reconciliation evidence, not by the cart read', async () => {
  const store = newStore({ faults: { 'hl-beef-150g': 'timeout-applied' } });
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.startExecution(run.runId);
  await waitIdle(store);

  assert.equal(store.snapshot().openAttempts[0].outcome.status, 'unknown');
  assert.equal(store.simulator.cart()['hl-beef-150g'], 2);

  const result = store.reconcile(run.runId);
  assert.equal(result.stillBlocked, false);
  assert.equal(store.snapshot().ownership.held, false);
});

test('a new store on the same journal exposes paused state and cannot continue or bypass it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-restart-'));
  const first = createStore({ dataDir, stepDelayMs: 0, faults: { 'hl-beef-150g': 'timeout-unknown' } });
  first.load();
  first.simulator.seedCart(DEMO_CART);
  const run = first.createRun(DEMO_REQUEST);
  first.setSelections(run.runId, SELECTIONS);
  first.reviewPlan(run.runId);
  first.approvePlan(run.runId);
  first.startExecution(run.runId);
  await waitIdle(first);
  assert.equal(first.snapshot().blocked.kind, 'uncertain');

  const second = createStore({ dataDir, stepDelayMs: 0 });
  second.load();
  assert.equal(second.snapshot().blocked.kind, 'uncertain', 'restart fails closed');
  const restarted = second.createRun(DEMO_REQUEST);
  assert.throws(() => second.setSelections(restarted.runId, SELECTIONS), (err) => err.code === 'blocked');
});

test('unreadable expected journal state fails closed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-corrupt-'));
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'journal.jsonl'), 'this is not json\n');
  const store = createStore({ dataDir, stepDelayMs: 0 });
  const snapshot = store.load();
  assert.equal(snapshot.blocked.kind, 'fatal');
  assert.throws(() => store.createRun(DEMO_REQUEST), (err) => err.code === 'blocked');
});

test('unreadable simulated retailer state fails closed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-sim-corrupt-'));
  createStore({ dataDir, stepDelayMs: 0 }).load();
  fs.writeFileSync(path.join(dataDir, 'simulator.json'), 'not json');
  const restarted = createStore({ dataDir, stepDelayMs: 0 });
  const snapshot = restarted.load();
  assert.equal(snapshot.blocked.kind, 'fatal');
  assert.match(snapshot.blocked.reason, /retailer state unreadable/i);
  assert.throws(() => restarted.createRun(DEMO_REQUEST), (err) => err.code === 'blocked');
});

test('execution continues after the requesting caller goes away', async () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  // startExecution returns before work completes; nothing keeps the caller alive.
  const { started } = store.startExecution(run.runId);
  assert.equal(started, true);
  await waitIdle(store);
  assert.equal(store.snapshot().run.status, 'completed');
});

test('correcting the request invalidates the approval and re-evaluates candidates', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  assert.ok(store.snapshot().run.approval, 'approved before correction');

  const corrected = store.correctRequest(run.runId, [
    { id: 'item-1', raw: 'CDO Corned Beef 150g x2', name: 'Corned Beef', brand: 'CDO', sizeText: '150g', quantity: 2 },
    { id: 'item-2', raw: 'Pasta Roma Fusilli 500g x2', name: 'Fusilli', brand: 'Pasta Roma', sizeText: '500g', quantity: 2 },
  ]);
  assert.equal(corrected.approval, null, 'approval does not survive a request change');
  assert.equal(corrected.status, 'review');
  const cdo = corrected.candidates['item-1'].find((c) => c.product.id === 'cdo-beef-150g');
  assert.equal(cdo.color, 'green', 'the corrected explicit brand now matches exactly');
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'no-approval');
});

test('changing the reviewed selection after approval requires re-approval', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  const after = store.setSelections(run.runId, {
    ...SELECTIONS,
    'item-2': { productId: 'pr-fusilli-1kg' },
  });
  assert.equal(after.approval, null);
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'no-approval');
});

test('a reviewed plan cannot be silently approved over a conflicting-evidence candidate', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  assert.throws(
    () => store.setSelections(run.runId, { 'item-1': { productId: 'conflict-beef-150g' } }),
    (err) => err.code === 'invalid-selection',
  );
});

test('a cart change between approval and execution pauses for reevaluation', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  // Someone empties the matching unit after approval (ADR-0003 concurrent edit).
  store.simulator.seedCart({ 'hl-beef-260g': 1, 'pr-fusilli-500g': 3, 'mccormick-seasoning-200g': 1 });
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
  assert.equal(store.simulator.cart()['hl-beef-150g'], undefined, 'no mutation was dispatched');
  assert.ok(store.journal.readAll().some((r) => r.type === 'approval_invalidated'));
});

test('a unit-price increase after approval requires renewed approval', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.catalog = store.catalog.map((p) => (p.id === 'hl-beef-150g' ? { ...p, priceMinor: 9999 } : p));
  assert.throws(() => store.startExecution(run.runId), (err) => err.code === 'invalid-approval');
});

test('re-reviewing a plan invalidates an existing approval', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  store.reviewPlan(run.runId);
  assert.equal(store.snapshot().run.approval, null);
});

test('reconciliation does not release ownership held by another live process', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-live-owner-'));
  const moduleUrl = pathToFileURL(path.resolve('src/store.js')).href;
  const childScript = `
    import { createStore } from ${JSON.stringify(moduleUrl)};
    const store = createStore({ dataDir: ${JSON.stringify(dataDir)}, stepDelayMs: 10000 });
    store.load();
    store.simulator.seedCart({ 'hl-beef-150g': 1 });
    const run = store.createRun('Highlands Corned Beef 150g x2');
    store.setSelections(run.runId, { 'item-1': { productId: 'hl-beef-150g' } });
    store.reviewPlan(run.runId);
    store.approvePlan(run.runId);
    store.startExecution(run.runId);
    console.log('EXECUTING');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await waitForLine(child, 'EXECUTING');
    const other = createStore({ dataDir, stepDelayMs: 0 });
    other.load();
    const runId = other.currentRun().runId;
    const result = other.reconcile(runId);
    assert.equal(result.stillBlocked, true, 'a live owner must not be released');
    assert.equal(other.snapshot().ownership.held, true);
    assert.throws(() => other.startExecution(runId), (err) => err.code === 'owned' || err.code === 'blocked');
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
  }
});

test('a run interrupted after execution_started cannot continue after restart', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-interrupted-'));
  const first = createStore({ dataDir, stepDelayMs: 0 });
  first.load();
  first.simulator.seedCart(DEMO_CART);
  const run = first.createRun(DEMO_REQUEST);
  first.setSelections(run.runId, SELECTIONS);
  first.reviewPlan(run.runId);
  first.approvePlan(run.runId);
  // Simulate a crash after ownership was taken and execution started, before
  // any mutation intent was written.
  const journal = new Journal(path.join(dataDir, 'journal.jsonl'));
  journal.append('ownership_acquired', { runId: run.runId, ownerPid: 2_147_483_646 });
  journal.append('execution_started', { runId: run.runId });
  new ExecutionLock(path.join(dataDir, 'execution.lock')).acquire({ runId: run.runId });

  const restarted = createStore({ dataDir, stepDelayMs: 0 });
  restarted.load();
  assert.equal(restarted.snapshot().blocked.kind, 'ownership');
  assert.throws(() => restarted.startExecution(run.runId), (err) => err.code === 'owned' || err.code === 'blocked');
  assert.equal(restarted.simulator.cart()['hl-beef-150g'], 1, 'nothing was dispatched on restart');

  const result = restarted.reconcile(run.runId);
  assert.equal(result.stillBlocked, false);
  assert.equal(restarted.snapshot().ownership.held, false);
  // The interrupted run itself is never continued; a fresh run is required.
  assert.throws(() => restarted.startExecution(run.runId), (err) => err.code === 'blocked');

  const fresh = restarted.createRun(DEMO_REQUEST);
  restarted.setSelections(fresh.runId, SELECTIONS);
  restarted.reviewPlan(fresh.runId);
  restarted.approvePlan(fresh.runId);
  restarted.startExecution(fresh.runId);
  await waitIdle(restarted);
  assert.equal(restarted.simulator.cart()['hl-beef-150g'], 2);
});

test('a missing journal with prior state fails closed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-missing-journal-'));
  const store = createStore({ dataDir, stepDelayMs: 0 });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  store.createRun(DEMO_REQUEST);
  store.simulator.dispatch({ opId: 'op-seed', productId: 'hl-beef-150g', to: 2 });
  fs.rmSync(path.join(dataDir, 'journal.jsonl'), { force: true });

  const restarted = createStore({ dataDir, stepDelayMs: 0 });
  const snapshot = restarted.load();
  assert.equal(snapshot.blocked.kind, 'fatal');
  assert.match(snapshot.blocked.reason, /journal is missing/i);
  assert.throws(() => restarted.createRun(DEMO_REQUEST), (err) => err.code === 'blocked');
});

test('a missing journal with a leftover lock fails closed', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-missing-lock-'));
  const store = createStore({ dataDir, stepDelayMs: 0 });
  store.load();
  store.createRun(DEMO_REQUEST);
  store.lock.acquire({ runId: 'leftover' });
  fs.rmSync(path.join(dataDir, 'journal.jsonl'), { force: true });

  const restarted = createStore({ dataDir, stepDelayMs: 0 });
  const snapshot = restarted.load();
  assert.equal(snapshot.blocked.kind, 'fatal');
});

test('approval is rejected when the reviewed plan drifted from the observed cart', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  // The matching unit is removed after review but before approval.
  store.simulator.seedCart({ 'hl-beef-260g': 1, 'pr-fusilli-500g': 3, 'mccormick-seasoning-200g': 1 });
  assert.throws(() => store.approvePlan(run.runId), (err) => err.code === 'stale-review');
  assert.equal(store.snapshot().run.approval, null);
});

test('approval is rejected when a reviewed price has risen', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.catalog = store.catalog.map((p) => (p.id === 'hl-beef-150g' ? { ...p, priceMinor: 9999 } : p));
  assert.throws(() => store.approvePlan(run.runId), (err) => err.code === 'stale-review');
});

test('two stores sharing a simulator do not overwrite each other', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-shared-sim-'));
  const a = createStore({ dataDir, stepDelayMs: 0 });
  a.load();
  a.simulator.seedCart({ 'hl-beef-150g': 1 });
  const b = createStore({ dataDir, stepDelayMs: 0 });
  b.load();

  const runA = a.createRun('Highlands Corned Beef 150g x2');
  a.setSelections(runA.runId, { 'item-1': { productId: 'hl-beef-150g' } });
  a.reviewPlan(runA.runId);
  a.approvePlan(runA.runId);
  a.startExecution(runA.runId);
  await waitIdle(a);
  assert.equal(a.simulator.cart()['hl-beef-150g'], 2);

  const runB = b.createRun('Tulip Luncheon Meat 150g x1');
  b.setSelections(runB.runId, { 'item-1': { productId: 'tulip-luncheon-150g' } });
  b.reviewPlan(runB.runId);
  b.approvePlan(runB.runId);
  b.startExecution(runB.runId);
  await waitIdle(b);

  const cart = b.simulator.cart();
  assert.equal(cart['hl-beef-150g'], 2, "the first store's committed change was preserved");
  assert.equal(cart['tulip-luncheon-150g'], 1, 'the second store applied its own change');
});

test('invalid corrections are rejected instead of silently altered', () => {
  const store = newStore();
  const run = store.createRun(DEMO_REQUEST);
  const base = { id: 'item-1', raw: 'Highlands Corned Beef 150g x2', name: 'Corned Beef', brand: 'Highlands' };
  assert.throws(() => store.correctRequest(run.runId, [{ ...base, sizeText: 'not-a-size', quantity: 2 }]), (e) => e.code === 'invalid');
  assert.throws(() => store.correctRequest(run.runId, [{ ...base, sizeText: '150g', quantity: 0 }]), (e) => e.code === 'invalid');
  assert.throws(() => store.correctRequest(run.runId, [{ ...base, sizeText: '150g', quantity: 2.5 }]), (e) => e.code === 'invalid');
  assert.throws(() => store.correctRequest(run.runId, [{ ...base, name: '', sizeText: '150g', quantity: 2 }]), (e) => e.code === 'invalid');

  const corrected = store.correctRequest(run.runId, [
    { ...base, sizeText: '150g', quantity: 2 },
    { id: 'item-2', raw: 'Pasta Roma Fusilli 500g x2', name: 'Fusilli', brand: 'Pasta Roma', sizeText: '500g', quantity: 2 },
  ]);
  assert.equal(corrected.items[0].size.value, 150);
  assert.equal(corrected.items[0].quantity, 2);
});

test('a restart with surviving ownership invalidates the previous approval', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-foreign-approval-'));
  const store = createStore({ dataDir, stepDelayMs: 0 });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  const run = store.createRun(DEMO_REQUEST);
  store.setSelections(run.runId, SELECTIONS);
  store.reviewPlan(run.runId);
  store.approvePlan(run.runId);
  assert.equal(store.snapshot().run.approvalValid, true);

  // A previous process approved the plan, then died holding ownership.
  const deadPid = 2_147_483_646;
  fs.writeFileSync(
    path.join(dataDir, 'execution.lock'),
    JSON.stringify({ runId: run.runId, pid: deadPid, ts: new Date().toISOString() }),
  );
  new Journal(path.join(dataDir, 'journal.jsonl')).append('ownership_acquired', {
    runId: run.runId,
    ownerPid: deadPid,
  });

  const restarted = createStore({ dataDir, stepDelayMs: 0 });
  restarted.load();
  assert.equal(restarted.snapshot().run.approvalValid, false, 'the old approval is invalid after a restart');
  assert.equal(restarted.snapshot().blocked.kind, 'ownership');
  assert.throws(() => restarted.startExecution(run.runId), (err) => err.code === 'owned' || err.code === 'blocked');
});
