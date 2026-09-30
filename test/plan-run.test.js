import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { controlledProposer, ProposerError } from '../src/proposer.js';
import { startServer } from '../src/server.js';
import { DEMO_CART } from '../src/index.js';

const REQUEST = 'Highlands Corned Beef 150g x2';

function storeWith(proposer) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-plan-'));
  const store = createStore({ dataDir, stepDelayMs: 0, proposer });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  return store;
}

test('planRun records a controlled interpretation and application-discovered candidates', async () => {
  const store = storeWith(controlledProposer());
  const run = await store.planRun(REQUEST);
  assert.equal(run.items.length, 1);
  assert.equal(run.items[0].raw, REQUEST);
  assert.equal(run.interpretation.provider, 'controlled');
  assert.equal(run.interpretation.fallback, false);
  assert.ok(run.candidates['item-1'].length > 0);
});

test('planRun falls back to the offline interpreter when no model is configured, and says so', async () => {
  const store = storeWith(null);
  const run = await store.planRun(REQUEST);
  assert.equal(run.interpretation.fallback, true);
  assert.equal(run.interpretation.provider, 'controlled');
});

test('an invented candidate id from the model is dropped before it can be selected', async () => {
  const proposer = {
    provider: 'stub',
    configured: true,
    async interpret() {
      return controlledProposer().interpret({ requestText: REQUEST });
    },
    async rank() {
      return {
        rankings: [
          { lineIndex: 0, productId: 'hl-beef-150g', rank: 1, rationale: 'exact' },
          { lineIndex: 0, productId: 'invented-9999', rank: 2, rationale: 'made up' },
        ],
        problems: ['dropped ranking for unsupported product id invented-9999 on line 1'],
      };
    },
  };
  const store = storeWith(proposer);
  const run = await store.planRun(REQUEST);
  const ids = run.candidates['item-1'].map((c) => c.product.id);
  assert.ok(!ids.includes('invented-9999'));
  assert.ok(run.interpretation.problems.some((p) => /invented-9999/.test(p)));
});

test('a model ranking is attached to the candidate without changing its colour', async () => {
  const proposer = {
    provider: 'stub',
    configured: true,
    async interpret() {
      return controlledProposer().interpret({ requestText: REQUEST });
    },
    async rank({ candidatesByLine }) {
      const rankings = [];
      for (const [line, list] of Object.entries(candidatesByLine)) {
        for (const c of list) {
          rankings.push({ lineIndex: Number(line), productId: c.product.id, rank: c.product.id === 'hl-beef-260g' ? 1 : 2, rationale: 'stub' });
        }
      }
      return { rankings, problems: [] };
    },
  };
  const store = storeWith(proposer);
  const run = await store.planRun(REQUEST);
  const big = run.candidates['item-1'].find((c) => c.product.id === 'hl-beef-260g');
  assert.equal(big.modelRank, 1);
  assert.equal(big.color, 'orange', 'a top rank cannot upgrade a substitution to green');
});

test('a model that drops an explicit restriction cannot relax it', async () => {
  const restrictedRequest = 'Highlands Corned Beef 150g x2 — Highlands only, no substitutions';
  const proposer = {
    provider: 'stub',
    configured: true,
    async interpret() {
      return {
        ok: true,
        items: [
          {
            id: 'item-1',
            lineIndex: 0,
            raw: restrictedRequest,
            name: 'Corned Beef',
            brand: 'Highlands',
            variant: null,
            size: null,
            sizeText: '150 g',
            quantity: 2,
            restrictions: { noSubstitution: false },
            assumptions: [],
            unresolved: [],
            queries: [],
          },
        ],
        rankings: [],
        problems: ['model dropped an explicit no-substitution restriction on line 1; restored it'],
      };
    },
    async rank() {
      return { rankings: [], problems: [] };
    },
  };
  const store = storeWith(proposer);
  const run = await store.planRun(restrictedRequest);
  assert.equal(run.items[0].restrictions.noSubstitution, true);
});

test('model failure fails closed without creating a run', async () => {
  const proposer = {
    provider: 'stub',
    configured: true,
    async interpret() {
      throw new ProposerError('http', 'provider down');
    },
    async rank() {
      return { rankings: [], problems: [] };
    },
  };
  const store = storeWith(proposer);
  await assert.rejects(() => store.planRun(REQUEST), (err) => err.code === 'model-failed');
  assert.equal(store.snapshot().runs.length, 0);
});

test('planRun is blocked by the same safety gates as createRun', async () => {
  const store = storeWith(controlledProposer());
  store.fatal = { reason: 'journal unreadable' };
  await assert.rejects(() => store.planRun(REQUEST), (err) => err.code === 'blocked');
});

test('the HTTP /api/run route uses the proposal pipeline', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-plan-http-'));
  const store = createStore({ dataDir, stepDelayMs: 0, proposer: controlledProposer() });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  const { server, csrfToken, url } = await startServer(store, { port: 0 });
  const base = url.replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-rehearsal-csrf': csrfToken },
      body: JSON.stringify({ requestText: REQUEST }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.run.interpretation.provider, 'controlled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
