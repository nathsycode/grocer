import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Journal, JournalError, ExecutionLock, LockError, isProcessAlive } from '../src/journal.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grocer-journal-'));

test('journal appends and reads records in order', () => {
  const file = path.join(tmpDir(), 'journal.jsonl');
  const journal = new Journal(file);
  journal.append('run_created', { runId: 'r1', requestText: 'milk' });
  journal.append('plan_approved', { runId: 'r1', approval: { approvalId: 'a1' } });
  const records = journal.readAll();
  assert.equal(records.length, 2);
  assert.equal(records[0].type, 'run_created');
  assert.equal(records[1].approval.approvalId, 'a1');
  assert.ok(records[0].recordId && records[0].ts);
});

test('a missing journal reads as empty, but a corrupt one fails closed', () => {
  const dir = tmpDir();
  const journal = new Journal(path.join(dir, 'journal.jsonl'));
  assert.deepEqual(journal.readAll(), []);

  fs.writeFileSync(path.join(dir, 'journal.jsonl'), '{not json}\n');
  assert.throws(() => journal.readAll(), JournalError);
});

test('the execution lock is exclusive and releasable', () => {
  const file = path.join(tmpDir(), 'execution.lock');
  const a = new ExecutionLock(file);
  const b = new ExecutionLock(file);
  a.acquire({ runId: 'r1' });
  assert.equal(a.held(), true);
  assert.throws(() => b.acquire({ runId: 'r2' }), LockError);
  a.release();
  assert.equal(a.held(), false);
  b.acquire({ runId: 'r2' });
  b.release();
});

test('the execution lock excludes another process', () => {
  const file = path.join(tmpDir(), 'execution.lock');
  const lock = new ExecutionLock(file);
  lock.acquire({ runId: 'parent' });

  const moduleUrl = pathToFileURL(path.resolve('src/journal.js')).href;
  const script = `
    import { ExecutionLock } from ${JSON.stringify(moduleUrl)};
    const lock = new ExecutionLock(${JSON.stringify(file)});
    try { lock.acquire({ runId: 'child' }); console.log('ACQUIRED'); }
    catch { console.log('BLOCKED'); process.exit(3); }
  `;
  let blocked = false;
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  } catch (err) {
    blocked = err.status === 3;
  }
  assert.equal(blocked, true, 'a second process must not acquire the held lock');
  lock.release();
});

test('isProcessAlive detects this process and rejects an unused pid', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(2_147_483_646), false);
});
