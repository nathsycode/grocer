// Landmark signed-in read-only probe — investigation tool for ticket 02.
//
// This is NOT application code and does not become the app's retailer
// integration. It gathers redacted evidence about the operator's signed-in
// Landmark shopping context and existing cart so the MVP can later tell a
// known cart from an uncertain one. It performs reads only.
//
// Safety boundaries:
//   - a dedicated, isolated browser profile under .local/ (never the everyday
//     browser profile)
//   - the operator signs in directly in that browser; credentials and
//     verification codes never pass through this process
//   - after sign-in, every non-GET/HEAD request to the retailer origin is
//     aborted, non-rendering cross-origin requests are aborted, and
//     checkout/logout navigation is blocked
//   - only /api/ JSON bodies and query parameters are recorded, and both are
//     redacted before anything is written; request header and cookie values
//     are never read or stored (names only)
//   - no retries, no mutations, no order/payment actions
//
// Usage: see docs/integrations/landmark/signed-in-read-probe-procedure.md

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

export const RETAILER_ORIGIN = 'https://www.landmark.ph';
export const HOME_URL = `${RETAILER_ORIGIN}/`;

const DEFAULT_PROFILE_DIR = '.local/landmark-probe/profile';
const DEFAULT_OUT_DIR = '.local/landmark-probe/evidence';

const MAX_ARRAY = 50;
const MAX_DEPTH = 8;
const MAX_STRING = 500;

// Fields that identify a person. Collapsed entirely; never digests, because a
// digest of an email or phone number is still a linkable identifier.
const PERSONAL_KEY = /(email|e_mail|phone|mobile|address|postcode|postal|zip|first_?name|last_?name|full_?name|billing|shipping)/i;

// Opaque identifiers and secrets. Kept only as a short digest plus length, so
// the operator can confirm the same account/cart across runs without the value
// being published.
const OPAQUE_KEY = /(nonce|token|secret|password|passwd|auth|session|cookie|csrf|api[-_]?key|^key$|_key$|customer|account_?id|user_?id|user_?name|login)/i;

// Query parameters that describe shopping context rather than the operator.
// These are the evidence ticket 02 needs, and they were already public in the
// 2026-09-29 anonymous probe.
const CONTEXT_PARAMS = new Set([
  'substoreId',
  'substoreAlias',
  'storeId',
  'branchId',
  'locationId',
  'page',
  'limit',
  'categoryId',
]);

// Cross-origin resource types needed for the page to render. Everything else
// cross-origin is blocked so the probe does not send data to third parties.
const RENDER_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);

const BLOCKED_NAV = /^\/(checkout|logout|my-account\/orders)/i;

export function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/** Values that are plainly opaque regardless of their field name. */
export function looksOpaque(value) {
  return /^[0-9a-f]{32,}$/i.test(value) || /^eyJ[\w-]+\.[\w-]+\./.test(value);
}

/** The only shape an opaque identifier or secret is ever published in. */
export function opaque(value) {
  return { redacted: true, digest: digest(value), length: String(value).length };
}

