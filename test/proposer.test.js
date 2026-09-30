import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProposerError,
  createProposer,
  validateProposal,
  controlledProposer,
  openAiCompatibleProposer,
} from '../src/proposer.js';

// All model output in these tests is a controlled fixture. No network is used
// except through an injected fetch that records the request.

const wellFormed = (over = {}) => ({
  items: [
    {
      lineIndex: 0,
      raw: 'Highlands Corned Beef 150g x2',
      name: 'Corned Beef',
      brand: 'Highlands',
      variant: null,
      sizeText: '150 g',
      quantity: 2,
      noSubstitution: false,
      assumptions: [],
      unresolved: [],
      queries: ['Highlands Corned Beef 150g'],
    },
  ],
  ...over,
});

test('validateProposal accepts a well-formed interpretation and preserves raw text', () => {
  const result = validateProposal(wellFormed(), { requestText: 'Highlands Corned Beef 150g x2' });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].raw, 'Highlands Corned Beef 150g x2');
  assert.equal(result.items[0].quantity, 2);
  assert.equal(result.items[0].size.value, 150);
});

test('validateProposal keeps an omitted source line visible instead of dropping it', () => {
  const result = validateProposal(wellFormed(), {
    requestText: 'Highlands Corned Beef 150g x2\nFull cream milk',
  });
  assert.equal(result.items.length, 2);
  const missing = result.items[1];
  assert.equal(missing.raw, 'Full cream milk');
  assert.ok(missing.unresolved.some((u) => /no interpretation/i.test(u)));
  assert.ok(result.problems.some((p) => /omitted line 2/i.test(p)));
});

test('validateProposal restores a dropped explicit no-substitution restriction', () => {
  const raw = wellFormed({
    items: [
      {
        ...wellFormed().items[0],
        raw: 'Highlands Corned Beef 150g x2 — Highlands only, no substitutions',
        noSubstitution: false,
      },
    ],
  });
  const result = validateProposal(raw, {
    requestText: 'Highlands Corned Beef 150g x2 — Highlands only, no substitutions',
  });
  assert.equal(result.items[0].restrictions.noSubstitution, true);
  assert.ok(result.problems.some((p) => /no-substitution/i.test(p)));
});

test('validateProposal never raises the target above an explicit quantity', () => {
  const raw = wellFormed({
    items: [{ ...wellFormed().items[0], quantity: 99 }],
  });
  const result = validateProposal(raw, { requestText: 'Highlands Corned Beef 150g x2' });
  assert.equal(result.items[0].quantity, 2);
  assert.ok(result.problems.some((p) => /quantity/i.test(p)));
});

test('validateProposal marks a model-inferred quantity as a visible assumption', () => {
  const raw = wellFormed({
    items: [{ ...wellFormed().items[0], raw: 'Full cream milk', name: 'Full Cream Milk', brand: null, sizeText: null, quantity: 2 }],
  });
  const result = validateProposal(raw, { requestText: 'Full cream milk' });
  assert.equal(result.items[0].quantity, 2);
  assert.ok(result.items[0].assumptions.some((a) => /quantity/i.test(a)));
});

test('validateProposal drops an invented product id from rankings', () => {
  const raw = wellFormed({
    rankings: [
      { lineIndex: 0, productId: 'hl-beef-150g', rank: 1, rationale: 'exact' },
      { lineIndex: 0, productId: 'made-up-id', rank: 2, rationale: 'invented' },
    ],
  });
  const result = validateProposal(raw, {
    requestText: 'Highlands Corned Beef 150g x2',
    candidatesByLine: { 0: [{ productId: 'hl-beef-150g' }] },
  });
  assert.deepEqual(
    result.rankings.map((r) => r.productId),
    ['hl-beef-150g'],
  );
  assert.ok(result.problems.some((p) => /made-up-id/.test(p)));
});

test('validateProposal fails closed on malformed model output', () => {
  for (const bad of [null, 'text', {}, { items: 'no' }]) {
    const result = validateProposal(bad, { requestText: 'milk' });
    assert.equal(result.ok, false);
    assert.equal(result.items.length, 0);
  }
});

test('controlled proposer interprets each line deterministically and offers bounded queries', async () => {
  const proposer = controlledProposer();
  const { items } = await proposer.interpret({ requestText: 'Highlands Corned Beef 150g x2\nPasta Roma Fusilli 500g x2' });
  assert.equal(items.length, 2);
  assert.equal(items[0].raw, 'Highlands Corned Beef 150g x2');
  assert.ok(items[0].queries.length <= 3);
  assert.ok(items.every((i) => typeof i.lineIndex === 'number'));
});

test('controlled proposer ranks only discovered candidates', async () => {
  const proposer = controlledProposer();
  const { items } = await proposer.interpret({ requestText: 'Highlands Corned Beef 150g x2' });
  const candidatesByLine = {
    0: [{ productId: 'hl-beef-150g' }, { productId: 'hl-beef-260g' }],
  };
  const { rankings } = await proposer.rank({ requestText: 'Highlands Corned Beef 150g x2', items, candidatesByLine });
  const ids = rankings.map((r) => r.productId).sort();
  assert.deepEqual(ids, ['hl-beef-150g', 'hl-beef-260g']);
  assert.ok(rankings.every((r) => typeof r.rationale === 'string' && r.rationale.length > 0));
});

