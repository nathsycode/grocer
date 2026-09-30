// Endpoint-aware normalization of retailer evidence.
//
// The 2026-09-29 read-only probe observed the same product rendered with
// different types and money scales depending on the route (search/detail vs
// cart). Guessing one uniform contract would silently misread prices or treat a
// search hit as proof of identity. This module normalizes each observed shape
// explicitly and preserves provenance so the review UI can show where a fact
// came from. It makes no network calls and treats all input as untrusted data.
//
// Known observations (see docs/integrations/landmark/read-only-probe-2026-09-29.md):
//   search: id string "27213", priceRange.minVariantPrice.{amount:number, currencyCode:"Php"}
//   detail: id number 27213,  priceRange.minVariantPrice.{amount:string, currencyCode:"Php"}
//   cart:   id number 39943,  prices.{price:"46900", currency_code:"PHP", currency_minor_unit:2}
// These are bounded observations, not a guaranteed API contract.

import { parseSize } from '../catalog.js';

// Minor-unit exponents for currencies we have reason to format. An unknown
// currency without an explicit minor unit is left unresolved rather than
// guessed, because assuming an exponent silently changes the price by 100x.
const CURRENCY_MINOR_UNITS = {
  PHP: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
};

/** Canonical product identifier, or null when the value is not an identifier. */
export function normalizeProductId(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function formatMinor(minor, currency, exponent) {
  if (!Number.isInteger(exponent) || exponent < 0) return null;
  return `${currency} ${(minor / 10 ** exponent).toFixed(exponent)}`;
}

/**
 * Normalize one monetary observation.
 *
 * The caller must state the endpoint scale. `scale: 'minor'` (cart) requires a
 * valid `minorUnit`; `scale: 'major'` (search/detail) scales by the currency's
 * known exponent. A bare amount with no scale and no exponent is ambiguous and
 * stays unresolved, because guessing silently changes the price by 100x. The
 * supplied exponent is also used for display, not a currency default.
 */
export function normalizeMoney({ amount, currency, minorUnit, scale } = {}) {
  const code = typeof currency === 'string' && currency.trim() ? currency.trim().toUpperCase() : null;
  const trimmed = typeof amount === 'string' ? amount.trim() : amount;
  const numeric = typeof trimmed === 'string' ? Number(trimmed) : trimmed;
  const base = {
    currency: code,
    observedCurrency: currency ?? null,
    observedAmount: amount ?? null,
    observedMinorUnit: minorUnit ?? null,
    observedScale: scale ?? null,
    format: null,
    minor: null,
    display: null,
    unresolved: true,
    reason: null,
  };

  if (trimmed === '' || trimmed === null || trimmed === undefined) {
    return { ...base, reason: 'amount is missing' };
  }
  if (!Number.isFinite(numeric)) {
    return { ...base, reason: 'amount is not a finite number' };
  }
  if (!code) {
    return { ...base, reason: 'currency is missing' };
  }

  const useMinor = scale === 'minor' || (scale === undefined && minorUnit !== undefined && minorUnit !== null);
  if (useMinor) {
    if (!Number.isInteger(minorUnit) || minorUnit < 0) {
      return { ...base, format: 'minor', reason: 'a minor-unit amount was supplied without a valid currency_minor_unit' };
    }
    const minor = Math.round(numeric);
    return { ...base, format: 'minor', minor, display: formatMinor(minor, code, minorUnit), unresolved: false };
  }

  if (scale === undefined) {
    return { ...base, reason: 'money scale is ambiguous; provide a minor unit or an endpoint scale' };
  }
  if (scale === 'major') {
    const exponent = CURRENCY_MINOR_UNITS[code];
    if (exponent === undefined) {
      return { ...base, format: 'major', reason: `no known minor unit for ${code}; provide currency_minor_unit` };
    }
    const minor = Math.round(numeric * 10 ** exponent);
    return { ...base, format: 'major', minor, display: formatMinor(minor, code, exponent), unresolved: false };
  }
  return { ...base, reason: `unknown money scale: ${scale}` };
}

function moneyFromObserved(raw, source) {
  if (source === 'cart') {
    const prices = raw?.prices ?? {};
    return normalizeMoney({
      amount: prices.price,
      currency: prices.currency_code,
      minorUnit: prices.currency_minor_unit,
      scale: 'minor',
    });
  }
  const min = raw?.priceRange?.minVariantPrice ?? null;
  if (!min) return normalizeMoney({ scale: 'major' });
  return normalizeMoney({ amount: min.amount, currency: min.currencyCode, scale: 'major' });
}

/**
 * Normalize one product observation from a known route shape. Never invents a
 * field: anything missing is recorded in `unresolved`.
 */
export function normalizeObservedProduct(raw, { source } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('normalizeObservedProduct requires an object');
  if (source !== 'search' && source !== 'detail' && source !== 'cart') {
    throw new Error(`unknown observation source: ${source}`);
  }

  const productId = normalizeProductId(raw.id);
  const title = typeof raw.title === 'string' ? raw.title : typeof raw.name === 'string' ? raw.name : null;
  const money = moneyFromObserved(raw, source);
  const size = title ? parseSize(title) : null;
  const unresolved = [];
  if (!productId) unresolved.push('product id missing or not an identifier');
  if (money.unresolved) unresolved.push(`price unresolved: ${money.reason}`);

  return {
    productId,
    lineKey: source === 'cart' && typeof raw.key === 'string' ? raw.key : null,
    sku: typeof raw.sku === 'string' ? raw.sku : null,
    type: typeof raw.type === 'string' ? raw.type : null,
    title,
    size,
    quantity: source === 'cart' && Number.isInteger(raw.quantity) ? raw.quantity : null,
    availableForSale: typeof raw.availableForSale === 'boolean' ? raw.availableForSale : null,
    isOpenWeight: typeof raw.isOpenWeight === 'boolean' ? raw.isOpenWeight : null,
    money,
    provenance: {
      source,
      idType: raw.id === null || raw.id === undefined ? 'missing' : typeof raw.id,
    },
    unresolved,
  };
}

/**
 * Combine repeated observations of the same product. Conflicting price or size
 * evidence is surfaced as a conflict, never resolved by picking a side; the
 * matching gate then treats it as non-selectable until retailer evidence
 * resolves it (ADR-0007).
 */
export function mergeObservedEvidence(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new Error('mergeObservedEvidence requires at least one observation');
  }
  const ids = new Set(observations.map((o) => o.productId));
  if (ids.size !== 1) throw new Error('observations do not describe the same product');

  const conflicts = [];
  const unresolved = new Set();
  for (const observation of observations) for (const note of observation.unresolved) unresolved.add(note);

  // Material identity must agree across observations; a same id is not proof
  // that two reads describe the same product (ADR-0007).
  const titles = new Set(observations.map((o) => o.title).filter(Boolean));
  if (titles.size > 1) conflicts.push(`conflicting title evidence: ${[...titles].join(' vs ')}`);
  const skus = new Set(observations.map((o) => o.sku).filter(Boolean));
  if (skus.size > 1) conflicts.push(`conflicting sku evidence: ${[...skus].join(' vs ')}`);
  const types = new Set(observations.map((o) => o.type).filter(Boolean));
  if (types.size > 1) conflicts.push(`conflicting type evidence: ${[...types].join(' vs ')}`);

  const priced = observations.filter((o) => !o.money.unresolved);
  let money = priced[0]?.money ?? observations[0].money;
  // Compare the complete monetary representation, not just the numeric amount:
  // PHP 46900 and USD 46900 are not the same price.
  const distinctMoney = new Set(priced.map((o) => `${o.money.currency ?? '?'}:${o.money.minor}`));
  if (distinctMoney.size > 1) {
    conflicts.push(`conflicting price evidence: ${[...distinctMoney].join(' vs ')}`);
    money = { ...money, unresolved: true, reason: 'conflicting price evidence' };
  }

  const sizes = new Set(observations.filter((o) => o.size).map((o) => `${o.size.dim}:${o.size.value}`));
  if (sizes.size > 1) conflicts.push(`conflicting size evidence: ${[...sizes].join(' vs ')}`);

  const primary = observations.find((o) => o.productId) ?? observations[0];
  return {
    productId: primary.productId,
    sku: primary.sku,
    type: primary.type,
    title: primary.title,
    size: sizes.size === 1 ? observations.find((o) => o.size).size : null,
    money,
    evidence: observations,
    conflicts,
    unresolved: [...unresolved],
  };
}
