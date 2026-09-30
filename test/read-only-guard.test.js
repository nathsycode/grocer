import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReadRequest, classifyReadResponse } from '../src/retailer/read-only-guard.js';
import { classifyRequest, classifyResponse } from '../scripts/landmark-probe.js';
import {
  classifyReadRequest as sessionClassifyRequest,
  classifyReadResponse as sessionClassifyResponse,
} from '../src/retailer/session.js';

// The application session and the ticket 02 probe must not drift apart: they
// share one guard, covered here once.

test('the probe and the session use the same guard implementation', () => {
  assert.equal(classifyRequest, classifyReadRequest);
  assert.equal(classifyResponse, classifyReadResponse);
  assert.equal(sessionClassifyRequest, classifyReadRequest);
  assert.equal(sessionClassifyResponse, classifyReadResponse);
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

test('shared guard never follows a redirect', () => {
  const decision = classifyReadResponse({ status: 302, location: '/login', baseUrl: 'https://www.landmark.ph/cart' });
  assert.equal(decision.action, 'abort');
  assert.equal(decision.reason, 'redirect-not-followed');
  assert.equal(decision.destination, 'https://www.landmark.ph/login');
  assert.equal(classifyReadResponse({ status: 200 }).action, 'fulfill');
});
