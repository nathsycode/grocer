// Deterministic domain logic: interpretation, matching gates, plan and
// verification. No model calls and no retailer access live here.

import {
  CATALOG,
  productById,
  productView,
  parseSize,
  sizeEquals,
  formatMoney,
} from './catalog.js';

export function norm(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function sameText(a, b) {
  return norm(a) === norm(b);
}

const NO_SUB_RE = /no\s+sub(?:stitution)?s?\b|\bonly\b/i;

/**
 * Interpret a free-text request into structured items. The interpreter is
 * deterministic and matches against the synthetic catalogue; it is a rehearsal
 * stand-in for the proposal-only model, not an LLM.
 */
export function interpretRequest(text, catalog = CATALOG) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => interpretLine(line, index, catalog));
}

export function interpretLine(line, index, catalog = CATALOG) {
  const quantity = extractQuantity(line);
  const withoutQty = line.replace(QUANTITY_RE, '').trim();
  const size = parseSize(withoutQty);
  const rawNorm = ` ${norm(line)} `;

  const nameMatches = catalog.filter((prod) => {
    if (norm(prod.name) === norm(withoutQty)) return true;
    return prod.name.split(/\s+/).every((token) => rawNorm.includes(` ${norm(token)} `));
  });

  const brandInLine = (prod) => rawNorm.includes(` ${norm(prod.brand)} `);

  const ranked = [...nameMatches].sort((a, b) => score(b) - score(a));
  function score(prod) {
    return (brandInLine(prod) ? 2 : 0) + (size && sizeEquals(size, prod.size) ? 2 : 0);
  }

  const chosen = ranked[0] ?? null;
  const variant = chosen?.variant && rawNorm.includes(` ${norm(chosen.variant)} `) ? chosen.variant : null;

  return {
    id: `item-${index + 1}`,
    raw: line,
    name: chosen ? chosen.name : sentenceName(withoutQty),
    brand: chosen && brandInLine(chosen) ? chosen.brand : null,
    variant,
    size: size ?? null,
    quantity,
    restrictions: { noSubstitution: NO_SUB_RE.test(line) },
  };
}

const QUANTITY_RE = /(?:^|\s)x\s*(\d+)\s*$|(?:^|\s)(\d+)\s*x\s*$/i;

function extractQuantity(line) {
  const m = String(line).match(QUANTITY_RE);
  if (!m) return 1;
  return Number.parseInt(m[1] ?? m[2], 10);
}

/** The explicitly written quantity, or null when the line states none. */
export function explicitQuantity(line) {
  const m = String(line).match(QUANTITY_RE);
  return m ? Number.parseInt(m[1] ?? m[2], 10) : null;
}

function sentenceName(text) {
  const cleaned = text.replace(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/gi, '').trim();
  return cleaned || text;
}

/** Discover candidates and classify each against the requested item. */
export function discoverCandidates(item, catalog = CATALOG, rankings = {}) {
  const itemName = norm(item.name);
  const raw = ` ${norm(item.raw || item.name)} `;
  return catalog
    .filter((prod) => {
      if (itemName && norm(prod.name) === itemName) return true;
      return prod.name.split(/\s+/).every((token) => raw.includes(` ${norm(token)} `));
    })
    .map((prod) => classify(item, prod, rankings[prod.id] ?? null));
}

/**
 * Classification gate. Colour is not mutation authority and candidate
 * uniqueness never upgrades an unspecified preference to green. A model
 * ranking is attached for review but is never consulted by the gate, so a
 * confident proposal cannot make conflicting or missing evidence selectable
 * (ADR-0007).
 */
