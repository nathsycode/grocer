// Orchestration: turns journal records into inspectable run state and owns the
// one cart-changing execution. The store never touches a retailer; it talks
// only to the local simulator.

import path from 'node:path';
import crypto from 'node:crypto';
import { CATALOG, productById, formatMoney, parseSize, sizeEquals } from './catalog.js';
import {
  interpretRequest,
  discoverCandidates,
  computePlan,
  executableActions,
  revalidateApproval,
  verifyCart,
  norm,
} from './domain.js';
import { Journal, JournalError, ExecutionLock, isProcessAlive } from './journal.js';
import { Simulator, SimTimeoutError } from './simulator.js';
import { createProposer, controlledProposer, ProposerError, validateProposal, validateRankings } from './proposer.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const SIM_CONTEXT = {
  contextId: 'sim-branch-001',
  account: 'SIMULATED ACCOUNT (not a real Landmark account)',
  branch: 'SIMULATED BRANCH 001 (not a real Landmark branch)',
};

function openAttemptsOf(attempts) {
  return Object.values(attempts).filter((a) => {
    if (a.resolution) return false;
    if (!a.outcome) return true;
    return a.outcome.status === 'unknown';
  });
}

/** ADR-0002: green choices may be preselected; yellow/orange start unselected. */
function defaultSelections(items, candidates) {
  const selections = {};
  for (const item of items) {
    const green = (candidates[item.id] ?? []).find((c) => c.color === 'green' && c.selectable);
    if (green) selections[item.id] = { productId: green.product.id };
  }
  return selections;
}

