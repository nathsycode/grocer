// Local review UI. Renders backend state; performs no cart logic itself and
// never talks to a retailer. State-changing calls carry the session CSRF token.

const root = document.getElementById('root');
const banner = document.getElementById('banner');

const SAMPLE_REQUEST = `Highlands Corned Beef 150g x2
Pasta Roma Fusilli 500g x2`;

let csrf = null;
let snapshot = null;
let draft = null;
let notice = null;
let pollTimer = null;
let requestDraft = null;

const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rehearsal-csrf': csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function load() {
  try {
    const res = await fetch('/api/state');
    snapshot = await res.json();
    csrf = snapshot.csrfToken;
  } catch (err) {
    notice = `Could not reach the local backend: ${err.message}`;
  }
  if (!snapshot?.run || (draft && draft.runId !== snapshot.run.runId)) draft = null;
  render();
  managePoll();
}

async function act(fn) {
  try {
    await fn();
    notice = null;
  } catch (err) {
    notice = err.message;
  }
  await load();
}

function managePoll() {
  const shouldPoll = Boolean(snapshot?.ownership?.executing);
  if (shouldPoll && !pollTimer) pollTimer = setInterval(load, 400);
  if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function ensureDraft(run) {
  if (draft && draft.runId === run.runId) return;
  draft = {
    runId: run.runId,
    items: run.items.map((item) => ({
      id: item.id,
      raw: item.raw,
      name: item.name,
      brand: item.brand ?? '',
      variant: item.variant ?? '',
      sizeText: item.size ? item.size.display : '',
      quantity: item.quantity,
      noSubstitution: Boolean(item.restrictions?.noSubstitution),
    })),
  };
}

function render() {
  if (!snapshot) {
    root.innerHTML = '<p>Loading local state…</p>';
    return;
  }
  renderBanner();
  const run = snapshot.run;
  const parts = [cartSection()];
  parts.push(requestSection(run));
  if (run) {
    ensureDraft(run);
    parts.push(interpretationSection(run), planSection(run), verificationSection(run));
  }
  parts.push(journalSection());
  root.innerHTML = parts.join('');
}

function renderBanner() {
  const blocked = snapshot.blocked
    ? `<p class="blocked"><strong>Execution blocked.</strong> ${esc(snapshot.blocked.reason)}</p>`
    : '';
  const err = notice ? `<p class="blocked">${esc(notice)}</p>` : '';
  banner.innerHTML = `
    <p class="sim-label">${esc(snapshot.simulation.label)}</p>
    ${blocked}${err}`;
}

function cartSection() {
  const { cart, simulation } = snapshot;
  return `
  <section aria-labelledby="cart-h">
    <h2 id="cart-h">Simulated cart</h2>
    <p class="muted">Current simulated contents. This is not a real Landmark cart.</p>
    ${
      cart.length
        ? `<ul class="plain">${cart.map((line) => `<li>${esc(line.label)} &times; ${line.quantity}</li>`).join('')}</ul>`
        : '<p class="muted">The simulated cart is empty.</p>'
    }
    <p class="muted">Context: ${esc(simulation.context.account)} &middot; ${esc(simulation.context.branch)}</p>
  </section>`;
}

function requestText(run) {
  if (requestDraft !== null) return requestDraft;
  return run ? run.requestText : SAMPLE_REQUEST;
}

function requestSection(run) {
  return `
  <section aria-labelledby="request-h">
    <h2 id="request-h">Grocery request</h2>
    <label for="request-text">Fully specified request (one item per line, e.g. “Highlands Corned Beef 150g x2”)</label>
    <textarea id="request-text">${esc(requestText(run))}</textarea>
    <button data-action="interpret">Interpret request</button>
  </section>`;
}

function interpretationSection(run) {
  return `
  <section aria-labelledby="review-h">
    <h2 id="review-h">Review interpreted request <span class="muted">(revision ${run.revision})</span></h2>
    <p class="muted">Original text stays visible beside its interpretation. Correct anything that is wrong; a change requires a fresh approval.</p>
    ${draft.items.map((item, index) => itemBlock(run, item, index)).join('')}
    <button class="secondary" data-action="save-corrections">Save corrections</button>
  </section>`;
}

function itemBlock(run, item, index) {
  const original = run.items[index];
  const candidates = run.candidates[item.id] ?? [];
  const selected = run.selections[item.id]?.productId;
  const reduceApproved = run.selections[item.id]?.approveReduction;
  const existing = selected ? snapshot.cart.find((line) => line.productId === selected)?.quantity ?? 0 : 0;
  const target = Number(item.quantity) || 0;
  const rows = candidates.length
    ? candidates.map((candidate) => candidateRow(item, candidate, selected)).join('')
    : '<p class="muted">No candidate discovered; this request stays unresolved.</p>';

  return `
  <fieldset>
    <legend>Requested: <span class="raw-text">${esc(original?.raw ?? item.raw)}</span></legend>
    <div class="item-grid">
      <label>Name <input type="text" data-item="${index}" data-field="name" value="${esc(item.name)}" /></label>
      <label>Brand <input type="text" data-item="${index}" data-field="brand" value="${esc(item.brand)}" /></label>
      <label>Variant <input type="text" data-item="${index}" data-field="variant" value="${esc(item.variant)}" /></label>
      <label>Size <input type="text" data-item="${index}" data-field="sizeText" value="${esc(item.sizeText)}" placeholder="e.g. 500 g" /></label>
      <label>Target quantity <input type="number" min="1" step="1" data-item="${index}" data-field="quantity" value="${esc(item.quantity)}" /></label>
    </div>
    <label class="check">
      <input type="checkbox" data-item="${index}" data-field="noSubstitution" ${item.noSubstitution ? 'checked' : ''} />
      No substitutions for this item (explicit restriction)
    </label>
    <fieldset class="candidates">
      <legend>Concrete candidates</legend>
      ${rows}
    </fieldset>
    <button class="secondary" data-action="clear-selection" data-item="${esc(item.id)}">Clear selection</button>
    ${
      selected && existing > target
        ? `<p class="notice"><label><input type="checkbox" data-reduce data-item="${esc(item.id)}" ${reduceApproved ? 'checked' : ''} /> Approve reduction from ${existing} to ${target} for this item (otherwise the excess is retained and reported)</label></p>`
        : ''
    }
  </fieldset>`;
}

function candidateRow(item, candidate, selected) {
  const p = candidate.product;
  return `
  <label class="candidate ${candidate.selectable ? '' : 'disabled'}">
    <input type="radio" name="choice-${esc(item.id)}" value="${esc(p.id)}" ${selected === p.id ? 'checked' : ''} ${candidate.selectable ? '' : 'disabled'} />
    <span class="badge badge-${candidate.color}">${esc(candidate.color)}</span>
    <span><strong>${esc(p.brand)} ${esc(p.name)}</strong> ${esc(p.sizeDisplay)}</span>
    <span>${esc(p.priceDisplay)}</span>
    <span class="cand-reason">${esc(candidate.reason)}</span>
  </label>`;
}

function planSection(run) {
  const plan = run.plan;
  const actions = plan?.actions ?? [];
  const approval = run.approval;
  return `
  <section aria-labelledby="plan-h">
    <h2 id="plan-h">Plan</h2>
    <p class="muted">Requested quantities are target totals for the exact selected product. Verified matching units count toward the target; different configurations and unrelated contents are preserved.</p>
    ${
      actions.length
        ? `<table>
            <thead><tr><th scope="col">Item</th><th scope="col">Product</th><th scope="col">In cart</th><th scope="col">Target</th><th scope="col">Intended change</th><th scope="col">Unit price</th><th scope="col">Executable</th></tr></thead>
            <tbody>${actions.map(actionRow).join('')}</tbody>
          </table>`
        : '<p class="muted">Review the plan to see the intended changes.</p>'
    }
    ${
      plan?.unfulfilled?.length
        ? `<h3>Unfulfilled requests</h3><ul>${plan.unfulfilled.map((u) => `<li>${esc(u.raw)} — ${esc(u.reason)}</li>`).join('')}</ul>`
        : ''
    }
    <div>
      <button class="secondary" data-action="review-plan">Review plan</button>
      <button data-action="approve" ${canApprove(run) ? '' : 'disabled'}>Approve this plan</button>
      <button data-action="execute" ${canExecute(run) ? '' : 'disabled'}>Execute approved plan</button>
    </div>
    ${
      approval
        ? `<p class="approved">Approved ${approval.actions.length} change(s) — approval ${esc(approval.approvalId.slice(0, 8))} at ${esc(approval.approvedAt)}. Even green matches required this explicit approval.</p>`
        : ''
    }
    ${run.pauseReason ? `<p class="paused">Paused: ${esc(run.pauseReason)}</p>` : ''}
    ${snapshot.blocked && snapshot.blocked.kind !== 'fatal' ? '<button data-action="reconcile">Reconcile (read-only)</button>' : ''}
  </section>`;
}

function actionRow(action) {
  const change =
    action.kind === 'add'
      ? `Add ${action.units}`
      : action.kind === 'reduce'
        ? `Reduce ${action.units}`
        : 'No change needed';
  const executable =
    action.kind === 'none' ? '—' : action.executable ? 'Yes' : 'No — needs explicit reduction approval';
  return `<tr>
    <td>${esc(action.raw)}</td>
    <td>${esc(action.product.brand)} ${esc(action.product.name)} ${esc(action.product.sizeDisplay)}</td>
    <td>${action.existing}</td>
    <td>${action.target}</td>
    <td>${change}</td>
    <td>${esc(action.priceDisplay)}</td>
    <td>${executable}</td>
  </tr>`;
}

function canApprove(run) {
  return Boolean(
    run.plan &&
      run.plan.revision === run.revision &&
      !run.approvalConsumed &&
      !run.approvalValid &&
      !run.inFlight &&
      !snapshot.blocked &&
      !snapshot.ownership.executing &&
      run.status !== 'completed',
  );
}

function canExecute(run) {
  return Boolean(
    run.approval &&
      run.approvalValid &&
      !run.approvalConsumed &&
      !run.inFlight &&
      !snapshot.blocked &&
      !snapshot.ownership.executing,
  );
}

function verificationSection(run) {
  if (!run.verification) return '';
  const v = run.verification;
  const list = (title, items, render) =>
    items.length ? `<h3>${title}</h3><ul class="plain">${items.map(render).join('')}</ul>` : '';
  return `
  <section aria-labelledby="verify-h">
    <h2 id="verify-h">Simulated cart verification</h2>
    <p class="muted">Verification compares the simulated cart with the approved plan. It does not claim a real cart was prepared.</p>
    ${list('Fulfilled', v.fulfilled, (f) => `<li>${esc(f.productId)} at target ${f.target} (observed ${f.observed})</li>`)}
    ${list('Discrepancies', v.discrepancies, (d) => `<li>${esc(d.productId)}: expected ${d.expected}, observed ${d.observed}. ${esc(d.note)}</li>`)}
    ${list('Preserved extras (unrelated or different configuration)', v.extras, (e) => `<li>${esc(e.productId)} &times; ${e.quantity} — ${esc(e.label)}</li>`)}
    ${list('Unfulfilled requests', v.unfulfilled, (u) => `<li>${esc(u.raw)} — ${esc(u.reason)}</li>`)}
  </section>`;
}

function journalSection() {
  const records = snapshot.journalTail ?? [];
  return `
  <details>
    <summary>Safety journal — ${records.length} recent records</summary>
    <ul class="plain journal-list">
      ${records
        .map(
          (r) => `<li>${esc(r.ts)} <strong>${esc(r.type)}</strong> ${esc(JSON.stringify(r.detail))}</li>`,
        )
        .join('')}
    </ul>
  </details>`;
}

function collectSelections() {
  const run = snapshot.run;
  const selections = {};
  for (const item of run.items) {
    const checked = root.querySelector(`input[name="choice-${item.id}"]:checked`);
    if (!checked) continue;
    const selection = { productId: checked.value };
    const reduce = root.querySelector(`input[data-reduce][data-item="${item.id}"]`);
    if (reduce?.checked) selection.approveReduction = true;
    selections[item.id] = selection;
  }
  return selections;
}

async function submitSelections() {
  const run = snapshot.run;
  await act(() => api(`/api/run/${run.runId}/selection`, { selections: collectSelections() }));
}

root.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const run = snapshot?.run;
  const { action } = button.dataset;

  if (action === 'interpret') {
    const text = document.getElementById('request-text').value;
    draft = null;
    requestDraft = null;
    await act(() => api('/api/run', { requestText: text }));
    return;
  }
  if (!run) return;

  if (action === 'save-corrections') {
    await act(() => api(`/api/run/${run.runId}/items`, { items: draft.items }));
    return;
  }
  if (action === 'clear-selection') {
    const selections = collectSelections();
    delete selections[button.dataset.item];
    await act(() => api(`/api/run/${run.runId}/selection`, { selections }));
    return;
  }
  if (action === 'review-plan') {
    await act(() => api(`/api/run/${run.runId}/plan`));
    return;
  }
  if (action === 'approve') {
    await act(() => api(`/api/run/${run.runId}/approve`));
    return;
  }
  if (action === 'execute') {
    await act(() => api(`/api/run/${run.runId}/execute`));
    return;
  }
  if (action === 'reconcile') {
    await act(() => api(`/api/run/${run.runId}/reconcile`));
  }
});

root.addEventListener('change', (event) => {
  const el = event.target;
  if (el.matches('input[type="radio"][name^="choice-"]') || el.matches('input[data-reduce]')) {
    submitSelections();
  }
});

root.addEventListener('input', (event) => {
  const el = event.target;
  if (el.id === 'request-text') {
    requestDraft = el.value;
    return;
  }
  if (!draft || !el.dataset.field) return;
  const index = Number(el.dataset.item);
  const field = el.dataset.field;
  draft.items[index][field] = el.type === 'checkbox' ? el.checked : el.value;
});

load();
