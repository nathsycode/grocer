// Reproducible local demo of the rehearsal slice. Runs entirely against the
// synthetic simulator in a throwaway directory. No network, no model, no
// retailer. Run with: npm run demo

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { DEMO_CART, DEMO_REQUEST } from '../src/index.js';

const waitIdle = async (store) => {
  while (store.executing) await new Promise((resolve) => setTimeout(resolve, 10));
};

const heading = (text) => console.log(`\n=== ${text} ===`);
const show = (label, value) => console.log(`${label}: ${value}`);

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-demo-'));
  const store = createStore({ dataDir, stepDelayMs: 50 });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  console.log('SIMULATION — synthetic catalogue and cart. This demo cannot reach Landmark.');

  heading('1. Request and interpretation');
  const run = store.createRun(DEMO_REQUEST);
  for (const item of run.items) {
    show('raw', item.raw);
    show('  interpreted', `brand=${item.brand} size=${item.size?.display} target=${item.quantity}`);
  }

  heading('2. Candidates and preselection');
  for (const item of run.items) {
    for (const candidate of run.candidates[item.id]) {
      const chosen = run.selections[item.id]?.productId === candidate.product.id ? ' <- preselected' : '';
      console.log(
        `  [${candidate.color}] ${candidate.product.brand} ${candidate.product.name} ${candidate.product.sizeDisplay} (${candidate.product.priceDisplay}) ${candidate.reason}${chosen}`,
      );
    }
  }
  show('cart before', JSON.stringify(store.simulator.cart()));

  heading('3. Review the plan (quantity is a target total)');
  const plan = store.reviewPlan(run.runId);
  for (const action of plan.actions) {
    show(
      `  ${action.raw}`,
      `existing=${action.existing} target=${action.target} change=${action.kind} units=${action.units} executable=${action.executable}`,
    );
  }

  heading('4. Explicit plan approval');
  const approval = store.approvePlan(run.runId);
  show('approval', `${approval.approvalId} over ${approval.actions.length} executable action(s)`);

  heading('5. Execute the approved plan against the simulator');
  store.startExecution(run.runId);
  await waitIdle(store);
  show('cart after', JSON.stringify(store.simulator.cart()));
  show('status', store.snapshot().run.status);

  const v = store.snapshot().run.verification;
  for (const f of v.fulfilled) console.log(`  fulfilled: ${f.productId} -> target ${f.target}`);
  for (const d of v.discrepancies) console.log(`  discrepancy: ${d.productId} expected ${d.expected} observed ${d.observed} (${d.note})`);
  for (const e of v.extras) console.log(`  preserved extra: ${e.label} x${e.quantity}`);

  heading('6. Unchanged rerun at target makes no addition');
  const rerun = store.createRun(DEMO_REQUEST);
  store.setSelections(rerun.runId, run.selections);
  store.reviewPlan(rerun.runId);
  store.approvePlan(rerun.runId);
  const intentsBefore = store.journal.readAll().filter((r) => r.type === 'mutation_intent').length;
  store.startExecution(rerun.runId);
  await waitIdle(store);
  const intentsAfter = store.journal.readAll().filter((r) => r.type === 'mutation_intent').length;
  show('cart', JSON.stringify(store.simulator.cart()));
  show('mutation intents', `${intentsBefore} -> ${intentsAfter} (no-op rerun)`);
  const rerunPlan = store.snapshot().run.plan;
  console.log('  rerun intended changes:', rerunPlan.actions.map((a) => `${a.productId}:${a.kind}`).join(', '));
  console.log('  rerun proposes no addition:', !rerunPlan.actions.some((a) => a.kind === 'add'));

  heading('7. An explicitly approved reduction (separate run on a fresh cart)');
  const store2 = createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-demo2-')), stepDelayMs: 20 });
  store2.load();
  store2.simulator.seedCart({ 'pr-fusilli-500g': 3 });
  const reduceRun = store2.createRun('Pasta Roma Fusilli 500g x2');
  store2.setSelections(reduceRun.runId, { 'item-1': { productId: 'pr-fusilli-500g', approveReduction: true } });
  store2.reviewPlan(reduceRun.runId);
  store2.approvePlan(reduceRun.runId);
  store2.startExecution(reduceRun.runId);
  await waitIdle(store2);
  show('cart after approved reduction', JSON.stringify(store2.simulator.cart()));

  console.log('\nDemo complete. Data directories are temporary and were not cleaned automatically.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