export function classify(item, prod, modelRanking = null) {
  const modelRank = Number.isInteger(modelRanking?.rank) ? modelRanking.rank : null;
  const modelRationale = typeof modelRanking?.rationale === 'string' ? modelRanking.rationale : null;
  const ranked = (result) => ({ ...result, modelRank, modelRationale });
  if (prod.evidenceConflict) {
    return ranked({
      product: productView(prod),
      color: 'red',
      selectable: false,
      reason: prod.evidenceNote ?? 'Conflicting product evidence; non-selectable.',
    });
  }
  const brandSpecified = Boolean(item.brand);
  const sizeSpecified = Boolean(item.size);
  const variantSpecified = Boolean(item.variant);
  const brandOk = !brandSpecified || sameText(item.brand, prod.brand);
  const sizeOk = !sizeSpecified || sizeEquals(item.size, prod.size);
  const variantOk = !variantSpecified || sameText(item.variant, prod.variant);

  // ADR-0007: an explicit no-substitution prohibition blocks any specified
  // attribute that differs (brand, variant, or size), not just the brand.
  if (item.restrictions?.noSubstitution) {
    const differences = [];
    if (brandSpecified && !brandOk) differences.push(`brand (${prod.brand})`);
    if (variantSpecified && !variantOk) differences.push(`variant (${prod.variant})`);
    if (sizeSpecified && !sizeOk) differences.push(`size (${prod.size.display})`);
    if (differences.length) {
      return ranked({
        product: productView(prod),
        color: 'red',
        selectable: false,
        reason: `Explicit no-substitution: ${differences.join(', ')} differs from the request; revise the request to select it.`,
      });
    }
  }

  if (!brandOk) {
    return ranked({
      product: productView(prod),
      color: 'orange',
      selectable: true,
      reason: `Substitution: different brand (${prod.brand}).`,
    });
  }
  if (!variantOk) {
    return ranked({
      product: productView(prod),
      color: 'orange',
      selectable: true,
      reason: `Substitution: different variant (${prod.variant}).`,
    });
  }
  if (sizeSpecified && !sizeOk) {
    return ranked({
      product: productView(prod),
      color: 'orange',
      selectable: true,
      reason: `Substitution: different size (${prod.size.display}).`,
    });
  }
  if (!brandSpecified || !sizeSpecified) {
    const missing = [!brandSpecified ? 'brand' : null, !sizeSpecified ? 'size' : null].filter(Boolean).join(' and ');
    return ranked({
      product: productView(prod),
      color: 'yellow',
      selectable: true,
      reason: `Unspecified ${missing}; choosing ${prod.brand} ${prod.size.display} is a preference choice.`,
    });
  }
  return ranked({
    product: productView(prod),
    color: 'green',
    selectable: true,
    reason: 'Exact brand, variant, and size match.',
  });
}

/**
 * ADR-0001: the requested quantity is a target total for the exact selected
 * product. Returns one action per selected item.
 */
export function computeAction(item, selection, cart, catalog = CATALOG) {
  const prod = productById(selection.productId, catalog);
  if (!prod) {
    return { itemId: item.id, kind: 'unresolved', reason: 'Selected product is not in the catalogue.' };
  }
  const existing = cart[prod.id] ?? 0;
  const target = item.quantity;
  const base = {
    itemId: item.id,
    raw: item.raw,
    productId: prod.id,
    product: productView(prod),
    target,
    existing,
    from: existing,
    to: target,
    priceMinor: prod.priceMinor,
    priceDisplay: formatMoney(prod.priceMinor, prod.currency),
    executable: true,
    assumptions: item.assumptions ?? [],
    unresolved: item.unresolved ?? [],
  };
  if (target === existing) return { ...base, kind: 'none', units: 0 };
  if (target > existing) return { ...base, kind: 'add', units: target - existing };
  return {
    ...base,
    kind: 'reduce',
    units: existing - target,
    // ADR-0001: a reduction needs its own explicit approval.
    executable: Boolean(selection.approveReduction),
    requiresReductionApproval: true,
  };
}

