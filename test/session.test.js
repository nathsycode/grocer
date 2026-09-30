import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRetailerSession, redactCartLines, SessionError } from '../src/retailer/session.js';

const EXPECTED = { account: 'intended-account', branch: 'intended-branch' };

function fakeDriver(over = {}) {
  const calls = { sessionInfo: 0, readCart: 0, open: 0, close: 0 };
  const driver = {
    calls,
    async open() {
      calls.open += 1;
    },
    async sessionInfo() {
      calls.sessionInfo += 1;
      return { signedIn: true, expired: false, account: 'intended-account', branch: 'intended-branch', problems: [] };
    },
    async readCart() {
      calls.readCart += 1;
      return {
        context: { account: 'intended-account', branch: 'intended-branch' },
        lines: [
          {
            productId: '39943',
            lineKey: 'e3efe0ad5b37b75621ec60cc1d3176ef',
            quantity: 1,
            sku: 'TNM-5263',
            money: { minor: 46900, currency: 'PHP', display: 'PHP 469.00', unresolved: false },
          },
        ],
        problems: [],
      };
    },
    async close() {
      calls.close += 1;
    },
    ...over,
  };
  return driver;
}

function withSession(fn, { driver = fakeDriver(), expected = EXPECTED, dataDir } = {}) {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-session-'));
  const session = createRetailerSession({ dataDir: dir, driver, expectedContext: expected });
  return Promise.resolve(fn({ session, driver, dataDir: dir })).finally(() => session.close());
}

test('a signed-in account and branch matching the intended context verify', async () => {
  await withSession(async ({ session }) => {
    const status = await session.verifyContext();
    assert.equal(status.verified, true);
    assert.equal(status.state, 'verified');
    assert.deepEqual(status.problems, []);
  });
});

test('a wrong account does not verify and blocks cart reads', async () => {
  const driver = fakeDriver({
    async sessionInfo() {
      return { signedIn: true, expired: false, account: 'someone-else', branch: 'intended-branch', problems: [] };
    },
  });
  await withSession(
    async ({ session }) => {
      const status = await session.verifyContext();
      assert.equal(status.verified, false);
      assert.ok(status.problems.some((p) => /account/i.test(p)));
      const cart = await session.readCart();
      assert.equal(cart.ok, false);
      assert.equal(driver.calls.readCart, 0, 'a failed context check must not read the cart');
    },
    { driver },
  );
});

test('an unknown branch does not verify', async () => {
  const driver = fakeDriver({
    async sessionInfo() {
      return { signedIn: true, expired: false, account: 'intended-account', branch: null, problems: [] };
    },
  });
  await withSession(
    async ({ session }) => {
      const status = await session.verifyContext();
      assert.equal(status.verified, false);
      assert.ok(status.problems.some((p) => /branch/i.test(p)));
    },
    { driver },
  );
});

test('expired authentication requires a fresh human login and does not verify', async () => {
  const driver = fakeDriver({
    async sessionInfo() {
      return { signedIn: false, expired: true, account: null, branch: null, problems: [] };
    },
  });
  await withSession(
    async ({ session }) => {
      const status = await session.verifyContext();
      assert.equal(status.state, 'expired');
      assert.equal(status.verified, false);
    },
    { driver },
  );
});

test('a verified context returns normalized cart lines', async () => {
  await withSession(async ({ session }) => {
    await session.verifyContext();
    const cart = await session.readCart();
    assert.equal(cart.ok, true);
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0].productId, '39943');
    assert.equal(cart.lines[0].quantity, 1);
  });
});

test('a failed cart read fails closed rather than returning an empty cart', async () => {
  const driver = fakeDriver({
    async readCart() {
      throw new Error('403 Forbidden');
    },
  });
  await withSession(
    async ({ session }) => {
      await session.verifyContext();
      const cart = await session.readCart();
      assert.equal(cart.ok, false);
      assert.ok(cart.problems.some((p) => /cart read failed/i.test(p)));
    },
    { driver },
  );
});

test('a driver that cannot be opened fails closed', async () => {
  const driver = fakeDriver({
    async open() {
      throw new SessionError('driver-unavailable', 'playwright is not installed');
    },
  });
  await withSession(
    async ({ session }) => {
      const status = await session.verifyContext();
      assert.equal(status.verified, false);
      assert.ok(status.problems.some((p) => /playwright/i.test(p)));
    },
    { driver },
  );
});

test('the retained session profile lives under .local and outside the safety journal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-session-'));
  await withSession(
    async ({ session }) => {
      const status = await session.verifyContext();
      assert.equal(status.verified, true);
    },
    { dataDir },
  );
  assert.ok(fs.existsSync(path.join(dataDir, 'retailer-session')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'journal.jsonl')), 'the session must not write the safety journal');
  const mode = fs.statSync(path.join(dataDir, 'retailer-session')).mode & 0o777;
  assert.equal(mode, 0o700, 'retained session state must not be world-readable');
});

test('redactCartLines drops the cart-line key and other sensitive fields', () => {
  const [line] = redactCartLines([
    { productId: '39943', lineKey: 'secret-key', quantity: 1, sku: 'TNM-5263', money: { minor: 46900 } },
  ]);
  assert.equal(line.productId, '39943');
  assert.equal(line.quantity, 1);
  assert.equal(line.lineKey, undefined);
  assert.equal(line.sku, 'TNM-5263');
});

test('the session never stores account or session data in the journal', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-session-'));
  await withSession(
    async ({ session }) => {
      await session.verifyContext();
      await session.readCart();
    },
    { dataDir },
  );
  assert.ok(!fs.existsSync(path.join(dataDir, 'journal.jsonl')));
});
