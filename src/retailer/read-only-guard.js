// Shared read-only guard for every path that talks to the retailer.
//
// The application session (src/retailer/session.js) and the ticket 02
// investigation probe (scripts/landmark-probe.js) both need the same decision
// logic. Keeping it here means a security fix lands once and is covered by the
// shared tests in test/read-only-guard.test.js. This module makes no network
// calls and holds no state.

export const RETAILER_ORIGIN = 'https://www.landmark.ph';

// Cross-origin resource types needed for the page to render. Everything else
// cross-origin is blocked so a request is not sent to a third party.
const RENDER_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);

const BLOCKED_NAV = /^\/(checkout|logout|my-account\/orders)/i;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * Read-only request gate. `allow` is the only action that reaches the retailer;
 * every other decision is recorded by the caller rather than silently dropped.
 */
export function classifyReadRequest({
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
  if (BLOCKED_NAV.test(parsed.pathname)) {
    return { action: 'abort', reason: 'blocked-navigation' };
  }
  return { action: 'allow' };
}

/**
 * Decide what to do with a fetched response. Redirects are never followed:
 * Playwright does not re-route a redirect target, so following one would
 * contact a URL the request gate never classified.
 */
export function classifyReadResponse({ status, location = null, baseUrl }) {
  if (!REDIRECT_STATUS.has(status)) return { action: 'fulfill' };
  let destination = null;
  try {
    destination = location ? new URL(location, baseUrl).href : null;
  } catch {
    destination = null;
  }
  return { action: 'abort', reason: 'redirect-not-followed', destination };
}

/**
 * Apply the guard to one routed request. Redirects are refused for **every**
 * allowed request, including cross-origin rendering assets: Playwright routes
 * only the initial request of a redirect chain, so letting a cross-origin asset
 * `continue()` would contact a destination the gate never classified.
 */
export async function applyReadOnlyRoute(route, { retailerOrigin = RETAILER_ORIGIN, recordBlocked } = {}) {
  const request = route.request();
  const decision = classifyReadRequest({
    method: request.method(),
    url: request.url(),
    retailerOrigin,
    isNavigation: request.isNavigationRequest(),
    resourceType: request.resourceType(),
  });
  if (decision.action === 'abort') {
    recordBlocked?.(request, decision.reason);
    return route.abort('blockedbyclient');
  }
  let response;
  try {
    response = await route.fetch({ maxRedirects: 0 });
  } catch (err) {
    recordBlocked?.(request, `read-failed:${err.message}`);
    return route.abort('blockedbyclient');
  }
  const disposition = classifyReadResponse({
    status: response.status(),
    location: response.headers()['location'],
    baseUrl: request.url(),
  });
  if (disposition.action === 'abort') {
    recordBlocked?.(request, disposition.reason, { destination: disposition.destination });
    return route.abort('blockedbyclient');
  }
  return route.fulfill({ response });
}
