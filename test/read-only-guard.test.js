import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadRequest, classifyReadResponse, applyReadOnlyRoute } from '../src/retailer/read-only-guard.js';
import { classifyRequest, classifyResponse, applyReadOnlyRoute as probeRoute } from '../scripts/landmark-probe.js';
import {
  classifyReadRequest as sessionClassifyRequest,
  classifyReadResponse as sessionClassifyResponse,
  applyReadOnlyRoute as sessionRoute,
} from '../src/retailer/session.js';

// The application session and the ticket 02 probe must not drift apart: they
// share one guard, covered here once.

test('the probe and the session use the same guard implementation', () => {
  assert.equal(classifyRequest, classifyReadRequest);
  assert.equal(classifyResponse, classifyReadResponse);
  assert.equal(sessionClassifyRequest, classifyReadRequest);
  assert.equal(sessionClassifyResponse, classifyReadResponse);
  assert.equal(probeRoute, applyReadOnlyRoute);
  assert.equal(sessionRoute, applyReadOnlyRoute);
});

test('shared guard allows same-origin reads and blocks writes, cross-origin data, and checkout', () => {
  assert.equal(classifyReadRequest({ method: 'GET', url: 'https://www.landmark.ph/api/cart' }).action, 'allow');
  assert.equal(classifyReadRequest({ method: 'POST', url: 'https://www.landmark.ph/api/cart/item' }).action, 'abort');
  assert.equal(
    classifyReadRequest({ method: 'GET', url: 'https://evil.example/track', resourceType: 'fetch' }).action,
    'abort',
  );
  assert.equal(
    classifyReadRequest({ method: 'GET', url: 'https://cdn.example/app.js', resourceType: 'script' }).action,
    'allow',
  );
  assert.equal(
    classifyReadRequest({ method: 'GET', url: 'https://www.landmark.ph/checkout', isNavigation: true }).action,
    'abort',
  );
});

test('checkout and logout paths are blocked even for non-navigation reads', () => {
  for (const method of ['GET', 'HEAD']) {
    for (const pathname of ['/logout', '/checkout', '/my-account/orders']) {
      assert.equal(
        classifyReadRequest({ method, url: `https://www.landmark.ph${pathname}`, isNavigation: false }).action,
        'abort',
      );
    }
  }
});

test('probe route refuses cross-origin asset redirects without following them', async () => {
  const calls = [];
  const blocked = [];
  const route = {
    request: () => ({
      method: () => 'GET',
      url: () => 'https://cdn.example/app.js',
      isNavigationRequest: () => false,
      resourceType: () => 'script',
    }),
    fetch: async (options) => {
      calls.push(options);
      return { status: () => 302, headers: () => ({ location: 'https://www.landmark.ph/logout' }) };
    },
    abort: async (reason) => calls.push(reason),
    continue: async () => assert.fail('must not bypass redirect guard'),
    fulfill: async () => assert.fail('must not fulfill a redirect'),
  };
  await probeRoute(route, { recordBlocked: (_req, reason, extra) => blocked.push({ reason, ...extra }) });
  assert.deepEqual(calls, [{ maxRedirects: 0 }, 'blockedbyclient']);
  assert.deepEqual(blocked, [{ reason: 'redirect-not-followed', destination: 'https://www.landmark.ph/logout' }]);
});

test('shared guard never follows a redirect', () => {
  const decision = classifyReadResponse({ status: 302, location: '/login', baseUrl: 'https://www.landmark.ph/cart' });
  assert.equal(decision.action, 'abort');
  assert.equal(decision.reason, 'redirect-not-followed');
  assert.equal(decision.destination, 'https://www.landmark.ph/login');
  assert.equal(classifyReadResponse({ status: 200 }).action, 'fulfill');
});
