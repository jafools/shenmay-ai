/**
 * SHENMAY AI — License Service Unit Tests (instance identity / T9)
 *
 * Pure-JS unit tests — no real DB, no server, no network. The DB is a tiny
 * in-memory fake injected via require.cache, so these run in ~50ms.
 *
 * Covers the T9 binding-logic change (audit M4): licenseService.getInstanceId()
 * must produce a STABLE id so the license master doesn't hard-lock a customer on
 * a restart or domain change. Specifically:
 *   - SHENMAY_INSTANCE_ID env pin wins and never touches the DB
 *   - otherwise the persisted random id (instance_identity, migration 045) is
 *     read via get-or-create and reused
 *   - the result is cached (one DB round-trip per process)
 *   - a DB failure degrades to a restart-stable key-derived id, never throws
 *
 * Run:  node tests/license.test.js
 */

'use strict';

const crypto = require('crypto');

const DB_PATH  = require.resolve('../server/src/db');
const SVC_PATH = require.resolve('../server/src/services/licenseService');

// Load a fresh licenseService with a fake `../db` injected. Re-requiring resets
// the module-level _instanceIdCache so each test starts clean.
function loadService(fakeDb, env = {}) {
  for (const k of [
    'SHENMAY_INSTANCE_ID', 'NOMII_INSTANCE_ID',
    'SHENMAY_LICENSE_KEY', 'NOMII_LICENSE_KEY',
  ]) delete process.env[k];
  Object.assign(process.env, env);

  delete require.cache[SVC_PATH];
  require.cache[DB_PATH] = { id: DB_PATH, filename: DB_PATH, loaded: true, exports: fakeDb };
  return require('../server/src/services/licenseService');
}

// ── Async-aware test runner (collect-then-run; matches tests/engine.test.js) ──

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

function test(name, fn) { queue.push({ type: 'test', name, fn }); }
function section(label) { queue.push({ type: 'section', label }); }

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}

section('\n== License Service Unit Tests (instance identity) ==\n');

section('getInstanceId — env pin');

test('SHENMAY_INSTANCE_ID pin wins and never queries the DB', async () => {
  let queried = 0;
  const svc = loadService(
    { query: async () => { queried++; throw new Error('DB should not be consulted'); } },
    { SHENMAY_INSTANCE_ID: 'pinned-abc-123' }
  );
  assertEqual(await svc.getInstanceId(), 'pinned-abc-123', 'pin must be returned verbatim');
  assertEqual(queried, 0, 'pinned path must not touch the DB');
});

test('legacy NOMII_INSTANCE_ID pin is still honoured', async () => {
  const svc = loadService(
    { query: async () => { throw new Error('DB should not be consulted'); } },
    { NOMII_INSTANCE_ID: 'legacy-pin' }
  );
  assertEqual(await svc.getInstanceId(), 'legacy-pin');
});

section('getInstanceId — persisted random id');

test('reads the persisted id via instance_identity get-or-create', async () => {
  let sql = '';
  const svc = loadService({
    query: async (q) => { sql = q; return { rows: [{ instance_id: 'persisted-deadbeef' }] }; },
  });
  assertEqual(await svc.getInstanceId(), 'persisted-deadbeef');
  assert(/insert\s+into\s+instance_identity/i.test(sql), 'must get-or-create the instance_identity row');
  assert(/on\s+conflict/i.test(sql), 'must be a get-or-create (ON CONFLICT) so first boots converge');
});

test('caches the resolved id — only one DB round-trip per process', async () => {
  let queries = 0;
  const svc = loadService({
    query: async () => { queries++; return { rows: [{ instance_id: 'cached-id' }] }; },
  });
  assertEqual(await svc.getInstanceId(), 'cached-id');
  assertEqual(await svc.getInstanceId(), 'cached-id', 'second call returns the cached value');
  assertEqual(queries, 1, 'the DB must be hit at most once');
});

test('a freshly generated id is a 16-char hex string', async () => {
  // Echo back whatever the app tried to INSERT (simulates first boot).
  const svc = loadService({
    query: async (_q, params) => ({ rows: [{ instance_id: params[0] }] }),
  });
  const id = await svc.getInstanceId();
  assert(/^[0-9a-f]{16}$/.test(id), `generated id must be 16 hex chars, got "${id}"`);
});

section('getInstanceId — DB-failure fallback');

test('degrades to a restart-stable key-derived id without throwing', async () => {
  const svc = loadService(
    { query: async () => { throw new Error('connection refused'); } },
    { SHENMAY_LICENSE_KEY: 'SHENMAY-AAAA-BBBB-CCCC-DDDD' }
  );
  const expected = crypto.createHash('sha256')
    .update('SHENMAY-AAAA-BBBB-CCCC-DDDD')
    .digest('hex')
    .slice(0, 16);
  assertEqual(await svc.getInstanceId(), expected, 'fallback must be sha256(LICENSE_KEY)[:16]');
});

test('the fallback is NOT cached — a recovered DB is picked up next call', async () => {
  let call = 0;
  const svc = loadService(
    {
      query: async () => {
        call++;
        if (call === 1) throw new Error('DB down on first try');
        return { rows: [{ instance_id: 'recovered-id' }] };
      },
    },
    { SHENMAY_LICENSE_KEY: 'KEY' }
  );
  const fallback = crypto.createHash('sha256').update('KEY').digest('hex').slice(0, 16);
  assertEqual(await svc.getInstanceId(), fallback, 'first call falls back');
  assertEqual(await svc.getInstanceId(), 'recovered-id', 'second call picks up the persisted id');
});

test('env pin beats a persisted DB id', async () => {
  const svc = loadService(
    { query: async () => ({ rows: [{ instance_id: 'db-id' }] }) },
    { SHENMAY_INSTANCE_ID: 'pin-wins' }
  );
  assertEqual(await svc.getInstanceId(), 'pin-wins');
});

// ── Run queue ────────────────────────────────────────────────────────────────

(async () => {
  for (const item of queue) {
    if (item.type === 'section') { console.log(item.label); continue; }
    try {
      await item.fn();
      console.log(`  ✓ ${item.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${item.name}`);
      console.log(`    ${err.message || err}`);
      failed++;
      failures.push({ name: item.name, message: err.message || String(err) });
    }
  }

  console.log(`\n== Results: ${passed} passed, ${failed} failed ==\n`);
  if (failed > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
