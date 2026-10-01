// Local review UI (keyboard-first). Renders backend state; performs no cart
// logic itself and never talks to a retailer. State-changing calls carry the
// session CSRF token. Derivations live in model.js; the backend stays the
// authority and every consequential step is cross-checked against it.

import {
  TONE,
  buildItems,
  sortItems,
  pickLabel,
  previewPlan,
  samePlan,
  executableOf,
  priceIncreases,
  checkRevisedPlan,
  runRows,
  handoffView,
  correctedItems,
  preservedSelections,
  formatMinor,
} from './model.js';

const $ = (id) => document.getElementById(id);
const el = { top: $('top'), strip: $('strip'), main: $('main'), bar: $('bar'), drawer: $('drawer'), overlay: $('overlay'), toast: $('toast'), app: $('app') };

const SAMPLE_REQUEST = `Highlands Corned Beef 150g x2
Pasta Roma Fusilli 500g x2`;
const STEPS = [
  { k: 'list', label: 'List', key: 'g l' },
  { k: 'review', label: 'Review', key: 'g r' },
  { k: 'run', label: 'Add to cart', key: 'g x' },
  { k: 'handoff', label: 'Handoff', key: 'g h' },
];
const FIELDS = [
  ['name', 'Item'],
  ['brand', 'Brand'],
  ['variant', 'Variant'],
  ['sizeText', 'Size'],
  ['quantity', 'Qty'],
];
const LABELS = 'asdfghjklqwertyuiopzxcvbnmASDFGHJKLQWERTYUIOPZXCVBNM1234567890'.split('');
const JUMP_KEY = 's';

let csrf = null;
let snapshot = null;
let pollTimer = null;
let toastTimer = null;
let started = false;

const ui = {
  step: 'list',
  focus: null,
  editing: null, // { field }
  draft: '',
  drawer: false,
  pal: null, // { q, idx }
  flash: null,
  help: false,
  g: false,
  armHandoff: false,
  listText: null,
  notice: null,
  toast: null,
};

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------- backend

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
    ui.notice = `Could not reach the local backend: ${err.message}`;
  }
  if (snapshot && !started) {
    started = true;
    ui.step = initialStep(snapshot.run);
  }
  render();
  managePoll();
}

function initialStep(run) {
  if (!run) return 'list';
  if (run.status === 'executing' || run.status === 'paused' || run.status === 'approved') return 'run';
  if (run.status === 'completed' || run.status === 'handed-off') return 'handoff';
  return 'review';
}

