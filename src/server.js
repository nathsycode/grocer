// Local HTTP surface for the review UI. Binds loopback, rejects non-loopback
// Host/Origin, and requires a session CSRF token on state-changing requests.
// It exposes no browser, shell, or arbitrary network action.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { StoreError } from './store.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHostname(hostname) {
  return LOOPBACK.has(hostname);
}

export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  try {
    return isLoopbackHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function originAllowed(originHeader) {
  if (!originHeader || originHeader === 'null') return false;
  try {
    return isLoopbackHostname(new URL(originHeader).hostname);
  } catch {
    return false;
  }
}

const STATUS_BY_CODE = {
  blocked: 409,
  owned: 409,
  uncertain: 409,
  'no-approval': 409,
  'already-executed': 409,
  'invalid-approval': 409,
  'stale-review': 409,
  'invalid-selection': 400,
  invalid: 400,
  'not-found': 404,
  storage: 500,
  'model-failed': 502,
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new StoreError('invalid', 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new StoreError('invalid', 'request body must be valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function createApp(store, { publicDir = path.resolve('public'), session = null } = {}) {
  const csrfToken = crypto.randomUUID();

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) {
        return sendJson(res, 403, { error: 'requests must target loopback on this computer' });
      }

      const url = new URL(req.url, `http://${req.headers.host}`);
      const { pathname } = url;

      if (pathname.startsWith('/api/')) {
        return await handleApi(req, res, pathname, store, csrfToken, session);
      }
      return serveStatic(res, publicDir, pathname);
    } catch (err) {
      if (err instanceof StoreError) {
        return sendJson(res, STATUS_BY_CODE[err.code] ?? 500, { error: err.message, code: err.code });
      }
      return sendJson(res, 500, { error: `unexpected server error: ${err.message}` });
    }
  });

  return { server, csrfToken };
}

async function handleApi(req, res, pathname, store, csrfToken, session) {
  if (req.method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, {
      ...store.load(),
      csrfToken,
      retailerSession: session ? session.status() : { available: false },
    });
  }
  if (req.method === 'GET' && pathname === '/api/journal') {
    store.refresh();
    return sendJson(res, 200, { records: store.safeJournalTail(500) });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: `method ${req.method} not allowed` });
  }

  // State-changing requests must be same-computer and carry the session token.
  if (!originAllowed(req.headers.origin)) {
    return sendJson(res, 403, { error: 'state-changing requests must originate from this local review UI' });
  }
  if (req.headers['x-rehearsal-csrf'] !== csrfToken) {
    return sendJson(res, 403, { error: 'missing or invalid CSRF token' });
  }

  const body = await readJsonBody(req);

  if (pathname === '/api/retailer/verify' || pathname === '/api/retailer/cart') {
    if (!session) return sendJson(res, 404, { error: 'no retailer session is configured' });
    if (pathname === '/api/retailer/verify') {
      return sendJson(res, 200, { session: await session.verifyContext() });
    }
    return sendJson(res, 200, { cart: await session.readCart(), session: session.status() });
  }

  if (pathname === '/api/run') {
    const run = await store.planRun(body.requestText);
    return sendJson(res, 201, { run });
  }

  const match = pathname.match(/^\/api\/run\/([^/]+)\/(items|selection|plan|approve|execute|reconcile)$/);
  if (!match) return sendJson(res, 404, { error: 'unknown API route' });
  const [, runId, action] = match;

  if (action === 'items') {
    return sendJson(res, 200, { run: store.correctRequest(runId, body.items) });
  }
  if (action === 'selection') {
    return sendJson(res, 200, { run: store.setSelections(runId, body.selections) });
  }
  if (action === 'plan') {
    return sendJson(res, 200, { plan: store.reviewPlan(runId), state: store.snapshot() });
  }
  if (action === 'approve') {
    const approval = store.approvePlan(runId);
    return sendJson(res, 200, { approval, state: store.snapshot() });
  }
  if (action === 'execute') {
    const result = store.startExecution(runId);
    return sendJson(res, 202, result);
  }
  if (action === 'reconcile') {
    return sendJson(res, 200, store.reconcile(runId));
  }
  return sendJson(res, 404, { error: 'unknown API route' });
}

function serveStatic(res, publicDir, pathname) {
  const safeName = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (safeName.includes('..')) return sendJson(res, 400, { error: 'invalid path' });
  const filePath = path.join(publicDir, safeName);
  if (!filePath.startsWith(publicDir)) return sendJson(res, 400, { error: 'invalid path' });
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, { error: 'not found' });
  }
  const type = CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  fs.createReadStream(filePath).pipe(res);
}

export function startServer(store, { port = 4180, host = '127.0.0.1', publicDir, session = null } = {}) {
  const { server, csrfToken } = createApp(store, {
    publicDir: publicDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
    session,
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address();
      resolve({ server, csrfToken, port: actual.port, url: `http://${host}:${actual.port}/` });
    });
  });
}