export function computePlan(items, selections, cart, contextId, revision, catalog = CATALOG) {
  const actions = [];
  const unfulfilled = [];
  for (const item of items) {
    const selection = selections[item.id];
    const review = { assumptions: item.assumptions ?? [], unresolved: item.unresolved ?? [] };
    if (!selection?.productId) {
      unfulfilled.push({ itemId: item.id, raw: item.raw, reason: 'No choice selected.', ...review });
      continue;
    }
    const action = computeAction(item, selection, cart, catalog);
    if (action.kind === 'unresolved') {
      unfulfilled.push({ itemId: item.id, raw: item.raw, reason: action.reason, ...review });
      continue;
    }
    actions.push(action);
  }
  return {
    revision,
    contextId,
    actions,
    unfulfilled,
    generatedAt: new Date().toISOString(),
  };
}

/** Executable actions only: 'add' and an approved 'reduce'. */
export function executableActions(plan) {
  return plan.actions.filter((a) => a.executable && (a.kind === 'add' || a.kind === 'reduce'));
}

/**
 * Compare a stored approval against current revision, context, cart, and
 * price. Any mismatch requires reevaluation rather than silent reuse
 * (ADR-0002, ADR-0003).
 */
export function revalidateApproval(approval, { revision, contextId, cart, catalog = CATALOG }) {
  const problems = [];
  const notes = [];
  if (approval.revision !== revision) problems.push('request or selection changed since approval');
  if (approval.contextId !== contextId) problems.push('shopping context changed since approval');
  for (const a of approval.actions) {
    const current = cart[a.productId] ?? 0;
    if (current !== a.from) {
      problems.push(`${a.product.name}: cart showed ${a.from} at approval, now ${current}`);
    }
    const prod = productById(a.productId, catalog);
    if (prod && prod.priceMinor > a.priceMinor) {
      problems.push(`${a.product.name}: unit price rose from ${a.priceDisplay} to ${formatMoney(prod.priceMinor, prod.currency)}`);
    } else if (prod && prod.priceMinor < a.priceMinor) {
      notes.push(`${a.product.name}: unit price fell to ${formatMoney(prod.priceMinor, prod.currency)}; approved action may proceed.`);
    }
  }
  return { ok: problems.length === 0, problems, notes };
}

export function verifyCart(plan, cart, catalog = CATALOG) {
  const plannedIds = new Set(plan.actions.map((a) => a.productId));
  const fulfilled = [];
  const discrepancies = [];
  for (const action of plan.actions) {
    const observed = cart[action.productId] ?? 0;
    if (action.kind === 'none') {
      // No mutation was planned, but the observed cart is still evidence.
      if (observed === action.target) {
        fulfilled.push({ itemId: action.itemId, productId: action.productId, target: action.target, observed });
      } else {
        discrepancies.push({
          itemId: action.itemId,
          productId: action.productId,
          expected: action.target,
          observed,
          note: 'No mutation was planned, but the observed quantity does not match the target.',
        });
      }
      continue;
    }
    if (action.kind === 'reduce' && !action.executable) {
      discrepancies.push({
        itemId: action.itemId,
        productId: action.productId,
        expected: action.to,
        observed,
        note: `Reduction not approved; existing excess of ${observed - action.to} retained.`,
      });
      continue;
    }
    if (observed === action.to) {
      fulfilled.push({ itemId: action.itemId, productId: action.productId, target: action.target, observed });
    } else {
      discrepancies.push({
        itemId: action.itemId,
        productId: action.productId,
        expected: action.to,
        observed,
        note: 'Observed quantity does not match the approved target.',
      });
    }
  }
  const extras = Object.entries(cart)
    .filter(([id, qty]) => qty > 0 && !plannedIds.has(id))
    .map(([id, qty]) => {
      const prod = productById(id, catalog);
      return { productId: id, quantity: qty, label: prod ? `${prod.brand} ${prod.name} ${prod.size.display}` : id };
    });
  return {
    fulfilled,
    discrepancies,
    extras,
    unfulfilled: plan.unfulfilled,
    observedAt: new Date().toISOString(),
  };
}
