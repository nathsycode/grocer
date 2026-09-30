// Durable, append-only safety journal and cross-process execution lock.
//
// The journal is the assistant's own record: requests, reviewed choices,
// approvals, mutation intent/outcome, observations, and ownership. It never
// stores retailer sign-in state. Missing or unreadable state must fail closed.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class JournalError extends Error {}
export class LockError extends Error {}

export class Journal {
  constructor(filePath) {
    this.filePath = filePath;
  }

  exists() {
    return fs.existsSync(this.filePath);
  }

  /** Durably append one record. Throws JournalError on any storage failure. */
  append(type, fields = {}) {
    const record = {
      recordId: crypto.randomUUID(),
      ts: new Date().toISOString(),
      type,
      ...fields,
    };
    const line = `${JSON.stringify(record)}\n`;
    let fd;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fd = fs.openSync(this.filePath, 'a');
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (cause) {
      throw new JournalError(`journal append failed for ${type}: ${cause.message}`, { cause });
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
    return record;
  }

  /** Read all records. Throws JournalError if the file exists but is unreadable. */
  readAll() {
    if (!fs.existsSync(this.filePath)) return [];
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      throw new JournalError(`journal unreadable: ${cause.message}`, { cause });
    }
    const records = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (cause) {
        throw new JournalError(`journal unreadable at line ${i + 1}`, { cause });
      }
    }
    return records;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Exclusive lock file granting one cart-changing run execution ownership. */
export class ExecutionLock {
  constructor(filePath) {
    this.filePath = filePath;
  }

  held() {
    return fs.existsSync(this.filePath);
  }

  holder() {
    if (!this.held()) return null;
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch {
      return { unreadable: true };
    }
  }

  acquire(meta = {}) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'wx');
      fs.writeSync(fd, JSON.stringify({ ...meta, pid: process.pid, ts: new Date().toISOString() }));
      fs.fsyncSync(fd);
    } catch (cause) {
      if (cause.code === 'EEXIST') throw new LockError('another cart-changing run already owns execution');
      throw cause;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
      }
    }
  }

  release() {
    try {
      fs.unlinkSync(this.filePath);
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
  }
}