/** Fold journal records into inspectable state. */
export function reduce(records) {
  const runs = {};
  const runOrder = [];
  const attempts = {};
  const ownership = { held: false, runId: null, since: null };
  let currentRunId = null;

  for (const r of records) {
    const run = r.runId ? runs[r.runId] : null;
    switch (r.type) {
      case 'run_created':
        runs[r.runId] = {
          runId: r.runId,
          requestText: r.requestText,
          revision: r.revision ?? 1,
          items: r.items ?? [],
          candidates: r.candidates ?? {},
          selections: r.selections ?? {},
          interpretation: r.interpretation ?? null,
          plan: null,
          approval: null,
          approvalValid: false,
          inFlight: false,
          status: 'review',
          pauseReason: null,
          verification: null,
          cartObservation: null,
          createdAt: r.ts,
          approvalConsumed: false,
        };
        runOrder.push(r.runId);
        currentRunId = r.runId;
        break;
      case 'request_corrected':
        if (run) {
          run.revision = r.revision;
          run.items = r.items;
          run.candidates = r.candidates;
          run.selections = r.selections ?? {};
          run.approval = null;
          run.plan = null;
          run.status = 'review';
        }
        break;
      case 'selection_changed':
        if (run) {
          run.selections = r.selections;
          run.approval = null;
          run.plan = null;
          run.status = 'review';
        }
        break;
      case 'plan_reviewed':
        if (run) run.plan = r.plan;
        break;
      case 'plan_approved':
        if (run) {
          run.approval = r.approval;
          run.approvalValid = true;
          run.status = 'approved';
        }
        break;
      case 'approval_invalidated':
        if (run) {
          run.approval = null;
          run.approvalValid = false;
          if (run.status === 'approved') run.status = 'review';
        }
        break;
      case 'ownership_acquired':
        ownership.held = true;
        ownership.runId = r.runId;
        ownership.since = r.ts;
        break;
      case 'ownership_released':
        ownership.held = false;
        ownership.runId = null;
        ownership.since = r.ts;
        break;
      case 'execution_started':
        if (run) {
          run.status = 'executing';
          run.inFlight = true;
        }
        break;
      case 'mutation_intent':
        attempts[r.opId] = {
          opId: r.opId,
          runId: r.runId,
          itemId: r.itemId,
          productId: r.productId,
          from: r.from,
          to: r.to,
          kind: r.kind,
          priceMinor: r.priceMinor,
          intentAt: r.ts,
          outcome: null,
          resolution: null,
        };
        break;
      case 'mutation_outcome':
        if (attempts[r.opId]) {
          attempts[r.opId].outcome = { status: r.status, detail: r.detail ?? null, at: r.ts };
        }
        break;
      case 'attempt_resolved':
        if (attempts[r.opId]) {
          attempts[r.opId].resolution = { resolution: r.resolution, evidence: r.evidence, at: r.ts };
        }
        break;
      case 'cart_observed':
        if (run) run.cartObservation = { cart: r.cart, contextId: r.contextId, phase: r.phase, at: r.ts };
        break;
      case 'verification':
        if (run) run.verification = r.result;
        break;
      case 'execution_paused':
        if (run) {
          run.status = 'paused';
          run.pauseReason = r.reason;
          // A paused run cannot silently reuse its earlier approval.
          run.approvalValid = false;
          run.inFlight = false;
        }
        break;
      case 'execution_completed':
        if (run) {
          run.status = 'completed';
          run.approvalConsumed = true;
          run.inFlight = false;
        }
        break;
      default:
        break;
    }
  }

  return { runs, runOrder, attempts, ownership, currentRunId, openAttempts: openAttemptsOf(attempts) };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createStore({
  dataDir = path.resolve('.local'),
  catalog = CATALOG,
  context = SIM_CONTEXT,
  stepDelayMs = 0,
  faults = {},
  proposer,
} = {}) {
  return new Store({ dataDir, catalog, context, stepDelayMs, faults, proposer });
}

export class Store {
  constructor({ dataDir, catalog, context, stepDelayMs, faults, proposer }) {
    this.dataDir = dataDir;
    this.catalog = catalog;
    this.context = context;
    this.stepDelayMs = stepDelayMs;
    this.proposer = proposer ?? createProposer();
    this.journal = new Journal(path.join(dataDir, 'journal.jsonl'));
    this.lock = new ExecutionLock(path.join(dataDir, 'execution.lock'));
    this.simulator = new Simulator(path.join(dataDir, 'simulator.json'), { faults });
    this.state = reduce([]);
    this.fatal = null;
    this.retailerFatal = null;
    this.executing = false;
    this.executingRunId = null;
  }

  load() {
    this.retailerFatal = null;
    this.refresh();
    // A missing journal is only a fresh start when no prior state exists.
    // A leftover lock or recorded simulator operations mean history is
    // expected: fail closed rather than treating deletion as a clean slate.
    if (!this.fatal && !this.journal.exists()) {
      let priorState = this.lock.held();
      if (!priorState) {
        try {
          priorState = this.simulator.hasOperations();
        } catch (err) {
          this.retailerFatal = { reason: err.message };
        }
      }
      if (priorState) {
        this.fatal = { reason: 'the safety journal is missing while prior state exists; failing closed' };
      }
    }
    if (!this.retailerFatal) {
      try {
        this.simulator.cart();
      } catch (err) {
        // Cannot read the simulated retailer state: treat as fail-closed.
        this.retailerFatal = { reason: err.message };
      }
    }
    if (!this.fatal && !this.retailerFatal) this.invalidateForeignApproval();
    this.settleStaleLock();
    return this.snapshot();
  }

  /**
   * A backend restart must not carry an old approval into a new process
   * (ADR-0008). If ownership survives from a process other than this one, the
   * owning run's approval is invalidated once.
   */
  invalidateForeignApproval() {
    if (!this.state.ownership.held) return;
    const ownerRunId = this.state.ownership.runId;
    const run = ownerRunId ? this.state.runs[ownerRunId] : null;
    if (!run?.approval || !run.approvalValid) return;
    const holder = this.lock.holder();
    if (holder && holder.pid === process.pid) return;
    try {
      this.#append('approval_invalidated', {
        runId: ownerRunId,
        reason: 'backend restarted while execution ownership was held; fresh approval required',
      });
      this.refresh();
    } catch {
      /* storage failing; the run remains blocked by its ownership record */
    }
  }

  refresh() {
    try {
      // ponytail: re-reads the whole journal on every mutation. Fine at demo
      // scale; move to an indexed store if the journal grows large.
      this.state = reduce(this.journal.readAll());
      this.fatal = null;
    } catch (err) {
      if (err instanceof JournalError) this.fatal = { reason: err.message };
      else throw err;
    }
  }

  /** A lock held by a dead process is only cleared when nothing is unresolved. */
  settleStaleLock() {
    if (this.fatal || this.retailerFatal || !this.lock.held()) return;
    const holder = this.lock.holder();
    if (!holder || holder.unreadable) return;
    if (holder.pid === process.pid) return;
    if (isProcessAlive(holder.pid)) return;
    if (!this.state.ownership.held && this.state.openAttempts.length === 0) {
      try {
        this.lock.release();
      } catch {
        /* best effort */
      }
    }
  }

  currentRun() {
    return this.state.currentRunId ? this.state.runs[this.state.currentRunId] : null;
  }

  cartLines() {
    const cart = this.simulator.cart();
    return Object.entries(cart)
      .filter(([, qty]) => qty > 0)
      .map(([productId, quantity]) => {
        const prod = productById(productId, this.catalog);
        return {
          productId,
          quantity,
          label: prod ? `${prod.brand} ${prod.name} ${prod.size.display}` : productId,
          classified: prod ? undefined : 'unknown synthetic product id',
        };
      });
  }

  blockState() {
    if (this.fatal) return { kind: 'fatal', reason: this.fatal.reason };
    if (this.retailerFatal) {
      return { kind: 'fatal', reason: `simulated retailer state unreadable: ${this.retailerFatal.reason}` };
    }
    if (this.state.openAttempts.length > 0) {
      return {
        kind: 'uncertain',
        reason:
          'An unresolved mutation attempt keeps execution blocked. Reconcile against the simulator to resolve it safely.',
      };
    }
    if (this.state.ownership.held && !this.executing) {
      return {
        kind: 'ownership',
        reason:
          'A paused or interrupted run retains execution ownership. Reconcile (read-only) to release it before a new execution.',
      };
    }
    return null;
  }

  snapshot() {
    const run = this.currentRun();
    return {
      simulation: {
        label: 'SIMULATION — synthetic catalogue and simulated cart. This build cannot reach Landmark.',
        context: this.context,
        stepDelayMs: this.stepDelayMs,
      },
      model: {
        provider: this.proposer?.provider ?? 'none',
        configured: Boolean(this.proposer?.configured),
      },
      blocked: this.blockState(),
      ownership: {
        held: this.state.ownership.held,
        runId: this.state.ownership.runId,
        holder: this.lock.holder(),
        executing: this.executing,
      },
      catalog: this.catalog.map((p) => ({
        id: p.id,
        brand: p.brand,
        name: p.name,
        variant: p.variant,
        sizeDisplay: p.size.display,
        priceDisplay: formatMoney(p.priceMinor, p.currency),
        evidenceConflict: Boolean(p.evidenceConflict),
      })),
      run,
      runs: this.state.runOrder.map((id) => ({
        runId: id,
        status: this.state.runs[id].status,
        requestText: this.state.runs[id].requestText,
      })),
      cart: this.retailerFatal ? [] : this.cartLines(),
      openAttempts: this.state.openAttempts,
      attempts: Object.values(this.state.attempts),
      journalTail: this.safeJournalTail(40),
    };
  }

  safeJournalTail(limit) {
    try {
      const all = this.journal.readAll();
      return all.slice(-limit).map(({ recordId, ts, type, runId, opId, ...rest }) => ({
        recordId,
        ts,
        type,
        runId: runId ?? null,
        opId: opId ?? null,
        detail: summarizeRecord(type, rest),
      }));
    } catch {
      return [];
    }
  }

  #append(type, fields) {
    try {
      return this.journal.append(type, fields);
    } catch (err) {
      if (err instanceof JournalError) throw new StoreError('storage', err.message);
      throw err;
    }
  }

  requireRun(runId) {
    const run = runId ? this.state.runs[runId] : this.currentRun();
    if (!run) throw new StoreError('not-found', 'no matching shopping run');
    return run;
  }

  assertPlanningAllowed() {
    if (this.fatal) throw new StoreError('blocked', this.fatal.reason);
    if (this.retailerFatal) throw new StoreError('blocked', this.blockState().reason);
    if (this.state.openAttempts.length > 0) throw new StoreError('blocked', this.blockState().reason);
    if (this.state.ownership.held && !this.executing) throw new StoreError('blocked', this.blockState().reason);
    if (this.executing) throw new StoreError('owned', 'a cart-changing run is executing');
  }

  createRun(requestText, interpretation = null) {
    if (this.fatal) throw new StoreError('blocked', this.fatal.reason);
    if (this.retailerFatal) throw new StoreError('blocked', this.blockState().reason);
    if (typeof requestText !== 'string' || !requestText.trim()) {
      throw new StoreError('invalid', 'request text is required');
    }
    const runId = crypto.randomUUID();
    const items = interpretation?.items ?? interpretRequest(requestText, this.catalog);
    const candidates =
      interpretation?.candidates ??
      Object.fromEntries(items.map((i) => [i.id, discoverCandidates(i, this.catalog)]));
    this.#append('run_created', {
      runId,
      requestText,
      revision: 1,
      items,
      candidates,
      selections: defaultSelections(items, candidates),
      interpretation: interpretation?.meta ?? null,
    });
    this.refresh();
    return this.requireRun(runId);
  }

  /**
   * The evidence-backed entry point: one bounded proposal, application-
   * controlled discovery, and independent validation before a run exists. When
   * no model is configured the offline interpreter stands in and the run is
   * labelled a fallback. Model failure creates no run (ADR-0007).
   */
  async planRun(requestText) {
    this.assertPlanningAllowed();
    if (typeof requestText !== 'string' || !requestText.trim()) {
      throw new StoreError('invalid', 'request text is required');
    }
    const configured = Boolean(this.proposer?.configured);
    const proposer = configured ? this.proposer : controlledProposer();

    let rawInterpretation;
    try {
      rawInterpretation = await proposer.interpret({ requestText });
    } catch (err) {
      if (err instanceof ProposerError) throw new StoreError('model-failed', `model interpretation failed: ${err.message}`);
      throw err;
    }
    // The store validates independently, whatever the provider returned.
    const interpretation = validateProposal(rawInterpretation, { requestText });
    if (!interpretation.ok) {
      throw new StoreError('model-failed', 'model output was unusable; no run was created');
    }

    const items = interpretation.items;
    const baseCandidates = Object.fromEntries(items.map((i) => [i.id, discoverCandidates(i, this.catalog)]));
    const candidatesByLine = Object.fromEntries(items.map((i) => [i.lineIndex, baseCandidates[i.id]]));

    let rawRanked = { rankings: [] };
    try {
      rawRanked = await proposer.rank({ requestText, items, candidatesByLine });
    } catch (err) {
      if (err instanceof ProposerError) throw new StoreError('model-failed', `model ranking failed: ${err.message}`);
      throw err;
    }
    const rankingProblems = [];
    const rankings = validateRankings(rawRanked?.rankings, {
      candidatesByLine,
      lineCount: items.length,
      problems: rankingProblems,
    });

    const rankingsByItem = {};
    for (const ranking of rankings) {
      const item = items.find((i) => i.lineIndex === ranking.lineIndex);
      if (!item) continue;
      (rankingsByItem[item.id] ??= {})[ranking.productId] = { rank: ranking.rank, rationale: ranking.rationale };
    }
    const candidates = Object.fromEntries(
      items.map((i) => [i.id, discoverCandidates(i, this.catalog, rankingsByItem[i.id] ?? {})]),
    );

    return this.createRun(requestText, {
      items,
      candidates,
      meta: {
        provider: proposer.provider,
        fallback: !configured,
        problems: [...(interpretation.problems ?? []), ...rankingProblems],
      },
    });
  }

  correctRequest(runId, items) {
    this.assertPlanningAllowed();
    const run = this.requireRun(runId);
    if (!Array.isArray(items) || items.length === 0) throw new StoreError('invalid', 'items are required');
    const normalized = items.map((raw, index) => {
      const previous = run.items.find((i) => i.id === raw?.id) ?? run.items[index] ?? null;
      return normalizeCorrection(raw, this.catalog, previous);
    });
    const candidates = Object.fromEntries(normalized.map((i) => [i.id, discoverCandidates(i, this.catalog)]));
    const revision = run.revision + 1;
    if (run.approval) this.#append('approval_invalidated', { runId, reason: 'request corrected after approval' });
    this.#append('request_corrected', {
      runId,
      revision,
      items: normalized,
      candidates,
      selections: defaultSelections(normalized, candidates),
    });
    this.refresh();
    return this.requireRun(runId);
  }

  setSelections(runId, selections) {
    this.assertPlanningAllowed();
    const run = this.requireRun(runId);
    for (const [itemId, selection] of Object.entries(selections ?? {})) {
      if (!selection?.productId) continue;
      const candidates = run.candidates[itemId] ?? [];
      const match = candidates.find((c) => c.product.id === selection.productId);
      if (!match) throw new StoreError('invalid-selection', `${selection.productId} is not a discovered candidate for ${itemId}`);
      if (!match.selectable) throw new StoreError('invalid-selection', `${selection.productId} is not selectable for ${itemId}`);
    }
    if (run.approval) this.#append('approval_invalidated', { runId, reason: 'selection changed after approval' });
    this.#append('selection_changed', { runId, selections: selections ?? {} });
    this.refresh();
    return this.requireRun(runId);
  }

  reviewPlan(runId) {
    this.assertPlanningAllowed();
    const run = this.requireRun(runId);
    // Re-reviewing after an approval means the reviewed inputs are being
    // reconsidered; the old approval must not silently carry over.
    if (run.approval) this.#append('approval_invalidated', { runId, reason: 'plan reviewed again after approval' });
    const plan = computePlan(run.items, run.selections, this.simulator.cart(), this.context.contextId, run.revision, this.catalog);
    this.#append('plan_reviewed', { runId, plan });
    this.refresh();
    return this.requireRun(runId).plan;
  }

  approvePlan(runId) {
    this.assertPlanningAllowed();
    const run = this.requireRun(runId);
    const reviewed = run.plan;
    if (!reviewed || reviewed.revision !== run.revision) {
      throw new StoreError('stale-review', 'review the plan before approving it');
    }
    // Approval must bind to the plan the operator actually reviewed. Recompute
    // only to detect that the observed inputs have moved on; never approve the
    // replacement plan that recomputation would produce.
    const current = computePlan(
      run.items,
      run.selections,
      this.simulator.cart(),
      this.context.contextId,
      run.revision,
      this.catalog,
    );
    if (planFingerprint(reviewed) !== planFingerprint(current)) {
      const reason = 'the reviewed plan no longer matches the observed cart, prices, or selections';
      this.#append('approval_invalidated', { runId, reason });
      this.refresh();
      throw new StoreError('stale-review', `${reason}; review the plan again before approving`);
    }
    const actions = executableActions(reviewed).map((a) => ({
      itemId: a.itemId,
      productId: a.productId,
      product: a.product,
      kind: a.kind,
      units: a.units,
      from: a.from,
      to: a.to,
      priceMinor: a.priceMinor,
      priceDisplay: a.priceDisplay,
    }));
    const approval = {
      approvalId: crypto.randomUUID(),
      runId,
      revision: run.revision,
      contextId: this.context.contextId,
      actions,
      approvedAt: new Date().toISOString(),
    };
    this.#append('plan_approved', { runId, approval });
    this.refresh();
    return this.requireRun(runId).approval;
  }

  startExecution(runId) {
    if (this.fatal) throw new StoreError('blocked', this.fatal.reason);
    if (this.retailerFatal) throw new StoreError('blocked', this.blockState().reason);
    const run = this.requireRun(runId);
    if (this.state.openAttempts.length > 0) throw new StoreError('blocked', this.blockState().reason);
    if (this.executing) throw new StoreError('owned', 'this run is already executing');
    if (run.inFlight) {
      throw new StoreError('blocked', 'this run was interrupted before it finished; reconcile and start a fresh run');
    }
    if (this.state.ownership.held) {
      throw new StoreError('owned', 'execution ownership is held; reconcile to release it before executing');
    }
    if (!run.approval) throw new StoreError('no-approval', 'the plan must be explicitly approved before execution');
    if (run.approvalConsumed) throw new StoreError('already-executed', 'this approval has already been executed');
    if (!run.approvalValid) {
      throw new StoreError('invalid-approval', 'the run paused; re-approve the revised plan before executing');
    }

    const cart = this.simulator.cart();
    const check = revalidateApproval(run.approval, {
      revision: run.revision,
      contextId: this.context.contextId,
      cart,
      catalog: this.catalog,
    });
    if (!check.ok) {
      this.#append('approval_invalidated', { runId, reason: check.problems.join('; ') });
      this.refresh();
      throw new StoreError('invalid-approval', `reevaluation required: ${check.problems.join('; ')}`);
    }

    // Always acquire a fresh lock: a lock left by another process/entry point is
    // never silently reused to continue that owner's run.
    try {
      this.lock.acquire({ runId });
    } catch {
      throw new StoreError('owned', 'another process already owns cart-changing execution');
    }
    try {
      this.#append('ownership_acquired', { runId, ownerPid: process.pid });
    } catch (err) {
      try {
        this.lock.release();
      } catch {
        /* best effort */
      }
      throw err;
    }

    this.executing = true;
    this.executingRunId = runId;
    // Backend-owned: execution is not tied to the review tab's connection.
    this.execute(runId)
      .catch((err) => {
        this.pauseQuietly(runId, `execution error: ${err.message}`);
      })
      .finally(() => {
        this.executing = false;
        this.executingRunId = null;
        this.refresh();
      });
    return { started: true, runId };
  }

  async execute(runId) {
    const run = this.requireRun(runId);
    const approval = run.approval;
    this.#append('execution_started', { runId });

    for (const action of approval.actions) {
      const cart = this.simulator.cart();
      const currentFrom = cart[action.productId] ?? 0;
      const prod = productById(action.productId, this.catalog);
      if (currentFrom !== action.from) {
        this.pauseQuietly(
          runId,
          `${action.product.name}: cart changed since approval (was ${action.from}, now ${currentFrom}); reevaluation required`,
        );
        return;
      }
      if (prod && prod.priceMinor > action.priceMinor) {
        this.pauseQuietly(
          runId,
          `${action.product.name}: unit price rose to ${formatMoney(prod.priceMinor, prod.currency)}; renewed approval required`,
        );
        return;
      }

      const opId = crypto.randomUUID();
      try {
        this.#append('mutation_intent', {
          runId,
          opId,
          itemId: action.itemId,
          productId: action.productId,
          kind: action.kind,
          from: action.from,
          to: action.to,
          priceMinor: action.priceMinor,
        });
      } catch {
        // Intent must be durable before dispatch (ADR-0008).
        this.pauseQuietly(runId, 'storage failed before dispatch; no mutation was sent');
        return;
      }

      let outcome;
      try {
        this.simulator.dispatch({ opId, productId: action.productId, to: action.to });
        outcome = { status: 'applied', detail: null };
      } catch (err) {
        outcome = err instanceof SimTimeoutError
          ? { status: 'unknown', detail: 'simulated timeout; outcome unresolved' }
          : { status: 'failed', detail: err.message };
      }

      try {
        this.#append('mutation_outcome', { runId, opId, status: outcome.status, detail: outcome.detail });
      } catch {
        // Dispatched but unrecorded: leave an unresolved attempt, dispatch nothing more.
        this.pauseQuietly(runId, 'failed to record a dispatched result; attempt left unresolved');
        return;
      }

      if (outcome.status !== 'applied') {
        this.pauseQuietly(runId, `mutation outcome ${outcome.status}: ${outcome.detail ?? 'no detail'}; execution paused`);
        return;
      }

      if (this.stepDelayMs > 0) await delay(this.stepDelayMs);
    }

    const cart = this.simulator.cart();
    this.#append('cart_observed', { runId, cart, contextId: this.context.contextId, phase: 'post-execution' });
    const verification = verifyCart(run.plan, cart, this.catalog);
    this.#append('verification', { runId, result: verification });
    this.#append('execution_completed', { runId });
    this.#append('ownership_released', { runId, reason: 'run completed' });
    try {
      this.lock.release();
    } catch {
      /* stale lock will be settled at next load */
    }
  }

  pauseQuietly(runId, reason) {
    try {
      this.#append('approval_invalidated', { runId, reason: `execution paused: ${reason}` });
      this.#append('execution_paused', { runId, reason });
    } catch {
      /* storage failing; open attempt remains visible */
    }
  }

  /**
   * Read-only reconciliation. Records a fresh cart observation and resolves
   * unresolved attempts using the simulator's own operation status. Never
   * mutates the cart, never force-unlocks, never deletes history.
   */
  reconcile(runId) {
    if (this.fatal) throw new StoreError('blocked', this.fatal.reason);
    if (this.retailerFatal) throw new StoreError('blocked', this.blockState().reason);
    if (this.executing) throw new StoreError('owned', 'cannot reconcile while this process is executing a run');
    const run = this.requireRun(runId);

    // Never release a lock that another live process still owns: it may be
    // between actions, with no unresolved attempt recorded yet.
    const holder = this.lock.holder();
    if (holder && Number.isInteger(holder.pid) && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
      return {
        reconciled: true,
        stillBlocked: true,
        reason: 'another process currently owns cart-changing execution; not releasing it',
        snapshot: this.snapshot(),
      };
    }

    const cart = this.simulator.cart();
    this.#append('cart_observed', { runId, cart, contextId: this.context.contextId, phase: 'reconciliation' });

    for (const attempt of this.state.openAttempts) {
      const status = this.simulator.opStatus(attempt.opId);
      if (status === 'applied' || status === 'not-applied') {
        this.#append('attempt_resolved', {
          runId: attempt.runId,
          opId: attempt.opId,
          resolution: status,
          evidence: `simulator operation status: ${status}`,
        });
      }
    }

    this.refresh();
    const stillOpen = this.state.openAttempts.length > 0;
    if (!stillOpen && this.state.ownership.held) {
      this.#append('ownership_released', { runId, reason: 'all mutation attempts safely accounted for' });
      try {
        this.lock.release();
      } catch {
        /* best effort */
      }
      this.refresh();
    }
    return { reconciled: true, stillBlocked: stillOpen, snapshot: this.snapshot() };
  }
}

