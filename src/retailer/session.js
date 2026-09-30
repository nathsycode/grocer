// Dedicated retailer session boundary (ADR-0006).
//
// The retailer browser session is isolated from the operator's everyday
// browser, retained under .local/ (gitignored, 0700) and never written to the
// safety journal, logs, or model context. The operator signs in directly; this
// module never sees credentials or verification codes.
//
// Every read is gated on a *verified* shopping context: a known intended
// account and branch, a live sign-in, and a successful read. Wrong/unknown
// account or branch, expired authentication, or a failed cart read prevent the
// context from becoming execution-ready. Ticket 02 has not yet established how
// to identify the signed-in account/branch, so the real Playwright driver
// deliberately reports them as unknown and the gate stays closed.
//
// The browser library is imported lazily, so the dependency-free rehearsal runs
// without Playwright installed.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeObservedProduct } from './normalize.js';
import {
  RETAILER_ORIGIN,
  classifyReadRequest,
  classifyReadResponse,
  applyReadOnlyRoute,
} from './read-only-guard.js';

export { RETAILER_ORIGIN, classifyReadRequest, classifyReadResponse, applyReadOnlyRoute };

export class SessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Journal-safe cart lines: no line key, no raw session or header values. */
export function redactCartLines(lines) {
  return (lines ?? []).map((line) => ({
    productId: line.productId ?? null,
    quantity: line.quantity ?? null,
    sku: line.sku ?? null,
    money: line.money
      ? {
          minor: line.money.minor ?? null,
          currency: line.money.currency ?? null,
          display: line.money.display ?? null,
          unresolved: Boolean(line.money.unresolved),
        }
      : null,
  }));
}

/**
 * @param {object} options
 * @param {string} options.dataDir          root local data directory (.local)
 * @param {object} options.driver           injected browser driver (see createPlaywrightDriver)
 * @param {{account:string,branch:string}} options.expectedContext
 */
export function createRetailerSession({ dataDir, driver, expectedContext = { account: null, branch: null } }) {
  const sessionDir = path.join(dataDir, 'retailer-session');
  const profileDir = path.join(sessionDir, 'profile');
  let opened = false;
  let verified = false;
  let stopped = false;
  let lastContext = null;
  let lastStatus = null;
  let lastCart = null;

  // In-flight operations are tracked so handoff can wait for them to observe
  // `stopped` and refuse before the browser automation is detached.
  const pending = new Set();
  function track(fn) {
    const promise = (async () => fn())();
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }
  function stoppedStatus() {
    verified = false;
    return {
      verified: false,
      state: 'handed-off',
      context: lastContext,
      problems: ['retailer automation is stopped for manual checkout handoff'],
    };
  }
  function stoppedCart() {
    return {
      ok: false,
      lines: [],
      context: lastContext,
      observedAt: new Date().toISOString(),
      problems: ['retailer automation is stopped for manual checkout handoff'],
    };
  }

  function prepareProfile() {
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    // mkdir mode is ignored when the directory already exists, so tighten it.
    for (const dir of [sessionDir, profileDir]) {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        /* best effort; a filesystem without POSIX modes is out of scope */
      }
    }
  }

  async function ensureOpen() {
    if (opened) return;
    prepareProfile();
    await driver.open({ profileDir });
    opened = true;
  }

  async function verifyContext() {
    // Any re-check revokes authority until it succeeds again, so a failed
    // session check can never leave a previous `verified` in force.
    verified = false;
    if (stopped) {
      return stoppedStatus();
    }
    try {
      await ensureOpen();
    } catch (err) {
      return { verified: false, state: 'unknown', context: null, problems: [err.message] };
    }
    if (stopped) return stoppedStatus();
    let info;
    try {
      info = await driver.sessionInfo();
    } catch (err) {
      return { verified: false, state: 'unknown', context: null, problems: [`session check failed: ${err.message}`] };
    }
    if (stopped) return stoppedStatus();
    const context = { account: info?.account ?? null, branch: info?.branch ?? null };
    const problems = [...(info?.problems ?? [])];
    if (!expectedContext.account) problems.push('no intended account is configured; refusing to verify');
    if (!expectedContext.branch) problems.push('no intended branch is configured; refusing to verify');
    if (info?.expired) {
      verified = false;
      lastContext = context;
      return {
        verified: false,
        state: 'expired',
        context,
        problems: [...problems, 'authentication expired; sign in again in the dedicated retailer browser'],
      };
    }
    if (!info?.signedIn) {
      verified = false;
      lastContext = context;
      return { verified: false, state: 'signed-out', context, problems: [...problems, 'not signed in to the retailer browser'] };
    }
    if (!info.account) problems.push('the signed-in account could not be established');
    else if (expectedContext.account && info.account !== expectedContext.account) {
      problems.push('wrong account: the signed-in account is not the configured one');
    }
    if (!info.branch) problems.push('the branch/location could not be established');
    else if (expectedContext.branch && info.branch !== expectedContext.branch) {
      problems.push('wrong branch: the selected branch is not the configured one');
    }
    verified = problems.length === 0;
    if (stopped) return stoppedStatus();
    lastContext = context;
    lastStatus = { verified, state: verified ? 'verified' : 'signed-in-unverified', context, problems };
    return lastStatus;
  }

  async function readCart() {
    if (stopped) {
      return stoppedCart();
    }
    if (!verified) {
      const status = await verifyContext();
      if (stopped) return stoppedCart();
      if (!status.verified) {
        return {
          ok: false,
          lines: [],
          context: status.context,
          observedAt: new Date().toISOString(),
          problems: ['the shopping context is not verified', ...status.problems],
        };
      }
    }
    try {
      const result = await driver.readCart();
      // Handoff may have happened while the read was in flight: discard the
      // result and refuse rather than restoring authority after handoff.
      if (stopped) return stoppedCart();
      const ctx = result?.context ?? null;
      const problems = [...(result?.problems ?? [])];
      if (!ctx || ctx.account !== lastContext?.account || ctx.branch !== lastContext?.branch) {
        problems.push('the cart read did not confirm the verified shopping context');
      }
      if (problems.length) {
        verified = false;
        return { ok: false, lines: [], context: ctx ?? lastContext, observedAt: new Date().toISOString(), problems };
      }
      const lines = Array.isArray(result?.lines) ? result.lines : [];
      lastCart = {
        ok: true,
        lines: redactCartLines(lines),
        context: ctx,
        observedAt: new Date().toISOString(),
        note: lines.length ? null : 'the cart read succeeded but returned no lines',
      };
      return { ...lastCart, problems: [] };
    } catch (err) {
      verified = false;
      return {
        ok: false,
        lines: [],
        context: lastContext,
        observedAt: new Date().toISOString(),
        problems: [`cart read failed: ${err.message}`],
      };
    }
  }

  return {
    sessionDir,
    profileDir,
    verifyContext: () => track(verifyContext),
    readCart: () => track(readCart),
    /**
     * Stop every automated retailer read, navigation, and mutation for the
     * handoff while leaving the dedicated browser open for the operator's
     * manual checkout (ADR-0006). In-flight reads are allowed to observe the
     * stop and refuse before the browser automation is detached, so nothing
     * can start or complete a retailer read after handoff returns.
     */
    async handoff() {
      stopped = true;
      verified = false;
      await Promise.allSettled([...pending]);
      try {
        await driver.handoff?.();
      } catch {
        /* best effort: the stopped flag already refuses further reads */
      }
    },
    status() {
      return {
        available: true,
        opened,
        verified,
        stopped,
        state: stopped ? 'handed-off' : (lastStatus?.state ?? 'not-checked'),
        context: lastContext,
        problems: lastStatus?.problems ?? [],
        cart: lastCart,
      };
    },
    async close() {
      try {
        await driver.close?.();
      } finally {
        opened = false;
      }
    },
  };
}

