// Pure derivations from backend state to what the review UI shows. No DOM, no
// network: everything here is deterministic so it can be tested in Node. The
// backend stays the authority; these functions only describe and cross-check it.

export const TONE = {
  green: { label: 'Green · high confidence', short: 'Ready' },
  yellow: { label: 'Yellow · preference needed', short: 'Choose' },
  orange: { label: 'Orange · substitution', short: 'Substitute' },
  red: { label: 'Red · no safe match', short: 'Unresolved' },
};

const ORDER = { yellow: 0, orange: 1, red: 2, green: 3 };

export function formatMinor(minor, currency = 'PHP') {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

/** Item class from its candidates: the best selectable colour, else red. */
export function itemClass(candidates) {
  const live = candidates.filter((c) => c.selectable);
  for (const color of ['green', 'yellow', 'orange']) {
    if (live.some((c) => c.color === color)) return color;
  }
  return 'red';
}

function cartQuantity(cart, productId) {
  return cart.find((line) => line.productId === productId)?.quantity ?? 0;
}

/** One view per requested item, in request order. */
export function buildItems(run, cart) {
  return run.items.map((item, index) => {
    const candidates = run.candidates[item.id] ?? [];
    const selection = run.selections[item.id] ?? null;
    const picked = selection ? candidates.find((c) => c.product.id === selection.productId) ?? null : null;
    const target = Number(item.quantity) || 0;
    const existing = picked ? cartQuantity(cart, picked.product.id) : 0;
    return {
      item,
      index,
      candidates,
      cls: itemClass(candidates),
      picked,
      approveReduction: Boolean(selection?.approveReduction),
      target,
      existing,
      needsReduction: Boolean(picked) && existing > target,
    };
  });
}

/** Review order: things that need the user first, exact matches last. */
export function sortItems(views) {
  return [...views].sort((a, b) => ORDER[a.cls] - ORDER[b.cls] || a.index - b.index);
}

export function pickLabel(view) {
  if (view.picked) {
    const p = view.picked.product;
    return `${p.brand} ${p.name} ${p.sizeDisplay} ×${view.target}`;
  }
  if (view.cls === 'red') return 'No safe match';
  if (view.cls === 'green') return 'Excluded by you';
  return 'Not chosen yet';
}

/**
 * Client-side mirror of the backend's plan arithmetic (ADR-0001), used only to
 * show estimates and to cross-check the plan the backend actually produces.
 * Quantity is a target total for the exact product, not a number to add.
 */
export function previewPlan(views) {
  const actions = [];
  const awaiting = [];
  const unresolved = [];
  const excluded = [];
  for (const v of views) {
    if (!v.picked) {
      if (v.cls === 'red') unresolved.push(v);
      else if (v.cls === 'green') excluded.push(v);
      else awaiting.push(v);
      continue;
    }
    const product = v.picked.product;
    const kind = v.target === v.existing ? 'none' : v.target > v.existing ? 'add' : 'reduce';
    const units = Math.abs(v.target - v.existing);
    actions.push({
      itemId: v.item.id,
      productId: product.id,
      kind,
      units: kind === 'none' ? 0 : units,
      priceMinor: product.priceMinor,
      executable: kind === 'reduce' ? v.approveReduction : true,
      costMinor: kind === 'add' ? units * product.priceMinor : 0,
    });
  }
  return {
    actions,
    awaiting,
    unresolved,
    excluded,
    totalMinor: actions.reduce((sum, a) => sum + a.costMinor, 0),
  };
}

const fingerprint = (a) => `${a.itemId}|${a.productId}|${a.kind}|${a.units}|${a.priceMinor}|${a.executable}`;

/**
 * Does the plan the backend reviewed match what the user was looking at? Any
 * difference means the screen is stale, so approval must not proceed.
 */
export function samePlan(preview, plan) {
  if (!plan) return false;
  const a = preview.actions.map(fingerprint).sort();
  const b = plan.actions.map(fingerprint).sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Actions the backend would execute (adds and approved reductions). */
export function executableOf(plan) {
  return (plan?.actions ?? []).filter((a) => a.executable && (a.kind === 'add' || a.kind === 'reduce'));
}

/**
 * Approved lines whose catalogue price has risen since the plan was reviewed.
 * ADR-0003: a price increase is outside the approval and needs renewed consent.
 */
export function priceIncreases(plan, catalog) {
  const increases = [];
  for (const action of executableOf(plan)) {
    const now = catalog.find((p) => p.id === action.productId);
    if (!now) continue;
    const nowMinor = Number(now.priceMinor);
    if (Number.isFinite(nowMinor) && nowMinor > action.priceMinor) {
      increases.push({
        itemId: action.itemId,
        productId: action.productId,
        name: `${action.product.brand} ${action.product.name} ${action.product.sizeDisplay}`,
        units: action.units,
        approvedMinor: action.priceMinor,
        nowMinor,
      });
    }
  }
  return increases;
}

/**
 * Guard for a revised plan after a pause. The user consented to the previous
 * prices plus any increase shown to them; the revised plan may not add a
 * product, nor cost more than that, or the consent does not cover it.
 */
export function checkRevisedPlan(revised, previous, acknowledgedMinor = {}) {
  const known = new Map(previous.actions.map((a) => [a.productId, a.priceMinor]));
  const problems = [];
  for (const action of executableOf(revised)) {
    if (!known.has(action.productId)) {
      problems.push(`${action.product.name} was not part of the plan you approved`);
      continue;
    }
    const limit = Math.max(known.get(action.productId), acknowledgedMinor[action.productId] ?? 0);
    if (action.priceMinor > limit) {
      problems.push(`${action.product.name} now costs more than the price shown to you`);
    }
  }
  return problems;
}

/** Progress rows for the "Add to cart" step. */
export function runRows(run, attempts, catalog) {
  const plan = run.plan;
  const actions = executableOf(plan);
  const mine = attempts.filter((a) => a.runId === run.runId);
  const increased = new Set(priceIncreases(plan, catalog).map((i) => i.productId));
  const fulfilled = new Set((run.verification?.fulfilled ?? []).map((f) => f.productId));
  const verified = run.status === 'completed' || run.status === 'handed-off';
  const live = run.status === 'executing';
  let working = false;
  return actions.map((action) => {
    const label = `${action.product.brand} ${action.product.name} ${action.product.sizeDisplay} ×${action.target}`;
    const attempt = mine.find((a) => a.itemId === action.itemId && a.productId === action.productId);
    const outcome = attempt?.outcome?.status ?? null;
    let state;
    let kind;
    if (verified && fulfilled.has(action.productId)) {
      state = 'verified in cart';
      kind = 'done';
    } else if (verified) {
      state = 'not verified · see discrepancies';
      kind = 'pause';
    } else if (outcome === 'applied') {
      state = 'added · awaiting verification';
      kind = 'done';
    } else if (outcome === 'failed' || outcome === 'unknown') {
      state = `outcome ${outcome} · paused`;
      kind = 'pause';
    } else if (run.status === 'paused' && increased.has(action.productId)) {
      state = 'paused · needs reapproval';
      kind = 'pause';
    } else if (live && !working) {
      working = true;
      state = 'adding…';
      kind = 'work';
    } else {
      state = 'waiting';
      kind = 'wait';
    }
    return { itemId: action.itemId, productId: action.productId, label, state, kind };
  });
}

/** Everything the handoff screen shows, taken from the verification result. */
export function handoffView(run, views) {
  const v = run.verification;
  if (!v) return null;
  const plan = run.plan;
  const byProduct = (list, id) => list.find((x) => x.productId === id);
  const viewOf = (itemId) => views.find((x) => x.item.id === itemId);
  const rows = [];
  let exact = 0;
  let choices = 0;
  let substitutes = 0;
  let verified = 0;
  let notChosen = 0;
  let trouble = 0;
  let addedMinor = 0;

  for (const a of plan.actions) {
    const view = viewOf(a.itemId);
    const color = view?.picked?.color ?? 'green';
    const pick = `${a.product.brand} ${a.product.name} ${a.product.sizeDisplay}`;
    const ok = byProduct(v.fulfilled, a.productId);
    const bad = byProduct(v.discrepancies, a.productId);
    const row = { raw: a.raw, pick, target: a.target, inCart: ok?.observed ?? bad?.observed ?? 0, added: '—' };
    if (bad) {
      trouble += 1;
      Object.assign(row, { tone: 'red', result: 'Discrepancy', note: bad.note });
    } else if (ok) {
      verified += 1;
      if (a.kind === 'none') {
        Object.assign(row, { tone: 'green', result: 'Met by existing cart' });
      } else {
        const cost = a.kind === 'add' ? a.units * a.priceMinor : 0;
        addedMinor += cost;
        row.added = a.kind === 'add' ? formatMinor(cost) : `−${a.units}`;
        Object.assign(row, { tone: color === 'orange' ? 'orange' : 'green', result: color === 'orange' ? 'Verified · substitute' : 'Verified' });
      }
      if (color === 'green') exact += 1;
      else {
        choices += 1;
        if (color === 'orange') substitutes += 1;
      }
    }
    rows.push(row);
  }
  for (const u of v.unfulfilled ?? plan.unfulfilled) {
    const view = viewOf(u.itemId);
    const red = view?.cls === 'red';
    if (red) trouble += 1;
    else notChosen += 1;
    rows.push({
      raw: u.raw,
      pick: '—',
      target: view?.target ?? 0,
      inCart: 0,
      added: '—',
      tone: red ? 'red' : 'yellow',
      result: red ? 'Unresolved · not added' : 'Not chosen · not added',
      note: u.reason,
    });
  }
  const total = views.length;
  return {
    rows,
    verified,
    total,
    addedMinor,
    clean: trouble === 0 && notChosen === 0 && verified === total,
    discrepancies: v.discrepancies.length,
    extras: v.extras ?? [],
    priceDecreases: v.priceDecreases ?? [],
    stats: { exact, choices, substitutes, notChosen, trouble },
  };
}

/** Items payload for the correction endpoint, with one field changed. */
export function correctedItems(run, itemId, field, value) {
  return run.items.map((item) => ({
    id: item.id,
    raw: item.raw,
    name: item.name,
    brand: item.brand ?? '',
    variant: item.variant ?? '',
    sizeText: item.size ? item.size.display : '',
    quantity: item.quantity,
    noSubstitution: Boolean(item.restrictions?.noSubstitution),
    ...(item.id === itemId ? { [field]: value } : {}),
  }));
}

/**
 * After a correction the backend resets every selection to its default. Keep
 * the user's other explicit choices where the same product is still a valid,
 * selectable candidate; the corrected item itself takes the fresh default.
 */
export function preservedSelections(before, after, editedItemId) {
  const kept = { ...after.selections };
  for (const [itemId, selection] of Object.entries(before.selections)) {
    if (itemId === editedItemId) continue;
    const candidates = after.candidates[itemId] ?? [];
    if (candidates.some((c) => c.selectable && c.product.id === selection.productId)) {
      kept[itemId] = selection;
    } else {
      delete kept[itemId];
    }
  }
  return kept;
}