function summarizeRecord(type, rest) {
  switch (type) {
    case 'run_created':
    case 'request_corrected':
      return { items: rest.items?.map((i) => i.raw) };
    case 'selection_changed':
      return { selections: rest.selections };
    case 'plan_reviewed':
      return { actions: rest.plan?.actions?.map((a) => `${a.kind} ${a.units} ${a.product.name}`) };
    case 'plan_approved':
      return { approvalId: rest.approval?.approvalId, actions: rest.approval?.actions?.length };
    case 'approval_invalidated':
    case 'execution_paused':
      return { reason: rest.reason };
    case 'mutation_intent':
      return { productId: rest.productId, kind: rest.kind, from: rest.from, to: rest.to };
    case 'mutation_outcome':
      return { status: rest.status, detail: rest.detail };
    case 'attempt_resolved':
      return { resolution: rest.resolution, evidence: rest.evidence };
    case 'cart_observed':
      return { phase: rest.phase, cart: rest.cart };
    case 'verification':
      return {
        fulfilled: rest.result?.fulfilled?.length,
        discrepancies: rest.result?.discrepancies?.length,
        extras: rest.result?.extras?.length,
      };
    case 'ownership_acquired':
      return { ownerPid: rest.ownerPid };
    case 'ownership_released':
      return { reason: rest.reason };
    default:
      return {};
  }
}