test('openai-compatible proposer sends no tools and parses structured output', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: JSON.stringify(wellFormed()) } }] };
      },
    };
  };
  const proposer = openAiCompatibleProposer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl,
  });
  const result = await proposer.interpret({ requestText: 'Highlands Corned Beef 150g x2' });
  assert.equal(result.items.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(requests[0].options.headers.authorization, 'Bearer test-key');
  assert.equal(requests[0].body.tools, undefined);
  assert.equal(requests[0].body.model, 'test-model');
  assert.doesNotMatch(requests[0].options.body, /test-key/);
});

test('openai-compatible proposer fails closed on a non-2xx response', async () => {
  const proposer = openAiCompatibleProposer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => ({ ok: false, status: 500, async json() { return {}; } }),
  });
  await assert.rejects(() => proposer.interpret({ requestText: 'milk' }), ProposerError);
});

test('openai-compatible proposer fails closed on unparseable model content', async () => {
  const proposer = openAiCompatibleProposer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content: 'not json' } }] };
      },
    }),
  });
  await assert.rejects(() => proposer.interpret({ requestText: 'milk' }), ProposerError);
});

test('model call attempts are bounded', async () => {
  let calls = 0;
  const proposer = openAiCompatibleProposer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    model: 'm',
    maxCalls: 2,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: JSON.stringify(wellFormed()) } }] };
        },
      };
    },
  });
  await proposer.interpret({ requestText: 'a' });
  await proposer.interpret({ requestText: 'b' });
  await assert.rejects(() => proposer.interpret({ requestText: 'c' }), ProposerError);
  assert.equal(calls, 2);
});

test('createProposer without configuration fails closed rather than guessing a provider', () => {
  const proposer = createProposer({ provider: 'openai-compatible' });
  assert.equal(proposer.configured, false);
  return assert.rejects(() => proposer.interpret({ requestText: 'milk' }), ProposerError);
});

test('validateProposal never lets the model change an explicit brand', () => {
  const raw = wellFormed({ items: [{ ...wellFormed().items[0], brand: 'CDO' }] });
  const result = validateProposal(raw, { requestText: 'Highlands Corned Beef 150g x2' });
  assert.equal(result.items[0].brand, 'Highlands');
  assert.ok(result.problems.some((p) => /explicit brand/i.test(p)));
});

test('validateProposal never lets the model change an explicit size', () => {
  const raw = wellFormed({ items: [{ ...wellFormed().items[0], sizeText: '260 g' }] });
  const result = validateProposal(raw, { requestText: 'Highlands Corned Beef 150g x2' });
  assert.equal(result.items[0].size.value, 150);
  assert.ok(result.problems.some((p) => /explicit size/i.test(p)));
});

test('validateProposal marks a model-inferred brand and size as visible assumptions', () => {
  const raw = wellFormed({
    items: [{ ...wellFormed().items[0], raw: 'Full cream milk', name: 'Full Cream Milk', brand: 'Arla', sizeText: '1 L', quantity: 1 }],
  });
  const result = validateProposal(raw, { requestText: 'Full cream milk' });
  assert.equal(result.items[0].brand, 'Arla');
  assert.equal(result.items[0].size.value, 1000);
  assert.ok(result.items[0].assumptions.some((a) => /brand/i.test(a)));
  assert.ok(result.items[0].assumptions.some((a) => /size/i.test(a)));
});

// --- Review fixes: inferred attributes must not satisfy the gate ------------

test('a model-inferred brand and size are marked inferred, not explicit', () => {
  const raw = wellFormed({
    items: [{ ...wellFormed().items[0], raw: 'Full cream milk', name: 'Full Cream Milk', brand: 'Arla', sizeText: '1 L', quantity: 1 }],
  });
  const result = validateProposal(raw, { requestText: 'Full cream milk' });
  assert.equal(result.items[0].brand, 'Arla');
  assert.equal(result.items[0].inferred.brand, true);
  assert.equal(result.items[0].inferred.size, true);
});

test('an explicit brand that is absent from the catalogue still counts as explicit', () => {
  const raw = wellFormed({
    items: [
      {
        ...wellFormed().items[0],
        raw: 'Anchor Full Cream Milk 1L only, no substitutions',
        name: 'Full Cream Milk',
        brand: 'Anchor',
        sizeText: '1 L',
        noSubstitution: true,
        quantity: 1,
      },
    ],
  });
  const result = validateProposal(raw, { requestText: 'Anchor Full Cream Milk 1L only, no substitutions' });
  assert.equal(result.items[0].brand, 'Anchor');
  assert.equal(result.items[0].inferred.brand, false, 'a brand named in the text is an explicit constraint');
  assert.equal(result.items[0].restrictions.noSubstitution, true);
});

test('an explicit quantity in the middle of a line is detected and protected', () => {
  const raw = wellFormed({
    items: [{ ...wellFormed().items[0], raw: 'Highlands Corned Beef 150g x2 — no substitutions', quantity: 99, noSubstitution: true }],
  });
  const result = validateProposal(raw, { requestText: 'Highlands Corned Beef 150g x2 — no substitutions' });
  assert.equal(result.items[0].quantity, 2);
  assert.ok(result.problems.some((p) => /quantity/i.test(p)));
});

test('the model timeout stays active while the response body is read', async () => {
  const proposer = openAiCompatibleProposer({
    baseUrl: 'https://model.example/v1',
    apiKey: 'k',
    model: 'm',
    timeoutMs: 20,
    fetchImpl: async (url, options) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    }),
  });
  await assert.rejects(() => proposer.interpret({ requestText: 'milk' }), ProposerError);
});
