import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStore } from '../src/store.js';
import { startServer, hostAllowed, originAllowed } from '../src/server.js';
import { DEMO_CART, DEMO_REQUEST } from '../src/index.js';

async function withServer(fn, { stepDelayMs = 0 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-http-'));
  const store = createStore({ dataDir, stepDelayMs });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  const { server, csrfToken, url } = await startServer(store, { port: 0 });
  const base = url.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', origin: base, 'x-rehearsal-csrf': csrfToken };
  try {
    return await fn({ store, base, headers, csrfToken });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const SELECTIONS = {
  'item-1': { productId: 'hl-beef-150g' },
  'item-2': { productId: 'pr-fusilli-500g' },
};

test('host and origin guards only accept loopback', () => {
  assert.equal(hostAllowed('127.0.0.1:4180'), true);
  assert.equal(hostAllowed('localhost:4180'), true);
  assert.equal(hostAllowed('[::1]:4180'), true);
  assert.equal(hostAllowed('evil.example'), false);
  assert.equal(originAllowed('http://127.0.0.1:4180'), true);
  assert.equal(originAllowed('http://evil.example'), false);
  assert.equal(originAllowed(undefined), false);
  assert.equal(originAllowed('null'), false);
});

test('the API reports the simulation label and a CSRF token', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/state`);
    const body = await res.json();
    assert.match(body.simulation.label, /cannot reach Landmark/);
    assert.ok(body.csrfToken);
  });
});

test('state-changing requests from another origin or without the token are rejected', async () => {
  await withServer(async ({ base, headers }) => {
    const crossOrigin = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { ...headers, origin: 'http://evil.example' },
      body: JSON.stringify({ requestText: 'milk' }),
    });
    assert.equal(crossOrigin.status, 403);

    const noOrigin = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestText: 'milk' }),
    });
    assert.equal(noOrigin.status, 403);

    const noToken = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ requestText: 'milk' }),
    });
    assert.equal(noToken.status, 403);
  });
});

test('a request with a non-loopback Host header is rejected', async () => {
  await withServer(async ({ base, headers }) => {
    const port = new URL(base).port;
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers: { Host: 'evil.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

test('the documented flow works over HTTP and a duplicate execute is rejected', async () => {
  await withServer(async ({ base, headers, store }) => {
    const created = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestText: DEMO_REQUEST }),
    });
    assert.equal(created.status, 201);
    const { run } = await created.json();

    await fetch(`${base}/api/run/${run.runId}/selection`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ selections: SELECTIONS }),
    });
    const reviewed = await fetch(`${base}/api/run/${run.runId}/plan`, { method: 'POST', headers });
    assert.equal(reviewed.status, 200);
    const approved = await fetch(`${base}/api/run/${run.runId}/approve`, { method: 'POST', headers });
    assert.equal(approved.status, 200);

    const first = await fetch(`${base}/api/run/${run.runId}/execute`, { method: 'POST', headers });
    assert.equal(first.status, 202);
    const second = await fetch(`${base}/api/run/${run.runId}/execute`, { method: 'POST', headers });
    assert.equal(second.status, 409);

    while (store.executing) await new Promise((r) => setTimeout(r, 5));
    assert.equal(store.simulator.cart()['hl-beef-150g'], 2);
  });
});

test('execution continues after the review tab disconnects and is not replayed on reconnect', async () => {
  await withServer(
    async ({ base, headers, store }) => {
      const created = await fetch(`${base}/api/run`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestText: DEMO_REQUEST }),
      });
      const { run } = await created.json();
      await fetch(`${base}/api/run/${run.runId}/selection`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ selections: SELECTIONS }),
      });
      await fetch(`${base}/api/run/${run.runId}/plan`, { method: 'POST', headers });
      await fetch(`${base}/api/run/${run.runId}/approve`, { method: 'POST', headers });

      const controller = new AbortController();
      const pending = fetch(`${base}/api/run/${run.runId}/execute`, { method: 'POST', headers, signal: controller.signal }).catch(() => {});
      // Let the backend receive and start the approved run, then disconnect mid-flight.
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();
      await pending;

      const deadline = Date.now() + 3000;
      let status = 'executing';
      while (Date.now() < deadline) {
        const state = await (await fetch(`${base}/api/state`)).json();
        status = state.run.status;
        if (status === 'completed') break;
        await new Promise((r) => setTimeout(r, 10));
      }
      const mutationsAfter = store.journal.readAll().filter((r) => r.type === 'mutation_intent').length;

      // Reconnecting only reads state; it must not replay the mutation.
      await fetch(`${base}/api/state`);
      const mutationsOnReconnect = store.journal.readAll().filter((r) => r.type === 'mutation_intent').length;

      assert.equal(status, 'completed', 'backend finished approved work after the tab went away');
      assert.equal(mutationsAfter, 1);
      assert.equal(mutationsOnReconnect, 1, 'reconnection must not replay mutations');
    },
    { stepDelayMs: 40 },
  );
});

// --- Retailer session surface (ticket 03) -----------------------------------

async function withSessionServer(fn, session) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-session-http-'));
  const store = createStore({ dataDir, stepDelayMs: 0 });
  store.load();
  store.simulator.seedCart(DEMO_CART);
  const { server, csrfToken, url } = await startServer(store, { port: 0, session });
  const base = url.replace(/\/$/, '');
  const headers = { 'content-type': 'application/json', origin: base, 'x-rehearsal-csrf': csrfToken };
  try {
    return await fn({ store, base, headers });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const fakeSession = {
  status: () => ({ available: true, verified: false, state: 'not-checked', problems: [], cart: null }),
  verifyContext: async () => ({ verified: false, state: 'signed-in-unverified', problems: ['account unknown'] }),
  readCart: async () => ({ ok: false, lines: [], problems: ['context not verified'] }),
};

test('state reports the retailer session without exposing session values', async () => {
  await withSessionServer(async ({ base }) => {
    const body = await (await fetch(`${base}/api/state`)).json();
    assert.equal(body.retailerSession.available, true);
    assert.equal(body.retailerSession.verified, false);
    const session = JSON.stringify(body.retailerSession);
    assert.doesNotMatch(session, /cookie|nonce|authorization|lineKey|password/i);
  }, fakeSession);
});

test('the session verify and cart routes are state-changing and require the CSRF token', async () => {
  await withSessionServer(async ({ base, headers }) => {
    const noToken = await fetch(`${base}/api/retailer/verify`, { method: 'POST', headers: { origin: base } });
    assert.equal(noToken.status, 403);

    const verify = await fetch(`${base}/api/retailer/verify`, { method: 'POST', headers });
    assert.equal(verify.status, 200);
    assert.equal((await verify.json()).session.verified, false);

    const cart = await fetch(`${base}/api/retailer/cart`, { method: 'POST', headers });
    assert.equal(cart.status, 200);
    assert.equal((await cart.json()).cart.ok, false);
  }, fakeSession);
});

test('the session routes are absent when no session is configured', async () => {
  await withServer(async ({ base, headers }) => {
    const res = await fetch(`${base}/api/retailer/verify`, { method: 'POST', headers });
    assert.equal(res.status, 404);
  });
});

// --- Ticket 04: handoff route -----------------------------------------------

test('the handoff route records a terminal handoff and stops the session', async () => {
  const calls = { handoff: 0 };
  const session = {
    status: () => ({ available: true, verified: false, state: 'not-checked', problems: [], cart: null }),
    verifyContext: async () => ({ verified: false }),
    readCart: async () => ({ ok: false, lines: [], problems: [] }),
    async handoff() {
      calls.handoff += 1;
    },
  };
  await withSessionServer(async ({ base, headers, store }) => {
    const created = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ requestText: DEMO_REQUEST }),
    });
    const { run } = await created.json();
    await fetch(`${base}/api/run/${run.runId}/selection`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ selections: SELECTIONS }),
    });
    await fetch(`${base}/api/run/${run.runId}/plan`, { method: 'POST', headers });
    await fetch(`${base}/api/run/${run.runId}/approve`, { method: 'POST', headers });
    await fetch(`${base}/api/run/${run.runId}/execute`, { method: 'POST', headers });
    while (store.executing) await new Promise((r) => setTimeout(r, 5));

    const res = await fetch(`${base}/api/run/${run.runId}/handoff`, { method: 'POST', headers });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.run.status, 'handed-off');
    assert.equal(calls.handoff, 1, 'the session automation is stopped');

    const again = await fetch(`${base}/api/run/${run.runId}/handoff`, { method: 'POST', headers });
    assert.equal(again.status, 409, 'a handed-off run cannot be handed off twice');
  }, session);
});