function normalizeCorrection(raw, catalog, previous = null) {
  if (!raw || typeof raw !== 'object') throw new StoreError('invalid', 'each item must be an object');
  const prod = raw.productId ? productById(raw.productId, catalog) : null;

  const quantityText = String(raw.quantity ?? '').trim();
  if (!/^\d+$/.test(quantityText) || Number(quantityText) < 1) {
    throw new StoreError('invalid', `target quantity must be a positive whole number (received ${JSON.stringify(raw.quantity)})`);
  }

  let size;
  if (raw.sizeText !== undefined) {
    const text = String(raw.sizeText).trim();
    if (text === '') {
      size = null;
    } else {
      size = parseSize(text);
      if (!size || size.value <= 0) {
        throw new StoreError('invalid', `size ${JSON.stringify(raw.sizeText)} is not a recognised size (for example 500 g, 1 kg, 500 ml)`);
      }
    }
  } else if (raw.size != null) {
    size = raw.size;
  } else {
    size = null;
  }

  const name = String(raw.name ?? '').trim();
  if (!name) throw new StoreError('invalid', 'item name is required');

  const item = {
    id: raw.id ?? `item-${crypto.randomUUID().slice(0, 8)}`,
    raw: raw.raw ?? '',
    name,
    brand: optionalText(raw.brand),
    variant: optionalText(raw.variant),
    size,
    quantity: Number.parseInt(quantityText, 10),
    restrictions: { noSubstitution: Boolean(raw.restrictions?.noSubstitution ?? raw.noSubstitution) },
  };

  // A correction is user-authored: a changed constraint becomes explicit and
  // drops any stale model metadata. An unchanged item keeps its interpretation
  // provenance (assumptions, unresolved facts, inferred attributes) so editing
  // one line cannot silently strip the qualification from another.
  if (previous && sameConstraints(previous, item)) {
    return {
      ...item,
      lineIndex: previous.lineIndex,
      assumptions: previous.assumptions ?? [],
      unresolved: previous.unresolved ?? [],
      inferred: previous.inferred ?? {},
      queries: previous.queries ?? [],
    };
  }
  return { ...item, lineIndex: previous?.lineIndex, inferred: {}, assumptions: [], unresolved: [] };
}

function sameConstraints(a, b) {
  return (
    norm(a.name) === norm(b.name) &&
    norm(a.brand) === norm(b.brand) &&
    norm(a.variant) === norm(b.variant) &&
    sizeEquals(a.size, b.size) &&
    a.quantity === b.quantity &&
    Boolean(a.restrictions?.noSubstitution) === Boolean(b.restrictions?.noSubstitution)
  );
}

function optionalText(value) {
  const text = String(value ?? '').trim();
  return text ? text : null;
}

/** Stable fingerprint of the plan inputs an operator reviews, excluding timestamps. */
function planFingerprint(plan) {
  const actions = plan.actions
    .map((a) => `${a.itemId}|${a.productId}|${a.kind}|${a.from}|${a.to}|${a.priceMinor}|${a.executable}`)
    .sort();
  const unfulfilled = plan.unfulfilled.map((u) => u.itemId).sort();
  return JSON.stringify({ revision: plan.revision, contextId: plan.contextId, actions, unfulfilled });
}