function managePoll() {
  const shouldPoll = Boolean(snapshot?.ownership?.executing);
  if (shouldPoll && !pollTimer) pollTimer = setInterval(load, 400);
  if (!shouldPoll && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Run a backend action; surface failures instead of swallowing them. */
async function act(fn) {
  try {
    await fn();
    ui.notice = null;
  } catch (err) {
    ui.notice = err.message;
    say(err.message);
  }
  await load();
}

function say(message) {
  clearTimeout(toastTimer);
  ui.toast = message;
  renderToast();
  toastTimer = setTimeout(() => {
    ui.toast = null;
    renderToast();
  }, 2600);
}

// ---------------------------------------------------------------- derived

function derive() {
  const run = snapshot?.run ?? null;
  if (!run) return { run: null, views: [], sorted: [], preview: previewPlan([]), cur: null };
  const views = buildItems(run, snapshot.cart);
  const sorted = sortItems(views);
  if (!sorted.some((v) => v.item.id === ui.focus)) ui.focus = sorted[0]?.item.id ?? null;
  const cur = views.find((v) => v.item.id === ui.focus) ?? null;
  return { run, views, sorted, preview: previewPlan(views), cur };
}

const changeCount = (preview) => preview.actions.filter((a) => a.executable && a.kind !== 'none').length;

function editable(run) {
  return Boolean(run) && !snapshot.blocked && !snapshot.ownership.executing && run.status !== 'handed-off' && run.status !== 'completed';
}

function currentSelections(run) {
  return Object.fromEntries(Object.entries(run.selections).map(([k, v]) => [k, { ...v }]));
}

// ---------------------------------------------------------------- render

function render() {
  if (!snapshot) return;
  const focusState = captureFocus();
  const D = derive();
  el.top.innerHTML = topView(D);
  el.strip.innerHTML = stripView();
  el.main.innerHTML = mainView(D);
  el.bar.innerHTML = barView(D);
  el.drawer.innerHTML = ui.drawer ? drawerView(D) : '';
  renderOverlay(D);
  renderToast();
  restoreFocus(focusState);
}

function captureFocus() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  const key = a.dataset?.focusKey;
  if (!key) return null;
  return { key, start: a.selectionStart, end: a.selectionEnd };
}

function restoreFocus(state) {
  if (ui.editing) {
    const input = el.main.querySelector('input[data-focus-key="edit"]');
    if (input && document.activeElement !== input) {
      input.focus();
      if (ui.editing.fresh) {
        input.select();
        ui.editing.fresh = false;
      } else input.setSelectionRange(input.value.length, input.value.length);
    }
    return;
  }
  if (ui.pal) {
    const input = el.overlay.querySelector('input[data-focus-key="pal"]');
    if (input && document.activeElement !== input) input.focus();
    return;
  }
  if (!state) return;
  const target = document.querySelector(`[data-focus-key="${state.key}"]`);
  if (!target) return;
  target.focus();
  if (state.start != null && target.setSelectionRange) target.setSelectionRange(state.start, state.end);
}

const kbd = (text, extra = '') => `<span class="kbd ${extra}">${esc(text)}</span>`;
const dot = (cls) => `<span class="dot dot-${cls}" aria-hidden="true"></span>`;

function topView(D) {
  const ctx = snapshot.simulation.context;
  const steps = STEPS.map((s) => {
    const active = ui.step === s.k;
    return `<button type="button" class="step ${active ? 'on' : ''}" data-flash="step-${s.k}" data-go="${s.k}" title="${esc(s.key)}" ${active ? 'aria-current="step"' : ''}>${esc(s.label)}</button>`;
  }).join('');
  return `
    <div class="brand"><div class="logo" aria-hidden="true">g</div><div class="word">grocer</div></div>
    <div class="ctx" title="${esc(snapshot.simulation.label)}">${dot('ok')}<span class="clip"><b>SIMULATED</b> · ${esc(ctx.branch)}</span></div>
    <nav class="steps" aria-label="Steps">${steps}</nav>
    <div class="grow"></div>
    <button type="button" class="btn ghost" data-flash="btn-jump" data-act="jump">Jump ${kbd(JUMP_KEY, 'gold')}</button>
    <button type="button" class="btn dark" data-flash="btn-pal" data-act="palette">Commands ${kbd('⌘K', 'ondark')}</button>`;
}

function stripView() {
  const lines = [];
  if (snapshot.blocked) {
    const reconcile =
      snapshot.blocked.kind !== 'fatal' && snapshot.run
        ? ` <button type="button" class="btn small" data-flash="btn-reconcile" data-act="reconcile">Reconcile (read-only) ${kbd('c')}</button>`
        : '';
    lines.push(`<div class="strip bad"><span><b>Execution blocked.</b> ${esc(snapshot.blocked.reason)}</span>${reconcile}</div>`);
  }
  if (ui.notice) {
    lines.push(`<div class="strip warn" role="alert"><span>${esc(ui.notice)}</span><button type="button" class="btn small" data-act="dismiss">Dismiss</button></div>`);
  }
  return lines.join('');
}

function mainView(D) {
  switch (ui.step) {
    case 'list':
      return listView();
    case 'review':
      return reviewView(D);
    case 'run':
      return runView(D);
    default:
      return handoffScreen(D);
  }
}

// ---- list

function listView() {
  if (ui.listText === null) ui.listText = snapshot.run?.requestText ?? SAMPLE_REQUEST;
  const lines = ui.listText.split('\n').filter((l) => l.trim()).length;
  return `
  <div class="page narrow"><div class="stack">
    <div class="stack tight">
      <h1>What do you need?</h1>
      <p class="lede">One item per line. Write it however you normally would. Brands, sizes and “x2” quantities are kept exactly as written.</p>
    </div>
    <div class="editor">
      <div class="editor-head"><span>${lines} line${lines === 1 ? '' : 's'}</span><span>i to focus · esc to leave · ⌘↵ interpret</span></div>
      <label class="sr" for="list-text">Grocery request, one item per line</label>
      <textarea id="list-text" data-flash="list-text" data-focus-key="list" spellcheck="false">${esc(ui.listText)}</textarea>
    </div>
    <div class="row gap">
      <button type="button" class="btn primary big" data-flash="btn-interpret" data-act="interpret">Interpret ${lines} line${lines === 1 ? '' : 's'} ${kbd('⌘↵', 'plain')}</button>
      <span class="fine">Interpretation is a proposal. Nothing is added to your cart until you approve a plan.</span>
    </div>
  </div></div>`;
}

// ---- review

function reviewView(D) {
  if (!D.run) {
    return `<div class="page narrow"><div class="stack"><h1>Nothing to review yet</h1><p class="lede">Interpret a list first.</p>
      <button type="button" class="btn primary" data-flash="btn-tolist" data-go="list">Go to list ${kbd('g l', 'plain')}</button></div></div>`;
  }
  const groups = [
    ['Needs you', (v) => v.cls === 'yellow' || v.cls === 'orange'],
    ['No safe match', (v) => v.cls === 'red'],
    ['Ready · exact match', (v) => v.cls === 'green'],
  ].map(([title, f]) => {
    const rows = D.sorted.filter(f);
    if (!rows.length) return '';
    return `<div class="group"><div class="group-head"><span>${title}</span><span>${rows.length}</span></div>${rows.map((v) => rowView(D, v)).join('')}</div>`;
  });
  return `<div class="review">
    <div class="rail" data-list="1">${groups.join('')}</div>
    ${detailView(D)}
    ${sideView(D)}
  </div>`;
}

function stateOf(D, v) {
  if (v.picked) return { text: 'In plan', cls: 'green' };
  if (v.cls === 'green') return { text: 'Excluded', cls: 'plain' };
  return { text: TONE[v.cls].short, cls: v.cls };
}

function rowView(D, v) {
  const on = v.item.id === ui.focus;
  const st = stateOf(D, v);
  return `<button type="button" class="item ${on ? 'on' : ''}" data-flash="row-${esc(v.item.id)}" data-focus-item="${esc(v.item.id)}" ${on ? 'aria-current="true"' : ''}>
    <span class="sw sw-${v.cls}" aria-hidden="true"></span>
    <span class="item-text"><span class="raw">${esc(v.item.raw)}</span><span class="pick">${esc(pickLabel(v))}</span></span>
    <span class="tag tag-${st.cls}">${esc(st.text)}</span>
  </button>`;
}

function statusOf(D, v) {
  const action = D.preview.actions.find((a) => a.itemId === v.item.id);
  if (v.cls === 'red' && !v.picked) return ['bad', 'Unresolved · nothing will be added'];
  if (action) {
    if (action.kind === 'add') return ['ok', `In plan · adds ${action.units} · ${formatMinor(action.costMinor)}`];
    if (action.kind === 'none') return ['ok', 'In plan · already in cart, nothing added'];
    return action.executable
      ? ['warn', `In plan · reduces cart by ${action.units} (approved)`]
      : ['warn', `Cart has ${v.existing}, target is ${v.target} · excess is kept unless you approve reduction`];
  }
  if (v.cls === 'green') return ['plain', 'Excluded by you'];
  return [v.cls, 'Not in plan · pick a candidate to include'];
}

function detailView(D) {
  const v = D.cur;
  const idx = D.sorted.findIndex((x) => x.item.id === v.item.id) + 1;
  const item = v.item;
  const chips = FIELDS.map(([field, label]) => chipView(v, field, label)).join('');
  const noSub = `<button type="button" class="chip ${item.restrictions?.noSubstitution ? 'on' : ''}" data-flash="chip-nosub" data-act="nosub" aria-pressed="${Boolean(item.restrictions?.noSubstitution)}"><span class="chip-label">Rule</span><span class="chip-text">${item.restrictions?.noSubstitution ? 'no substitutions' : 'substitutes allowed'}</span><span class="chip-mark">N</span></button>`;
  const reduction = v.needsReduction
    ? `<button type="button" class="chip ${v.approveReduction ? 'on' : ''}" data-flash="chip-reduce" data-act="reduce" aria-pressed="${v.approveReduction}"><span class="chip-label">Cart</span><span class="chip-text">${v.approveReduction ? `reduction ${v.existing} → ${v.target} approved` : `approve reduction ${v.existing} → ${v.target}`}</span><span class="chip-mark">r</span></button>`
    : '';
  const notes = [
    ...(item.assumptions ?? []).map((a) => `<li class="note">Assumed: ${esc(a)}</li>`),
    ...(item.unresolved ?? []).map((u) => `<li class="note bad">Unresolved: ${esc(u)}</li>`),
  ].join('');
  const cands = v.candidates.length
    ? v.candidates.map((c, i) => candidateView(v, c, i)).join('')
    : '<p class="fine">No candidate discovered; this request stays unresolved.</p>';
  const [stCls, stText] = statusOf(D, v);
  const included = Boolean(v.picked);
  const editable_ = editable(D.run);
  return `
  <section class="detail" aria-label="Selected item">
    <div class="scroll">
      <div class="row wrap gap-s">
        <span class="mono pos">${String(idx).padStart(2, '0')} / ${D.views.length}</span>
        <span class="tag tone-${v.cls}">${esc(TONE[v.cls].label)}</span>
        <div class="grow"></div>
        <button type="button" class="btn small" data-flash="btn-drawer" data-act="drawer">Evidence &amp; journal ${kbd('d', 'plain')}</button>
      </div>
      <div class="stack tight"><div class="eyebrow">You wrote</div><div class="wrote">${esc(item.raw)}</div></div>
      <div class="stack tight">
        <div class="eyebrow">Interpreted as <span class="eyebrow-hint">e edit · q qty · tab next field · ↵ save · esc cancel</span></div>
        <div class="row wrap gap-s">${chips}${noSub}${reduction}</div>
        ${notes ? `<ul class="notes">${notes}</ul>` : ''}
      </div>
      <div class="cands">${cands}</div>
    </div>
    <div class="actions">
      <div class="status"><span class="dot dot-${stCls}" aria-hidden="true"></span><span class="status-text status-${stCls}" title="${esc(stText)}">${esc(stText)}</span></div>
      <div class="row wrap gap-s">
        <button type="button" class="btn" data-flash="btn-exclude" data-act="exclude" ${editable_ ? '' : 'disabled'}>${included ? 'Exclude' : 'Include'} ${kbd('x', 'plain')}</button>
        <button type="button" class="btn" data-flash="btn-prev" data-act="prev">Previous ${kbd('k', 'plain')}</button>
        <button type="button" class="btn dark" data-flash="btn-next" data-act="next">Next decision ${kbd('n', 'ondark')}</button>
      </div>
    </div>
  </section>`;
}

function chipView(v, field, label) {
  const item = v.item;
  const raw = { name: item.name, brand: item.brand, variant: item.variant, sizeText: item.size?.display, quantity: item.quantity }[field];
  const missing = raw == null || raw === '';
  if (ui.editing?.field === field) {
    return `<input class="chip-input" data-focus-key="edit" data-edit="${field}" value="${esc(ui.draft)}" placeholder="${esc(label)}" aria-label="${esc(label)}" ${field === 'quantity' ? 'inputmode="numeric"' : ''} />`;
  }
  const text = missing ? 'not specified' : field === 'quantity' ? `×${raw}` : raw;
  const mark = field === 'quantity' ? 'q' : '';
  return `<button type="button" class="chip ${missing ? 'missing' : ''}" data-flash="chip-${field}" data-edit-field="${field}"><span class="chip-label">${esc(label)}</span><span class="chip-text">${esc(text)}</span><span class="chip-mark">${mark}</span></button>`;
}

function candidateView(v, c, i) {
  const p = c.product;
  const on = v.picked?.product.id === p.id;
  const tag = !c.selectable ? 'Not selectable' : c.color === 'orange' ? 'Substitution' : c.modelRank === 1 ? 'Recommended' : c.color === 'green' ? 'Exact match' : '';
  const tagCls = !c.selectable ? 'red' : c.color === 'orange' ? 'orange' : 'green';
  const model = c.modelRationale && !c.reason.includes(c.modelRationale.replace(/^Model: /, '')) && c.modelRationale !== c.reason ? ` <span class="model">Model: ${esc(c.modelRationale)}</span>` : '';
  return `<button type="button" class="cand ${on ? 'on' : ''} ${c.selectable ? '' : 'disabled'}" data-flash="cand-${i}" data-pick="${i}" aria-pressed="${on}" ${c.selectable ? '' : 'aria-disabled="true"'}>
    <span class="cand-key">${i + 1}</span>
    <span class="cand-main">
      <span class="row wrap gap-s"><b class="cand-name">${esc(p.brand)} ${esc(p.name)}</b><span>${esc(p.sizeDisplay)}</span>${tag ? `<span class="tag tag-${tagCls}">${tag}</span>` : ''}</span>
      <span class="cand-note">${esc(c.reason)}${model}</span>
    </span>
    <span class="cand-price"><b>${esc(p.priceDisplay)}</b><span class="mono">${on ? 'SELECTED' : ''}</span></span>
  </button>`;
}

function sideView(D) {
  const P = D.preview;
  const run = D.run;
  const approved = Boolean(run.approvalValid && run.approval);
  const rows = [
    ['In plan', P.actions.length, 'green'],
    ['Awaiting your choice', P.awaiting.length, 'yellow'],
    ['Unresolved · not added', P.unresolved.length, 'red'],
    ['Excluded by you', P.excluded.length, 'plain'],
  ]
    .map(([label, n, cls]) => `<div class="sum"><span class="row gap-s">${dot(cls)}${label}</span><b>${n}</b></div>`)
    .join('');
  const pending = P.awaiting.length && !approved
    ? `<div class="callout">${P.awaiting.length} request${P.awaiting.length === 1 ? '' : 's'} without a choice will not be added. You can approve now; they stay listed as not fulfilled.</div>`
    : '';
  const done = run.status === 'completed' || run.status === 'handed-off';
  const title = done ? 'Run finished · view' : approved ? 'Approved · view run' : 'Approve plan';
  const sub = `${changeCount(P)} change${changeCount(P) === 1 ? '' : 's'} · ${formatMinor(P.totalMinor)}`;
  return `
  <aside class="side" aria-label="Plan">
    <div class="eyebrow">Plan <span class="eyebrow-hint">revision ${run.revision}</span></div>
    <div class="stack tight">${rows}</div>
    <div class="total"><span>Estimated added to cart</span><b>${formatMinor(P.totalMinor)}</b></div>
    ${pending}
    <button type="button" class="approve ${approved || done ? 'done' : ''}" data-flash="btn-approve" data-act="approve">
      <span class="approve-title">${title}${kbd('⇧A', 'plain')}</span><span class="approve-sub">${esc(sub)}</span>
    </button>
    <p class="fine">Approval covers only the selected products and target quantities listed. Price increases will pause the run for reapproval.</p>
    <p class="fine foot">The simulated cart has ${snapshot.cart.length} line${snapshot.cart.length === 1 ? '' : 's'}. They are left untouched unless they match a request.</p>
  </aside>`;
}

// ---- run

function runView(D) {
  const run = D.run;
  const status = run?.status;
  if (!run || (status !== 'approved' && status !== 'executing' && status !== 'paused' && status !== 'completed' && status !== 'handed-off')) {
    return `<div class="page narrow"><div class="stack">
      <h1>No approved plan yet</h1>
      <p class="lede">Nothing has been added to your cart. Review your list and approve a plan with <b>⇧A</b>.</p>
      <button type="button" class="btn primary" data-flash="btn-toreview" data-go="review">Back to review ${kbd('g r', 'plain')}</button>
    </div></div>`;
  }
  const rows = runRows(run, snapshot.attempts, snapshot.catalog);
  const increases = status === 'paused' ? priceIncreases(run.plan, snapshot.catalog) : [];
  const verification = run.verification;
  const finished = status === 'completed' || status === 'handed-off';
  const bad = verification?.discrepancies?.length ?? 0;
  const nVerified = rows.filter((r) => r.state === 'verified in cart').length;
  let eyebrow;
  let title;
  let sub;
  if (status === 'paused') {
    eyebrow = 'Run paused';
    const at = rows.findIndex((r) => r.kind === 'pause');
    title = at >= 0 ? `Paused at ${at + 1} of ${rows.length}` : 'Run paused';
    sub = 'No further cart changes will be sent until you decide.';
  } else if (status === 'executing') {
    eyebrow = 'Adding to cart';
    title = `Adding ${rows.length} item${rows.length === 1 ? '' : 's'}`;
    sub = 'Each change is sent only as approved, then the cart is checked against the plan.';
  } else if (status === 'approved') {
    eyebrow = 'Approved · not started';
    title = `${rows.length} change${rows.length === 1 ? '' : 's'} approved`;
    sub = 'Nothing has been sent yet. Start when you are ready.';
  } else {
    eyebrow = bad ? 'Run finished · discrepancies found' : 'Run finished · cart verified';
    title = `${nVerified} of ${rows.length} approved changes verified in cart`;
    sub = bad
      ? `The approved changes were checked, but ${bad} plan line${bad === 1 ? ' does' : 's do'} not match the cart. Review them before checkout.`
      : 'Every approved line was checked against the plan after adding. This is the simulated cart.';
  }

  let card = '';
  if (status === 'paused') {
    const price = increases.length;
    const heading = price ? 'Price increased since approval' : 'The run paused';
    const lines = increases
      .map((i) => `<li>${esc(i.name)} is now ${formatMinor(i.nowMinor)} (approved at ${formatMinor(i.approvedMinor)}).</li>`)
      .join('');
    const actions = [];
    if (price) {
      const label = increases.length === 1 ? `Reapprove at ${formatMinor(increases[0].nowMinor)} × ${increases[0].units}` : `Reapprove ${increases.length} new prices`;
      actions.push(`<button type="button" class="btn primary" data-flash="btn-reapprove" data-act="reapprove">${esc(label)} ${kbd('r', 'plain')}</button>`);
      actions.push(`<button type="button" class="btn" data-flash="btn-remove" data-act="remove">Remove from plan ${kbd('x', 'plain')}</button>`);
    }
    actions.push(`<button type="button" class="btn" data-flash="btn-reconcile2" data-act="reconcile">Reconcile (read-only) ${kbd('c', 'plain')}</button>`);
    card = `<div class="pause"><div class="pause-title">${heading}</div>
      ${lines ? `<ul class="pause-lines">${lines}</ul>` : ''}
      <div class="pause-reason">${esc(run.pauseReason ?? '')}</div>
      <div class="row wrap gap-s">${actions.join('')}</div></div>`;
  } else if (status === 'approved') {
    card = `<div class="row"><button type="button" class="btn primary big" data-flash="btn-start" data-act="start">Start adding to cart ${kbd('↵', 'plain')}</button></div>`;
  } else if (status === 'completed') {
    card = `<div class="row"><button type="button" class="btn primary big" data-flash="btn-handoff" data-go="handoff">See verified cart ${kbd('↵', 'plain')}</button></div>`;
  }
  const list = rows
    .map((r) => `<div class="prow"><span class="pdot pdot-${r.kind}" aria-hidden="true"></span><span class="pname ${r.kind === 'wait' ? 'dim' : ''}">${esc(r.label)}</span><span class="mono pstate ${r.kind === 'wait' ? 'dim' : ''}">${esc(r.state)}</span></div>`)
    .join('');
  return `<div class="page medium"><div class="stack">
    <div class="stack tight"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="lede">${esc(sub)}</p></div>
    ${card}
    <div class="panel">${list || '<div class="prow"><span class="pname dim">The approved plan has no cart changes.</span></div>'}</div>
    <p class="fine">You can close this tab. The run continues while Grocer is running on this computer.</p>
  </div></div>`;
}

// ---- handoff

function handoffScreen(D) {
  const run = D.run;
  const verified = run && (run.status === 'completed' || run.status === 'handed-off') && run.verification;
  if (!verified) {
    return `<div class="page narrow"><div class="stack"><h1>Cart not verified yet</h1>
      <p class="lede">The handoff appears once the approved run finishes and the cart has been checked against the plan.</p></div></div>`;
  }
  const H = handoffView(run, D.views);
  const handed = run.status === 'handed-off';
  const badge = H.discrepancies ? 'Discrepancies found' : H.clean ? 'Cart verified' : 'Cart verified · partial';
  const badgeCls = H.discrepancies ? 'red' : H.clean ? 'green' : 'yellow';
  const title = `${H.verified} of ${H.total} requests are in your cart`;
  const sub = H.discrepancies
    ? 'The cart does not match the plan for some lines. Check them below before you check out.'
    : H.clean
      ? 'Every request was added and checked against the plan.'
      : `Approved items were added and checked against the plan. ${H.total - H.verified} request${H.total - H.verified === 1 ? ' was' : 's were'} not added and still need you.`;
  const stat = (n, label, cls) => `<div class="stat stat-${cls}"><b>${n}</b><span>${esc(label)}</span></div>`;
  const s = H.stats;
  const stats = [
    stat(s.exact, 'Exact matches verified', 'green'),
    stat(s.choices, `Your choices verified${s.substitutes ? ` · ${s.substitutes} substitute` : ''}`, 'plain'),
    stat(s.notChosen, 'Not chosen or excluded', 'yellow'),
    stat(s.trouble, 'Unresolved or discrepant', s.trouble ? 'red' : 'plain'),
  ].join('');
  const rows = H.rows
    .map(
      (r) => `<div class="hrow"><span class="mono clip">${esc(r.raw)}</span><span class="clip strong">${esc(r.pick)}</span><span class="num">×${r.target}</span><span class="num strong">${r.inCart ? `×${r.inCart}` : '0'}</span><span class="num">${esc(r.added)}</span><span><span class="tag tag-${r.tone}" ${r.note ? `title="${esc(r.note)}"` : ''}>${esc(r.result)}</span></span></div>`,
    )
    .join('');
  const notes = [
    ...(H.discrepancies ? run.verification.discrepancies.map((d) => `Discrepancy: expected ${d.expected}, observed ${d.observed}. ${d.note}`) : []),
    ...(H.extras.length ? [`${H.extras.length} other line${H.extras.length === 1 ? '' : 's'} already in the cart were left untouched.`] : []),
    ...H.priceDecreases.map((d) => `${d.name} came in lower than approved (${d.approvedDisplay} → ${d.observedDisplay}).`),
  ];
  const action = handed
    ? `<div class="callout good">Handed off to manual checkout${run.handoff?.at ? ` at ${esc(run.handoff.at)}` : ''}. This prepared cart is not a recorded purchase. Automated retailer activity is stopped for this run.</div>`
    : `<button type="button" class="btn primary big" data-flash="btn-checkout" data-act="handoff">${ui.armHandoff ? 'Press again to confirm handoff' : 'Hand off to manual checkout'} ${kbd('o', 'plain')}</button>`;
  return `<div class="page wide"><div class="stack">
    <div class="hero">
      <div class="stack tight"><div><span class="tag tag-${badgeCls} lg">${badge}</span></div><h1 class="h38">${esc(title)}</h1><p class="lede small">${esc(sub)}</p></div>
      <div class="hero-side"><div class="right"><div class="fine">Added by the last approval (estimate)</div><div class="big-num">${formatMinor(H.addedMinor)}</div></div>${action}</div>
    </div>
    <div class="stats">${stats}</div>
    <div class="panel">
      <div class="hrow hhead"><span>Request</span><span>Approved product</span><span class="num">Target</span><span class="num">In cart</span><span class="num">Added</span><span>Result</span></div>
      ${rows}
    </div>
    <div class="stack tight fine">${notes.map((n) => `<div>${esc(n)}</div>`).join('')}<div>Handing off stops all automated retailer activity for this run. It does not submit an order or payment; checkout and payment are yours, and later changes are not monitored.</div></div>
  </div></div>`;
}

// ---- footer / drawer / overlays

function modeOf() {
  if (ui.flash) return ['JUMP', 'jump'];
  if (ui.pal) return ['COMMAND', 'cmd'];
  if (ui.editing) return ['EDIT', 'edit'];
  if (ui.g) return ['g …', 'g'];
  return ['NORMAL', 'normal'];
}

function barView(D) {
  const [mode, cls] = modeOf();
  const fk = JUMP_KEY;
  let hints;
  if (ui.flash) hints = 'type a label to jump · esc cancel';
  else if (ui.pal) hints = '↑↓ choose · ↵ run · esc close';
  else if (ui.editing) hints = '↵ save · tab next field · esc cancel';
  else if (ui.g) hints = 'l list · r review · x run · h handoff · g first item';
  else if (ui.step === 'review') hints = `j/k move · 1–9 pick · n next decision · e edit · q qty · x exclude · d evidence · ⇧A approve · ${fk} jump · ⌘K commands · ? help`;
  else if (ui.step === 'list') hints = `i edit list · ⌘↵ interpret · ${fk} jump · ⌘K commands · ? help`;
  else if (ui.step === 'run') hints = `r reapprove · x remove · c reconcile · ↵ continue · ${fk} jump · ⌘K commands`;
  else hints = `o hand off · ${fk} jump · ⌘K commands · ? help`;
  const P = D.preview;
  const run = D.run;
  let right = 'no run yet';
  if (run) {
    const money = formatMinor(P.totalMinor);
    right = run.approvalValid
      ? `approved · ${P.actions.length} lines · ${money}`
      : `${P.awaiting.length} decision${P.awaiting.length === 1 ? '' : 's'} left · ${P.actions.length} in plan · ${money}`;
    if (run.status === 'executing') right = 'adding to cart…';
    if (run.status === 'paused') right = 'paused';
    if (run.status === 'completed') right = 'finished · verified';
    if (run.status === 'handed-off') right = 'handed off';
  }
  return `<span class="mode mode-${cls}">${mode}</span><span class="hints">${esc(hints)}</span><div class="grow"></div><span class="right-status">${esc(right)}</span>`;
}

function drawerView(D) {
  const v = D.cur;
  const run = D.run;
  const lines = [];
  if (v) {
    lines.push(`<div class="mono ev-raw">${esc(v.item.raw)}</div>`);
    for (const c of v.candidates) {
      const p = c.product;
      lines.push(`<div class="ev">${esc(c.color)} · ${esc(p.brand)} ${esc(p.name)} ${esc(p.sizeDisplay)} — ${esc(c.reason)}<br>evidence: ${esc(p.provenance?.source ?? 'unknown')}${p.evidenceNote ? ` — ${esc(p.evidenceNote)}` : ''}${c.modelRank != null ? `<br>model rank ${c.modelRank}` : ''}</div>`);
    }
  }
  const interp = run?.interpretation;
  const problems = interp?.problems ?? [];
  const session = snapshot.retailerSession ?? { available: false };
  const sessionBlock = session.available
    ? `<div class="eyebrow">Dedicated retailer session</div>
       <div class="fine">Sign-in happens directly in the isolated retailer browser, never here. Context check: <b>${esc(session.state ?? 'not-checked')}</b>${session.verified ? ' — account and branch verified' : ' — a plan cannot become execution-ready until this verifies'}</div>
       ${(session.problems ?? []).map((p) => `<div class="ev">${esc(p)}</div>`).join('')}
       ${(session.cart?.lines ?? []).map((l) => `<div class="ev">${esc(l.productId)} × ${l.quantity}${l.money?.display ? ` — ${esc(l.money.display)}` : ''}</div>`).join('') || '<div class="fine">No verified live cart contents observed.</div>'}
       <div class="row wrap gap-s"><button type="button" class="btn small" data-flash="btn-verify" data-act="verify-session">Verify context</button><button type="button" class="btn small" data-flash="btn-readcart" data-act="read-cart">Read verified cart</button></div>`
    : '';
  const journal = (snapshot.journalTail ?? [])
    .map((r) => `<li>${esc(r.ts)} <b>${esc(r.type)}</b> ${esc(JSON.stringify(r.detail))}</li>`)
    .join('');
  return `<aside class="drawer" aria-label="Evidence and journal">
    <div class="row between"><span class="eyebrow">Evidence &amp; journal</span><button type="button" class="btn small" data-flash="btn-drawer-close" data-act="drawer">esc</button></div>
    <div class="stack tight">${lines.join('') || '<div class="fine">No item selected.</div>'}</div>
    ${problems.length ? `<div class="stack tight"><div class="eyebrow">Validation notes</div>${problems.map((p) => `<div class="ev">${esc(p)}</div>`).join('')}</div>` : ''}
    ${sessionBlock}
    <div class="dashed fine stack tight">
      <div>${esc(snapshot.simulation.label)}</div>
      <div>interpretation · ${interp ? esc(interp.provider) + (interp.fallback ? ' (offline fallback)' : ' (proposal-only model)') : 'none yet'}</div>
      <div>gates · brand, size, variant are hard constraints</div>
      <div>writes · none until plan approval</div>
    </div>
    <details class="journal"><summary>Safety journal — ${(snapshot.journalTail ?? []).length} recent records</summary><ul>${journal}</ul></details>
  </aside>`;
}

function commandList(D) {
  const L = [];
  const run = D.run;
  STEPS.forEach((s) => L.push({ group: 'Go', label: `Go to ${s.label}`, keys: s.key, run: () => go(s.k) }));
  if (run) {
    L.push({ group: 'Review', label: 'Next item needing a decision', keys: 'n', run: () => { go('review'); nextDecision(); } });
    if (D.cur) {
      D.cur.candidates.forEach((c, i) => {
        if (c.selectable) L.push({ group: 'Pick', label: `${c.product.brand} ${c.product.name} ${c.product.sizeDisplay} for “${D.cur.item.raw}”`, keys: String(i + 1), run: () => { go('review'); pick(i); } });
      });
      FIELDS.forEach(([field, label]) => L.push({ group: 'Edit', label: `${label} · “${D.cur.item.raw}”`, keys: field === 'quantity' ? 'q' : 'e', run: () => setTimeout(() => startEdit(field), 0) }));
    }
    L.push({ group: 'Plan', label: run.approvalValid ? 'View run progress' : `Approve plan · ${changeCount(D.preview)} changes · ${formatMinor(D.preview.totalMinor)}`, keys: '⇧A', run: () => approve() });
    L.push({ group: 'Review', label: 'Exclude / include current item', keys: 'x', run: () => toggleExclude() });
    if (run.status === 'paused') {
      L.push({ group: 'Run', label: 'Reapprove at the new prices', keys: 'r', run: () => reapprove() });
      L.push({ group: 'Run', label: 'Remove price-changed item from plan', keys: 'x', run: () => removePaused() });
    }
    if (snapshot.blocked && snapshot.blocked.kind !== 'fatal') L.push({ group: 'Run', label: 'Reconcile (read-only)', keys: 'c', run: () => reconcile() });
    if (run.status === 'completed') L.push({ group: 'Handoff', label: 'Hand off to manual checkout', keys: 'o', run: () => handoff() });
  }
  L.push({ group: 'View', label: 'Toggle evidence & journal', keys: 'd', run: () => { ui.drawer = !ui.drawer; render(); } });
  L.push({ group: 'View', label: 'Jump to anything on screen', keys: JUMP_KEY, run: () => setTimeout(enterFlash, 40) });
  L.push({ group: 'View', label: 'Keyboard shortcuts', keys: '?', run: () => { ui.help = true; render(); } });
  if (snapshot.retailerSession?.available) {
    L.push({ group: 'Session', label: 'Verify retailer context', keys: '', run: () => act(() => api('/api/retailer/verify')) });
    L.push({ group: 'Session', label: 'Read verified cart', keys: '', run: () => act(() => api('/api/retailer/cart')) });
  }
  D.views.forEach((v) => L.push({ group: 'Item', label: v.item.raw, keys: '', run: () => focusItem(v.item.id) }));
  return L;
}

function paletteRows(D) {
  const toks = ui.pal.q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = commandList(D);
  const rows = all.filter((c) => toks.every((t) => `${c.label} ${c.group}`.toLowerCase().includes(t)));
  return rows;
}

function renderOverlay(D) {
  const parts = [];
  if (ui.flash) {
    const boxes = ui.flash
      .map((f) => `<div class="flash-box" style="left:${f.x - 3}px;top:${f.y - 3}px;width:${f.w + 6}px;height:${f.h + 6}px"></div><div class="flash-label" style="left:${f.x - 8}px;top:${f.y - 10}px">${esc(f.label)}</div>`)
      .join('');
    parts.push(`<div class="flash" aria-hidden="true">${boxes}</div>`);
  }
  if (ui.pal) {
    const rows = paletteRows(D);
    const idx = Math.min(ui.pal.idx, Math.max(0, rows.length - 1));
    ui.pal.idx = idx;
    const list = rows
      .map((c, i) => `<button type="button" class="pal-row ${i === idx ? 'on' : ''}" data-pal-run="${i}" ${i === idx ? 'data-pal-active="1"' : ''}><span class="pal-group">${esc(c.group)}</span><span class="pal-label">${esc(c.label)}</span>${c.keys ? kbd(c.keys, 'plain') : ''}</button>`)
      .join('');
    parts.push(`<div class="scrim high" data-close="pal"><div class="pal" role="dialog" aria-label="Command palette">
      <div class="pal-head"><span class="mono">&gt;</span><input data-focus-key="pal" value="${esc(ui.pal.q)}" placeholder="Type a command, item, or product…" aria-label="Command" autocomplete="off" /><span class="mono small">↑↓ ↵ esc</span></div>
      <div class="pal-list" data-pal="1">${list}${rows.length ? '' : '<div class="pal-empty">No matching commands.</div>'}</div></div></div>`);
  }
  if (ui.help) parts.push(helpView());
  el.overlay.innerHTML = parts.join('');
  if (ui.pal) {
    const box = el.overlay.querySelector('[data-pal]');
    const active = box?.querySelector('[data-pal-active="1"]');
    if (active) {
      const er = active.getBoundingClientRect();
      const br = box.getBoundingClientRect();
      if (er.top < br.top) box.scrollTop -= br.top - er.top + 8;
      else if (er.bottom > br.bottom) box.scrollTop += er.bottom - br.bottom + 8;
    }
  }
}

function helpView() {
  const line = (a, b) => `<div class="help-line"><span>${a}</span><b class="mono">${b}</b></div>`;
  return `<div class="scrim center" data-close="help"><div class="help" role="dialog" aria-label="Keyboard">
    <div class="help-head"><span class="h24">Keyboard</span><span class="mono small">? or esc to close</span></div>
    <div class="stack tight"><div class="eyebrow">Anywhere</div>${line('Command palette', '⌘K  :')}${line('Jump to anything', JUMP_KEY)}${line('Go to List / Review', 'g l  g r')}${line('Go to Run / Handoff', 'g x  g h')}${line('Prev / next step', '[  ]')}</div>
    <div class="stack tight"><div class="eyebrow">Review</div>${line('Move between items', 'j  k')}${line('First / last item', 'g g  G')}${line('Pick candidate', '1 – 9')}${line('Next needing decision', 'n  ↵')}${line('Edit field / quantity', 'e  q')}${line('No substitutions', 'N')}${line('Approve reduction', 'r')}${line('Exclude / include', 'x')}${line('Evidence &amp; journal', 'd')}${line('Approve plan', '⇧A')}</div>
    <div class="stack tight"><div class="eyebrow">Run &amp; handoff</div>${line('Reapprove price', 'r')}${line('Remove paused item', 'x')}${line('Reconcile (read-only)', 'c')}${line('Continue / start', '↵')}${line('Hand off (press twice)', 'o')}<div class="eyebrow mt">Jump mode</div><div class="fine">Press ${JUMP_KEY}, then the orange label on any button, item, chip or candidate. Esc cancels.</div></div>
  </div></div>`;
}

function renderToast() {
  el.toast.innerHTML = ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : '';
}

// ---------------------------------------------------------------- actions

function go(step) {
  ui.step = step;
  ui.drawer = false;
  ui.editing = null;
  ui.armHandoff = false;
  render();
}

function stepBy(d) {
  const i = STEPS.findIndex((s) => s.k === ui.step);
  go(STEPS[Math.max(0, Math.min(STEPS.length - 1, i + d))].k);
}

function focusItem(id) {
  ui.focus = id;
  ui.step = 'review';
  ui.editing = null;
  render();
  requestAnimationFrame(() => {
    const row = el.main.querySelector(`[data-focus-item="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });
}

function move(d) {
  const D = derive();
  if (!D.sorted.length) return;
  const i = D.sorted.findIndex((x) => x.item.id === ui.focus);
  focusItem(D.sorted[(i + d + D.sorted.length) % D.sorted.length].item.id);
}

function nextDecision() {
  const D = derive();
  if (!D.sorted.length) return;
  const open = new Set(D.preview.awaiting.map((v) => v.item.id));
  const i = D.sorted.findIndex((x) => x.item.id === ui.focus);
  const order = D.sorted.slice(i + 1).concat(D.sorted.slice(0, i + 1));
  const next = order.find((v) => open.has(v.item.id) && v.item.id !== ui.focus);
  if (next) focusItem(next.item.id);
  else say(open.size ? 'This is the last open decision' : 'No decisions left · approve with ⇧A');
}

function guardEditable(D) {
  if (!D.run) return false;
  if (!editable(D.run)) {
    say(snapshot.blocked ? 'Blocked · reconcile first' : 'This run can no longer be changed');
    return false;
  }
  return true;
}

function pick(i) {
  const D = derive();
  if (!D.cur || !guardEditable(D)) return;
  const c = D.cur.candidates[i];
  if (!c) return;
  if (!c.selectable) return say(`Not selectable · ${c.reason}`);
  const was = D.cur.picked?.product.id === c.product.id;
  const withdrawn = D.run.approvalValid;
  const selections = currentSelections(D.run);
  if (was) delete selections[D.cur.item.id];
  else selections[D.cur.item.id] = { productId: c.product.id };
  act(async () => {
    await api(`/api/run/${D.run.runId}/selection`, { selections });
    say(withdrawn ? 'Plan changed · approval withdrawn' : was ? `Cleared choice · ${D.cur.item.raw}` : `Picked ${c.product.brand} ${c.product.name} ${c.product.sizeDisplay}`);
  });
}

function toggleExclude() {
  const D = derive();
  if (!D.cur || !guardEditable(D)) return;
  const v = D.cur;
  if (v.cls === 'red' && !v.picked) return say('Unresolved items are never added');
  const selections = currentSelections(D.run);
  if (v.picked) {
    delete selections[v.item.id];
  } else if (v.cls === 'green') {
    const exact = v.candidates.find((c) => c.selectable && c.color === 'green');
    if (!exact) return say('No exact match to include');
    selections[v.item.id] = { productId: exact.product.id };
  } else {
    return say('Pick a candidate (1–9) to include this item');
  }
  act(async () => {
    await api(`/api/run/${D.run.runId}/selection`, { selections });
    say(v.picked ? `Excluded · ${v.item.raw}` : `Included · ${v.item.raw}`);
  });
}

function toggleReduction() {
  const D = derive();
  if (!D.cur || !guardEditable(D)) return;
  if (!D.cur.needsReduction) return say('No reduction needed for this item');
  const selections = currentSelections(D.run);
  const sel = selections[D.cur.item.id];
  if (D.cur.approveReduction) delete sel.approveReduction;
  else sel.approveReduction = true;
  act(() => api(`/api/run/${D.run.runId}/selection`, { selections }));
}

function toggleNoSubstitution() {
  const D = derive();
  if (!D.cur || !guardEditable(D)) return;
  const on = !D.cur.item.restrictions?.noSubstitution;
  correct(D, D.cur.item.id, 'noSubstitution', on, on ? 'No substitutions · re-matched' : 'Substitutions allowed · re-matched');
}

/** Save one corrected field, then re-apply the user's other explicit choices. */
function correct(D, itemId, field, value, message) {
  act(async () => {
    const before = D.run;
    const { run: after } = await api(`/api/run/${before.runId}/items`, { items: correctedItems(before, itemId, field, value) });
    const kept = preservedSelections(before, after, itemId);
    await api(`/api/run/${before.runId}/selection`, { selections: kept });
    say(message ?? 'Corrected · item re-matched · other choices kept');
  });
}

function startEdit(field) {
  const D = derive();
  if (!D.cur || !guardEditable(D)) return;
  const item = D.cur.item;
  const raw = { name: item.name, brand: item.brand, variant: item.variant, sizeText: item.size?.display, quantity: item.quantity }[field];
  ui.editing = { field, itemId: item.id, fresh: true };
  ui.draft = raw == null ? '' : String(raw);
  ui.step = 'review';
  render();
}

function firstEditField(D) {
  const item = D.cur.item;
  const missing = [['brand', item.brand], ['variant', item.variant], ['sizeText', item.size?.display]].find(([, v]) => v == null || v === '');
  return missing ? missing[0] : 'name';
}

function finishEdit(save) {
  const editing = ui.editing;
  if (!editing) return;
  ui.editing = null;
  const D = derive();
  const item = D.run?.items.find((i) => i.id === editing.itemId);
  render();
  if (!save || !item) return;
  const current = { name: item.name, brand: item.brand, variant: item.variant, sizeText: item.size?.display, quantity: item.quantity }[editing.field];
  const next = ui.draft.trim();
  if (next === String(current ?? '')) return;
  if (editing.field === 'quantity' && !(Number.isInteger(Number(next)) && Number(next) > 0)) return say('Quantity must be a whole number of at least 1');
  correct(D, editing.itemId, editing.field, editing.field === 'quantity' ? Number(next) : next);
}

function tabEdit(shift) {
  const keys = FIELDS.map((f) => f[0]);
  const cur = ui.editing?.field;
  if (!cur) return;
  const next = keys[(keys.indexOf(cur) + (shift ? keys.length - 1 : 1)) % keys.length];
  finishEdit(true);
  setTimeout(() => startEdit(next), 0);
}

function interpret() {
  const text = ui.listText ?? '';
  if (!text.trim()) return say('Write at least one line first');
  if (document.activeElement?.blur) document.activeElement.blur();
  act(async () => {
    const { run } = await api('/api/run', { requestText: text });
    ui.step = 'review';
    ui.focus = null;
    const open = run.items.length;
    say(`Interpreted ${open} line${open === 1 ? '' : 's'}`);
  });
}

function approve() {
  const D = derive();
  const run = D.run;
  if (!run) return say('Interpret a list first');
  if (run.status === 'completed' || run.status === 'handed-off') return go('handoff');
  if (run.approvalValid || run.status === 'executing') return go('run');
  if (snapshot.blocked) return say(`Blocked · ${snapshot.blocked.reason}`);
  if (!D.preview.actions.length) return say('Nothing in plan to approve');
  act(async () => {
    const { plan } = await api(`/api/run/${run.runId}/plan`);
    if (!samePlan(D.preview, plan)) {
      throw new Error('The plan the backend reviewed differs from what is on screen. Nothing was approved; check the plan and try again.');
    }
    await api(`/api/run/${run.runId}/approve`);
    ui.step = 'run';
    say(`Plan approved · ${changeCount(D.preview)} change${changeCount(D.preview) === 1 ? '' : 's'} · ${formatMinor(D.preview.totalMinor)}`);
    await api(`/api/run/${run.runId}/execute`);
  });
}

function startRun() {
  const run = snapshot?.run;
  if (!run) return;
  act(() => api(`/api/run/${run.runId}/execute`));
}

function reconcile() {
  const run = snapshot?.run;
  if (!run) return say('No run to reconcile');
  act(async () => {
    const result = await api(`/api/run/${run.runId}/reconcile`);
    say(result.stillBlocked ? result.reason ?? 'Still blocked · an unresolved attempt remains' : 'Reconciled · execution ownership released');
  });
}

/**
 * Resume after a price pause (ADR-0003). Reconcile read-only to release
 * ownership, re-review the remainder, require that the revised plan stays
 * within what the user was shown, then approve and execute that plan.
 */
function resume(removeItemId) {
  const D = derive();
  const run = D.run;
  if (!run || run.status !== 'paused') return say('Nothing is paused');
  const previous = run.plan;
  const increases = priceIncreases(previous, snapshot.catalog);
  if (!increases.length && !removeItemId) return say('The pause is not a price change · reconcile and review instead');
  const acknowledged = Object.fromEntries(increases.map((i) => [i.productId, i.nowMinor]));
  act(async () => {
    const rec = await api(`/api/run/${run.runId}/reconcile`);
    if (rec.stillBlocked) throw new Error(rec.reason ?? 'An unresolved mutation attempt remains; reconcile before continuing.');
    if (removeItemId) {
      const selections = currentSelections(run);
      delete selections[removeItemId];
      await api(`/api/run/${run.runId}/selection`, { selections });
    }
    const { plan } = await api(`/api/run/${run.runId}/plan`);
    const problems = checkRevisedPlan(plan, previous, acknowledged);
    if (problems.length) throw new Error(`Not approved: ${problems.join('; ')}. Review the plan again.`);
    if (!executableOf(plan).length) throw new Error('Nothing left to add after this change. Review the plan.');
    await api(`/api/run/${run.runId}/approve`);
    await api(`/api/run/${run.runId}/execute`);
    say(removeItemId ? 'Removed from plan · remainder reapproved and running' : 'Reapproved at the new price · run resumed');
  });
}

function reapprove() {
  resume(null);
}

function removePaused() {
  const run = snapshot?.run;
  if (!run || run.status !== 'paused') return say('Nothing is paused');
  const first = priceIncreases(run.plan, snapshot.catalog)[0];
  if (!first) return say('The pause is not a price change · reconcile and review instead');
  resume(first.itemId);
}

function handoff() {
  const run = snapshot?.run;
  if (!run || run.status !== 'completed') return say('Handoff is available once the cart is verified');
  if (!ui.armHandoff) {
    ui.armHandoff = true;
    say('Press o again to confirm · automation for this run will stop');
    render();
    return;
  }
  ui.armHandoff = false;
  act(async () => {
    await api(`/api/run/${run.runId}/handoff`);
    say('Handed off · checkout is yours');
  });
}

// ---------------------------------------------------------------- jump mode

function enterFlash() {
  const root = el.app.getBoundingClientRect();
  const visible = [...el.app.querySelectorAll('[data-flash]')]
    .map((node) => ({ node, r: node.getBoundingClientRect() }))
    .filter(({ node, r }) => {
      if (r.width <= 0 || r.height <= 0) return false;
      const box = (node.closest('[data-list]') || node.closest('.scroll') || node.closest('main'))?.getBoundingClientRect() ?? root;
      return r.top >= box.top - 2 && r.bottom <= box.bottom + 2 && r.top >= root.top && r.bottom <= root.bottom;
    });
  ui.flash = visible.slice(0, LABELS.length).map(({ node, r }, i) => ({
    label: LABELS[i],
    id: node.getAttribute('data-flash'),
    x: r.left - root.left,
    y: r.top - root.top,
    w: r.width,
    h: r.height,
  }));
  ui.pal = null;
  ui.help = false;
  render();
}

function jumpTo(id) {
  const node = el.app.querySelector(`[data-flash="${CSS.escape(id)}"]`);
  if (!node) return;
  if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') node.focus();
  else node.click();
}

// ---------------------------------------------------------------- input

document.addEventListener('click', (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const closer = t.closest('[data-close]');
  if (closer && t === closer) {
    ui.pal = null;
    ui.help = false;
    render();
    return;
  }
  const palRun = t.closest('[data-pal-run]');
  if (palRun) {
    const D = derive();
    const cmd = paletteRows(D)[Number(palRun.dataset.palRun)];
    ui.pal = null;
    render();
    cmd?.run();
    return;
  }
  const goTo = t.closest('[data-go]');
  if (goTo) return go(goTo.dataset.go);
  const item = t.closest('[data-focus-item]');
  if (item) return focusItem(item.dataset.focusItem);
  const pickBtn = t.closest('[data-pick]');
  if (pickBtn) return pick(Number(pickBtn.dataset.pick));
  const edit = t.closest('[data-edit-field]');
  if (edit) return startEdit(edit.dataset.editField);
  const action = t.closest('[data-act]')?.dataset.act;
  if (!action) return;
  switch (action) {
    case 'jump': return setTimeout(enterFlash, 0);
    case 'palette': return openPalette();
    case 'dismiss': ui.notice = null; return render();
    case 'drawer': ui.drawer = !ui.drawer; return render();
    case 'prev': return move(-1);
    case 'next': return nextDecision();
    case 'exclude': return toggleExclude();
    case 'reduce': return toggleReduction();
    case 'nosub': return toggleNoSubstitution();
    case 'approve': return approve();
    case 'interpret': return interpret();
    case 'start': return startRun();
    case 'reapprove': return reapprove();
    case 'remove': return removePaused();
    case 'reconcile': return reconcile();
    case 'handoff': return handoff();
    case 'verify-session': return void act(() => api('/api/retailer/verify'));
    case 'read-cart': return void act(() => api('/api/retailer/cart'));
    default: return undefined;
  }
});

document.addEventListener('input', (event) => {
  const t = event.target;
  if (t.id === 'list-text') {
    ui.listText = t.value;
    const lines = t.value.split('\n').filter((l) => l.trim()).length;
    const head = el.main.querySelector('.editor-head span');
    if (head) head.textContent = `${lines} line${lines === 1 ? '' : 's'}`;
    const btn = el.main.querySelector('[data-act="interpret"]');
    if (btn) btn.firstChild.textContent = `Interpret ${lines} line${lines === 1 ? '' : 's'} `;
    return;
  }
  if (t.dataset?.edit) ui.draft = t.value;
  if (t.dataset?.focusKey === 'pal') {
    ui.pal.q = t.value;
    ui.pal.idx = 0;
    renderOverlay(derive());
    const input = el.overlay.querySelector('input[data-focus-key="pal"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
});

function openPalette() {
  ui.pal = ui.pal ? null : { q: '', idx: 0 };
  ui.flash = null;
  ui.help = false;
  ui.editing = null;
  render();
}

window.addEventListener('keydown', (e) => {
  if (!snapshot) return;
  const t = e.target;
  const tag = t?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA';
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key;

  if (mod && k.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette();
  }
  if (ui.flash) {
    if (k === 'Shift') return;
    e.preventDefault();
    const hit = k !== 'Escape' && ui.flash.find((f) => f.label === k);
    ui.flash = null;
    render();
    if (hit) jumpTo(hit.id);
    return;
  }
  if (ui.pal) {
    const D = derive();
    const rows = paletteRows(D);
    const idx = Math.min(ui.pal.idx, Math.max(0, rows.length - 1));
    const down = k === 'ArrowDown' || (e.ctrlKey && k === 'n');
    const up = k === 'ArrowUp' || (e.ctrlKey && k === 'p');
    if (down || up) {
      e.preventDefault();
      ui.pal.idx = Math.max(0, Math.min(rows.length - 1, idx + (down ? 1 : -1)));
      renderOverlay(D);
      const input = el.overlay.querySelector('input[data-focus-key="pal"]');
      input?.focus();
    } else if (k === 'Enter') {
      e.preventDefault();
      const cmd = rows[idx];
      ui.pal = null;
      render();
      cmd?.run();
    } else if (k === 'Escape') {
      e.preventDefault();
      ui.pal = null;
      render();
    }
    return;
  }
  if (typing) {
    if (t.dataset?.edit) {
      if (k === 'Enter') { e.preventDefault(); finishEdit(true); }
      else if (k === 'Escape') { e.preventDefault(); finishEdit(false); }
      else if (k === 'Tab') { e.preventDefault(); tabEdit(e.shiftKey); }
    } else if (tag === 'TEXTAREA') {
      if (mod && k === 'Enter') { e.preventDefault(); interpret(); }
      else if (k === 'Escape') t.blur();
    }
    return;
  }
  if (ui.help) {
    if (k === 'Escape' || k === '?') { e.preventDefault(); ui.help = false; render(); }
    return;
  }
  if (mod || e.altKey) return;
  if (ui.g) {
    e.preventDefault();
    ui.g = false;
    const map = { l: 'list', r: 'review', x: 'run', h: 'handoff' };
    if (map[k]) go(map[k]);
    else if (k === 'g' && ui.step === 'review') {
      const first = derive().sorted[0];
      if (first) focusItem(first.item.id);
    } else render();
    return;
  }
  const h = (fn) => { e.preventDefault(); fn(); };
  if (ui.armHandoff && k !== 'o') { ui.armHandoff = false; render(); }
  if (k === ':') return h(openPalette);
  if (k === JUMP_KEY) return h(enterFlash);
  if (k === '?') return h(() => { ui.help = true; render(); });
  if (k === 'g') return h(() => { ui.g = true; render(); });
  if (k === '[') return h(() => stepBy(-1));
  if (k === ']') return h(() => stepBy(1));
  if (k === 'A' || (k === 'a' && e.shiftKey)) return h(approve);
  if (k === 'd') return h(() => { ui.drawer = !ui.drawer; render(); });
  if (k === 'Escape') return h(() => { ui.drawer = false; ui.notice = null; render(); });
  if (k === 'c' && ui.step !== 'list') return h(reconcile);
  if (ui.step === 'review' && snapshot.run) {
    const D = derive();
    if (k === 'j' || k === 'ArrowDown') return h(() => move(1));
    if (k === 'k' || k === 'ArrowUp') return h(() => move(-1));
    if (k === 'G') return h(() => { const last = D.sorted[D.sorted.length - 1]; if (last) focusItem(last.item.id); });
    if (/^[1-9]$/.test(k)) return h(() => pick(Number(k) - 1));
    if (k === 'e') return h(() => D.cur && startEdit(firstEditField(D)));
    if (k === 'q') return h(() => startEdit('quantity'));
    if (k === 'x') return h(toggleExclude);
    if (k === 'N') return h(toggleNoSubstitution);
    if (k === 'r') return h(toggleReduction);
    if (k === 'n' || k === 'Enter') return h(nextDecision);
  }
  if (ui.step === 'list' && k === 'i') return h(() => el.main.querySelector('textarea')?.focus());
  if (ui.step === 'run' && snapshot.run) {
    if (k === 'r') return h(reapprove);
    if (k === 'x') return h(removePaused);
    if (k === 'Enter') {
      if (snapshot.run.status === 'completed') return h(() => go('handoff'));
      if (snapshot.run.status === 'approved') return h(startRun);
    }
  }
  if (ui.step === 'handoff' && k === 'o') return h(handoff);
});

load();