export function redactScalar(value, key = '') {
  if (typeof value !== 'string') {
    return OPAQUE_KEY.test(key) ? opaque(value) : value;
  }
  if (PERSONAL_KEY.test(key)) return '<redacted:personal>';
  if (OPAQUE_KEY.test(key) || looksOpaque(value)) return opaque(value);
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}<truncated>` : value;
}

/**
 * Deep-copy retailer-controlled data with sensitive values replaced. Applied to
 * response bodies and query parameters only; curated metadata built by this
 * probe (header names, cookie names) is safe by construction.
 */
export function redactEvidence(value, key = '', depth = 0) {
  if (PERSONAL_KEY.test(key)) return '<redacted:personal>';
  if (value === null || typeof value !== 'object') return redactScalar(value, key);
  if (OPAQUE_KEY.test(key)) return '<redacted:opaque-subtree>';
  if (depth >= MAX_DEPTH) return '<max-depth>';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactEvidence(v, key, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`<+${value.length - MAX_ARRAY} more>`);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactEvidence(v, k, depth + 1);
  return out;
}

export function redactQuery(searchParams) {
  const out = {};
  for (const [k, v] of searchParams) {
    out[k] = CONTEXT_PARAMS.has(k) ? v : opaque(v);
  }
  return out;
}

/**
 * Read-only gate. `allow` is the only action that reaches the retailer; every
 * other decision is recorded as evidence rather than silently dropped.
 */
export function classifyRequest({
  method,
  url,
  retailerOrigin = RETAILER_ORIGIN,
  isNavigation = false,
  resourceType = 'other',
}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { action: 'abort', reason: 'unparseable-url' };
  }
  const isRead = method === 'GET' || method === 'HEAD';
  if (parsed.origin !== retailerOrigin) {
    if (isRead && RENDER_TYPES.has(resourceType)) return { action: 'allow' };
    return { action: 'abort', reason: 'cross-origin' };
  }
  if (!isRead) return { action: 'abort', reason: `non-read-method:${method}` };
  if (isNavigation && BLOCKED_NAV.test(parsed.pathname)) {
    return { action: 'abort', reason: 'blocked-navigation' };
  }
  return { action: 'allow' };
}

/** Cart-line view that keeps product identity and cart-line keys distinct. */
export function extractCartLines(body) {
  const items = body?.cart?.items;
  if (!Array.isArray(items)) return null;
  return items.map((item) => ({
    productId: item?.id ?? null,
    productIdType: typeof item?.id,
    lineKey: typeof item?.key === 'string' ? opaque(item.key) : null,
    type: item?.type ?? null,
    quantity: item?.quantity ?? null,
    sku: item?.sku ?? null,
    name: item?.name ?? null,
    price: item?.prices?.price ?? null,
    currency: item?.prices?.currency_code ?? null,
    minorUnit: item?.prices?.currency_minor_unit ?? null,
  }));
}

/**
 * Collapse byte-identical observations, keeping a repeat count. Storefronts
 * may poll the same read repeatedly; the repeat count is itself evidence.
 */
export function dedupeObservations(observations) {
  const seen = new Map();
  for (const observation of observations) {
    const key = JSON.stringify(observation);
    const existing = seen.get(key);
    if (existing) existing.seen += 1;
    else seen.set(key, { ...observation, seen: 1 });
  }
  return [...seen.values()];
}

export function redactUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const query = redactQuery(parsed.searchParams);
  // JSON, not URLSearchParams: redacted values are objects, not strings.
  const suffix = Object.keys(query).length ? `?${JSON.stringify(query)}` : '';
  return `${parsed.origin}${parsed.pathname}${suffix}`;
}

export function parseArgs(argv) {
  const opts = {
    profile: DEFAULT_PROFILE_DIR,
    out: DEFAULT_OUT_DIR,
    channel: 'chrome',
    keepOpen: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') opts.profile = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--channel') opts.channel = argv[++i];
    else if (arg === '--keep-open') opts.keepOpen = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const HELP = `Landmark signed-in read-only probe (ticket 02 investigation tool).

  node scripts/landmark-probe.js [options]

Options:
  --profile <dir>   isolated browser profile (default ${DEFAULT_PROFILE_DIR})
  --out <dir>       redacted evidence output (default ${DEFAULT_OUT_DIR})
  --channel <name>  chrome | chromium | msedge (default chrome)
  --keep-open       leave the browser open when the probe finishes
  -h, --help        show this message

