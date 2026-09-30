// Local simulated retailer: the smallest rehearsal boundary. Pure local JSON,
// no network, no account/session data. It stands in for the future Landmark
// integration so cart-change behaviour can be rehearsed safely.
//
// State is read from disk on every operation and never cached in memory: two
// long-lived processes/entry points may share this file, and a stale in-memory
// copy would let one overwrite the other's committed changes and evidence.

import fs from 'node:fs';
import path from 'node:path';

export class SimTimeoutError extends Error {}

export class Simulator {
  /**
   * @param {string} filePath local JSON state file
   * @param {{faults?: Record<string,string>}} options faults keyed by productId:
   *   'fail-before' | 'timeout-not-applied' | 'timeout-unknown' | 'timeout-applied'
   */
  constructor(filePath, { faults = {} } = {}) {
    this.filePath = filePath;
    this.faults = faults;
  }

  #load() {
    if (!fs.existsSync(this.filePath)) return { cart: {}, ops: {} };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (cause) {
      throw new Error(`simulator state unreadable: ${cause.message}`, { cause });
    }
    parsed.cart ??= {};
    parsed.ops ??= {};
    return parsed;
  }

  #save(state) {
    const tmp = `${this.filePath}.tmp`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(state, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }

  seedCart(cart) {
    const state = this.#load();
    state.cart = { ...cart };
    this.#save(state);
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  /** True when any operation has ever been recorded (durable evidence exists). */
  hasOperations() {
    return Object.keys(this.#load().ops).length > 0;
  }

  cart() {
    return { ...this.#load().cart };
  }

  /**
   * Apply a mutation. `opId` acts as an idempotency key: a repeated dispatch
   * of the same opId never applies twice.
   */
  dispatch({ opId, productId, to }) {
    const state = this.#load();
    const existing = state.ops[opId];
    if (existing) return { status: existing.status, deduplicated: true };

    const mode = this.faults[productId] ?? 'ok';

    if (mode === 'fail-before') {
      state.ops[opId] = { status: 'not-applied' };
      this.#save(state);
      throw new Error('simulated retailer rejected the request before applying it');
    }
    if (mode === 'timeout-not-applied') {
      state.ops[opId] = { status: 'not-applied' };
      this.#save(state);
      throw new SimTimeoutError('simulated timeout; mutation not applied');
    }
    if (mode === 'timeout-unknown') {
      state.ops[opId] = { status: 'unknown' };
      this.#save(state);
      throw new SimTimeoutError('simulated timeout; application outcome unknown');
    }

    if (to <= 0) delete state.cart[productId];
    else state.cart[productId] = to;
    state.ops[opId] = { status: 'applied' };
    this.#save(state);

    if (mode === 'timeout-applied') throw new SimTimeoutError('simulated timeout; mutation applied');
    return { status: 'applied' };
  }

  opStatus(opId) {
    return this.#load().ops[opId]?.status ?? 'unknown-op';
  }
}
