// Local simulated retailer: the smallest rehearsal boundary. Pure local JSON,
// no network, no account/session data. It stands in for the future Landmark
// integration so cart-change behaviour can be rehearsed safely.

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
    this.state = null;
  }

  #load() {
    if (this.state) return this.state;
    if (!fs.existsSync(this.filePath)) {
      this.state = { cart: {}, ops: {} };
      return this.state;
    }
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (cause) {
      throw new Error(`simulator state unreadable: ${cause.message}`, { cause });
    }
    parsed.cart ??= {};
    parsed.ops ??= {};
    this.state = parsed;
    return this.state;
  }

  #save() {
    const state = this.#load();
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
    this.#save();
  }

  exists() {
    return fs.existsSync(this.filePath);
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
      this.#save();
      throw new Error('simulated retailer rejected the request before applying it');
    }
    if (mode === 'timeout-not-applied') {
      state.ops[opId] = { status: 'not-applied' };
      this.#save();
      throw new SimTimeoutError('simulated timeout; mutation not applied');
    }
    if (mode === 'timeout-unknown') {
      state.ops[opId] = { status: 'unknown' };
      this.#save();
      throw new SimTimeoutError('simulated timeout; application outcome unknown');
    }

    if (to <= 0) delete state.cart[productId];
    else state.cart[productId] = to;
    state.ops[opId] = { status: 'applied' };
    this.#save();

    if (mode === 'timeout-applied') throw new SimTimeoutError('simulated timeout; mutation applied');
    return { status: 'applied' };
  }

  opStatus(opId) {
    return this.#load().ops[opId]?.status ?? 'unknown-op';
  }
}