/**
 * Backend-owned Playwright driver. Kept thin and lazy: it launches the isolated
 * persistent context, installs the read-only guard, and reads the cart through
 * the observed `/api/cart` route. Account/branch identification is not
 * established by ticket 02, so `sessionInfo` reports them unknown and the gate
 * stays closed until retailer evidence resolves it.
 */
export function createPlaywrightDriver({ retailerOrigin = RETAILER_ORIGIN, channel = 'chrome', headless = false } = {}) {
  let context = null;
  let page = null;
  let chromium = null;

  async function open({ profileDir }) {
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      throw new SessionError('driver-unavailable', 'playwright is not installed; run: npm install --no-save playwright@1.63.0');
    }
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      channel,
      viewport: { width: 1280, height: 900 },
      serviceWorkers: 'block',
    });
    page = context.pages()[0] ?? (await context.newPage());
    await context.route('**/*', (route) => applyReadOnlyRoute(route, { retailerOrigin }));
  }

  async function sessionInfo() {
    if (!page) throw new SessionError('not-open', 'the retailer browser is not open');
    // Ticket 02 has not established a reliable signed-in account/branch
    // identifier. Reporting them unknown keeps the gate closed rather than
    // guessing from page chrome.
    return {
      signedIn: false,
      expired: false,
      account: null,
      branch: null,
      problems: ['signed-in account and branch identification is not established; ticket 02 evidence is required'],
    };
  }

  async function readCart() {
    if (!page) throw new SessionError('not-open', 'the retailer browser is not open');
    const captured = new Promise((resolve) => {
      const onResponse = async (res) => {
        let parsed;
        try {
          parsed = new URL(res.url());
        } catch {
          return;
        }
        if (parsed.origin !== retailerOrigin || !/^\/api\/cart(\/|$)/.test(parsed.pathname)) return;
        page.off('response', onResponse);
        try {
          resolve(await res.json());
        } catch {
          resolve(null);
        }
      };
      page.on('response', onResponse);
    });
    await page.goto(`${retailerOrigin}/cart`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const body = await captured;
    const items = body?.cart?.items;
    if (!Array.isArray(items)) throw new SessionError('cart-unreadable', 'the cart response had no readable items array');
    const lines = items.map((item) => normalizeObservedProduct(item, { source: 'cart' }));
    return { lines, context: null, problems: [] };
  }

  async function close() {
    if (context) await context.close().catch(() => {});
    context = null;
    page = null;
  }

  async function handoff() {
    // Stop intercepting the retailer origin so the operator's own manual
    // checkout interactions are not mediated by the application, but do not
    // close the browser: the operator continues in it (ADR-0006).
    if (context) await context.unroute('**/*').catch(() => {});
    page = null;
  }

  return { open, sessionInfo, readCart, close, handoff };
}
