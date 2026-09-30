// Repeatable evidence-backed review demo (ticket 03). Runs entirely offline
// with the controlled proposer and a synthetic cart. It ends at a reviewed and
// recorded approval: no live retailer, no model call, and no cart write.
// Run with: npm run demo:review

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { controlledProposer } from '../src/proposer.js';
import { DEMO_CART } from '../src/index.js';

const REQUEST = `Highlands Corned Beef 150g x2
Pasta Roma Fusilli 500g x2
Full cream milk
Tulip only, no substitutions — Tulip Luncheon Meat 150g x2`;

const heading = (text) => console.log(`\n=== ${text} ===`);

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-review-demo-'));
  const store = createStore({ dataDir, stepDelayMs: 0, proposer: controlledProposer() });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  console.log('OFFLINE REVIEW DEMO — synthetic catalogue and cart. No model call, no retailer, no cart write.');

  heading('1. Proposal and application-controlled discovery');
  const run = await store.planRun(REQUEST);
  console.log(`interpretation: ${run.interpretation.provider}${run.interpretation.fallback ? ' (offline fallback)' : ''}`);
  for (const problem of run.interpretation.problems) console.log(`  validation: ${problem}`);

  heading('2. Evidence-backed review');
  for (const item of run.items) {
    console.log(`\nrequested: ${item.raw}`);
    console.log(`  interpreted: brand=${item.brand ?? '—'} variant=${item.variant ?? '—'} size=${item.sizeText ?? '—'} target=${item.quantity}${item.restrictions.noSubstitution ? ' [no substitutions]' : ''}`);
    for (const assumption of item.assumptions) console.log(`  assumption: ${assumption}`);
    for (const unresolved of item.unresolved) console.log(`  unresolved: ${unresolved}`);
    for (const candidate of run.candidates[item.id] ?? []) {
      const selected = run.selections[item.id]?.productId === candidate.product.id ? ' <- preselected' : '';
      const rank = candidate.modelRank != null ? ` rank=${candidate.modelRank}` : '';
      console.log(
        `  [${candidate.color}${rank}] ${candidate.product.brand} ${candidate.product.name} ${candidate.product.sizeDisplay} (${candidate.product.priceDisplay}) — ${candidate.reason}${selected}`,
      );
    }
  }

  heading('3. Plan (requested quantity is a target total)');
  const plan = store.reviewPlan(run.runId);
  for (const action of plan.actions) {
    console.log(`  ${action.raw}: existing=${action.existing} target=${action.target} ${action.kind} ${action.units} executable=${action.executable}`);
    for (const assumption of action.assumptions) console.log(`    assumption: ${assumption}`);
  }
  for (const u of plan.unfulfilled) console.log(`  unfulfilled: ${u.raw} — ${u.reason}`);

  heading('4. Explicit approval (the slice ends here)');
  const approval = store.approvePlan(run.runId);
  console.log(`  approval ${approval.approvalId.slice(0, 8)} recorded over ${approval.actions.length} executable action(s)`);
  console.log('  live cart writes remain disabled in this slice; the reviewed cart is not prepared.');

  heading('5. Controlled model output that drops a restriction and invents an id');
  const sneaky = {
    provider: 'stub',
    configured: true,
    async interpret() {
      return {
        items: [
          {
            lineIndex: 0,
            name: 'Corned Beef',
            brand: 'Highlands',
            variant: null,
            sizeText: '150 g',
            quantity: 2,
            noSubstitution: false,
            assumptions: [],
            unresolved: [],
            queries: [],
          },
        ],
        rankings: [{ lineIndex: 0, productId: 'invented-9999', rank: 1, rationale: 'trust me' }],
      };
    },
    async rank() {
      return { rankings: [{ lineIndex: 0, productId: 'invented-9999', rank: 1, rationale: 'trust me' }] };
    },
  };
  const store2 = createStore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-review-demo2-')), stepDelayMs: 0, proposer: sneaky });
  store2.load();
  store2.simulator.seedCart({});
  const run2 = await store2.planRun('Highlands Corned Beef 150g x2 — Highlands only, no substitutions');
  console.log(`  restriction restored: ${run2.items[0].restrictions.noSubstitution}`);
  console.log(`  invented id present in candidates: ${(run2.candidates['item-1'] ?? []).some((c) => c.product.id === 'invented-9999')}`);
  for (const problem of run2.interpretation.problems) console.log(`  validation: ${problem}`);

  console.log('\nReview demo complete. Data directories are temporary and were not cleaned automatically.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