Reads only. See docs/integrations/landmark/signed-in-read-probe-procedure.md.`;

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return;
  }

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error(
      'playwright is not installed. Run:\n' +
        '  npm install --no-save playwright@1.63.0\n' +
        '  npx playwright install chromium   # only if not using --channel chrome\n',
    );
    process.exitCode = 1;
    return;
  }

  const profileDir = path.resolve(opts.profile);
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(profileDir, { recursive: true });

  const evidence = {
    probe: {
      name: 'landmark-signed-in-read-probe',
      version: 1,
      retailerOrigin: RETAILER_ORIGIN,
      channel: opts.channel,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      readOnlyGuard:
        'phase B: non-GET/HEAD to the retailer origin aborted; non-rendering cross-origin requests aborted; checkout/logout navigation blocked',
    },
    authorisation: {
      intendedAccountConfirmed: null,
      assertedBranchLabel: null,
      operatorStatement: null,
    },
    session: { cookies: [], storageKeys: [] },
    observations: [],
    blockedRequests: [],
    cart: null,
    productDetail: null,
    correspondence: null,
    blockers: [],
  };

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: opts.channel,
    viewport: { width: 1280, height: 900 },
    serviceWorkers: 'block',
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (text) => rl.question(text);
  const pending = [];

  try {
    console.log(
      '\nLandmark signed-in read-only probe.\n' +
        'This opens a dedicated isolated browser profile. Sign in there directly;\n' +
        'credentials and verification codes must never be typed into this terminal.\n' +
        `Profile: ${profileDir}\n`,
    );

    await page
      .goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch((err) => evidence.blockers.push(`homepage load failed: ${err.message}`));

    await ask(
      '\n1. In the browser, sign in and confirm the intended account and branch.\n' +
        '   Press Enter when the storefront shows your intended account and branch. ',
    );
    evidence.authorisation.intendedAccountConfirmed = (await ask(
      '2. Is the signed-in account the intended one? [y/N] ',
    ))
      .trim()
      .toLowerCase()
      .startsWith('y');
    evidence.authorisation.assertedBranchLabel = (
      await ask('3. What branch/location label does the storefront show? (no personal data) ')
    ).trim();
    evidence.authorisation.operatorStatement = (
      await ask('4. Anything else about the context worth recording? (optional, no secrets) ')
    ).trim();

    // Read-only capture starts here: the operator is signed in, so the guard
    // cannot interfere with login.
    const onResponse = (res) => {
      const req = res.request();
      let parsed;
      try {
        parsed = new URL(res.url());
      } catch {
        return;
      }
      if (parsed.origin !== RETAILER_ORIGIN || !parsed.pathname.startsWith('/api/')) return;
      const record = {
        method: req.method(),
        path: parsed.pathname,
        query: redactQuery(parsed.searchParams),
        status: res.status(),
        requestHeaderNames: Object.keys(req.headers()).sort(),
        contentType: (res.headers()['content-type'] ?? '').split(';')[0],
        body: null,
      };
      evidence.observations.push(record);
      if (record.contentType.includes('json')) {
        pending.push(
          res
            .json()
            .then((body) => {
              // Extract line evidence from the raw body, then redact it; the
              // extractor digests the cart-line key itself.
              const lines = extractCartLines(body);
              if (lines) record.cartLines = lines;
              record.body = redactEvidence(body);
            })
            .catch(() => {
              record.body = '<unreadable>';
            }),
        );
      }
    };
    page.on('response', onResponse);
    await context.route('**/*', async (route) => {
      const req = route.request();
      const decision = classifyRequest({
        method: req.method(),
        url: req.url(),
        isNavigation: req.isNavigationRequest(),
        resourceType: req.resourceType(),
      });
      if (decision.action === 'abort') {
        evidence.blockedRequests.push({
          method: req.method(),
          url: redactUrl(req.url()),
          reason: decision.reason,
        });
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    const flushObservations = async (ms = 1500) => {
      await page.waitForTimeout(ms);
      await Promise.allSettled(pending.splice(0));
    };

    console.log(
      '\nRead-only capture is active: non-GET requests to landmark.ph are blocked.\n' +
        'Do not click Add to Cart; the guard is a safety net, not a licence to mutate.\n',
    );
    await ask('5. Open your cart page in the browser, then press Enter here. ');
    await flushObservations();
    await ask(
      '6. Open one simple, fixed-unit product page from the cart (click the product, not Add to Cart), then press Enter. ',
    );
    await flushObservations();

    evidence.observations = dedupeObservations(evidence.observations);

    evidence.session.cookies = (await context.cookies()).map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite,
      session: c.session,
    }));
    for (const open of context.pages()) {
      if (!open.url().startsWith(RETAILER_ORIGIN)) continue;
      const keys = await open
        .evaluate(() => ({ localStorage: Object.keys(localStorage), sessionStorage: Object.keys(sessionStorage) }))
        .catch(() => null);
      evidence.session.storageKeys.push({ url: redactUrl(open.url()), keys });
    }

    const cartObs = evidence.observations.filter(
      (o) => o.method === 'GET' && /^\/api\/cart(\/|$)/.test(o.path),
    );
    const cartRecord = cartObs.at(-1) ?? null;
    if (!cartRecord) {
      evidence.cart = { observed: false };
      evidence.blockers.push('no GET /api/cart observation was captured');
    } else {
      const lines = cartRecord.cartLines ?? null;
      evidence.cart = {
        observed: true,
        sourcePath: cartRecord.path,
        query: cartRecord.query,
        status: cartRecord.status,
        requestHeaderNames: cartRecord.requestHeaderNames,
        lineCount: Array.isArray(lines) ? lines.length : null,
        lines,
        body: cartRecord.body,
      };
      if (!lines || lines.length === 0) {
        evidence.blockers.push(
          'cart read succeeded but no populated cart lines were observed; a populated example is still required',
        );
      }
    }

    const detailObs = evidence.observations.filter(
      (o) => o.method === 'GET' && /^\/api\/products\/\d+$/.test(o.path),
    );
    const lineIds = new Set((evidence.cart?.lines ?? []).map((l) => String(l.productId)));
    const detailRecord =
      detailObs.find((o) => lineIds.has(o.path.split('/').pop())) ?? detailObs.at(-1) ?? null;
    if (!detailRecord) {
      evidence.productDetail = { observed: false };
      evidence.blockers.push('no GET /api/products/<id> observation was captured');
    } else {
      evidence.productDetail = {
        observed: true,
        sourcePath: detailRecord.path,
        status: detailRecord.status,
        requestHeaderNames: detailRecord.requestHeaderNames,
        body: detailRecord.body,
      };
      const line =
        (evidence.cart?.lines ?? []).find(
          (l) => String(l.productId) === detailRecord.path.split('/').pop(),
        ) ?? null;
      const detail = detailRecord.body ?? {};
      if (line) {
        evidence.correspondence = {
          productId: line.productId,
          productIdTypeDifference: line.productIdType !== typeof detail.id,
          skuMatch: line.sku != null && detail.sku != null ? line.sku === detail.sku : null,
          typeMatch: line.type != null && detail.type != null ? line.type === detail.type : null,
          cartPrice: { amount: line.price, currency: line.currency, minorUnit: line.minorUnit },
          detailPrice: detail.priceRange?.minVariantPrice ?? null,
          note: 'equality here is observed representation, not proof of identity rules',
        };
      } else {
        evidence.blockers.push('no cart line matched the captured product detail by id');
      }
    }

    if (evidence.blockedRequests.some((r) => r.reason === 'cross-origin')) {
      evidence.blockers.push(
        'some cross-origin requests were blocked; if the storefront rendered incorrectly, note it before rerunning',
      );
    }
  } finally {
    evidence.probe.finishedAt = new Date().toISOString();
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(
      outDir,
      `landmark-read-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    );
    fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
    rl.close();
    if (!opts.keepOpen) await context.close().catch(() => {});
    console.log(
      `\nRedacted evidence written to ${outFile}\n` +
        'Share only this file. Review it before sharing; it should contain no names,\n' +
        'emails, addresses, session values, header values, or cart-line key values.\n' +
        (opts.keepOpen ? 'The browser was left open as requested.\n' : ''),
    );
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
