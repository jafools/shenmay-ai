/**
 * SHENMAY AI — License Service Unit Tests (instance identity / T9)
 *
 * Pure-JS unit tests — no real DB, no external network. The DB is a tiny
 * in-memory fake injected via require.cache; the startup-validation tests talk
 * to a throwaway license master on 127.0.0.1.
 *
 * Also covers boot-time validation when the license master is unavailable
 * (transient: keep running, keep limits) vs. when it rejects the key.
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
    'SHENMAY_LICENSE_VALIDATE_URL', 'NOMII_LICENSE_VALIDATE_URL',
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

// ── Startup validation against an unavailable / answering license master ─────
//
// The license master (api.pontensolutions.com) went away in Sep 2026. Before
// this suite, an env-var key + an unreachable master meant process.exit(1) on
// every boot (crash-loop), and a dashboard key was demoted to trial limits.
// These tests run a throwaway master on 127.0.0.1, so they stay hermetic.

const http = require('http');

const DEFAULT_VALIDATE_URL = 'https://api.pontensolutions.com/api/license/validate';

// A local fake license master that answers every request with status + body.
function fakeMaster(status, body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify(body));
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}/api/license/validate`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

// A URL nothing listens on (bind an ephemeral port, then release it).
async function deadUrl() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return `http://127.0.0.1:${port}/api/license/validate`;
}

// Fake DB for the startup path; records every query.
function startupDb({ dbKey = null } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/instance_identity/i.test(sql)) return { rows: [{ instance_id: 'test-instance-id' }] };
      if (/SELECT license_key FROM tenants/i.test(sql)) return { rows: dbKey ? [{ license_key: dbKey }] : [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

// Plans written to the subscription row, in order.
const planWrites = (db) => db.calls
  .filter((c) => /UPDATE subscriptions/i.test(c.sql))
  .map((c) => c.params[0]);

// A master that sends 200 headers and part of the body, then closes the
// connection normally (FIN), so the client never sees the response 'end'.
function truncatingMaster() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100', Connection: 'close' });
        res.write('{"valid":tr');
        setTimeout(() => res.socket.end(), 20);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}/api/license/validate`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

// Run checkLicenseOnStartup as a production self-hosted install would, with
// process.exit trapped and console output captured; always restores both.
// Gives up after timeoutMs so a hang is reported (settled: false) instead of
// leaving the stubs in place for the rest of the run.
async function runStartup(svc, { timeoutMs = 5000 } = {}) {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    SHENMAY_DEPLOYMENT: process.env.SHENMAY_DEPLOYMENT,
    exit: process.exit,
    log: console.log, warn: console.warn, error: console.error,
  };
  const exits = [];
  const out = [];
  process.env.NODE_ENV = 'production';
  process.env.SHENMAY_DEPLOYMENT = 'selfhosted';
  process.exit = (code) => { exits.push(code); };
  console.log = console.warn = console.error = (...a) => out.push(a.map(String).join(' '));
  let timer;
  let settled;
  try {
    settled = await Promise.race([
      svc.checkLicenseOnStartup().then(() => true),
      new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    process.exit = saved.exit;
    console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    if (saved.NODE_ENV === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.SHENMAY_DEPLOYMENT === undefined) delete process.env.SHENMAY_DEPLOYMENT;
    else process.env.SHENMAY_DEPLOYMENT = saved.SHENMAY_DEPLOYMENT;
  }
  return { exits, out, settled };
}

section('validate URL resolution');

test('an empty SHENMAY_LICENSE_VALIDATE_URL (compose passthrough) falls back to the default', async () => {
  const svc = loadService(startupDb(), { SHENMAY_LICENSE_VALIDATE_URL: '' });
  assertEqual(svc._internal.VALIDATE_URL, DEFAULT_VALIDATE_URL);
});

test('a set SHENMAY_LICENSE_VALIDATE_URL overrides the default', async () => {
  const svc = loadService(startupDb(), { SHENMAY_LICENSE_VALIDATE_URL: 'https://licenses.example.com/validate' });
  assertEqual(svc._internal.VALIDATE_URL, 'https://licenses.example.com/validate');
});

section('checkLicenseOnStartup — license master unavailable (transient)');

test('env key + unreachable master: keeps running and leaves the plan alone', async () => {
  const db = startupDb();
  const svc = loadService(db, { SHENMAY_LICENSE_KEY: 'SHENMAY-ENV-KEY', SHENMAY_LICENSE_VALIDATE_URL: await deadUrl() });
  const { exits, out } = await runStartup(svc);
  assertEqual(exits.length, 0, 'must not exit when the master is merely unreachable');
  assertEqual(planWrites(db).length, 0, 'must not touch the subscription limits');
  assert(out.some((l) => l.includes('License server unavailable')), 'logs the keep-limits warning');
});

test('env key + master answering 503: treated as transient, keeps running', async () => {
  const master = await fakeMaster(503, { error: 'Service Unavailable' });
  try {
    const db = startupDb();
    const svc = loadService(db, { SHENMAY_LICENSE_KEY: 'SHENMAY-ENV-KEY', SHENMAY_LICENSE_VALIDATE_URL: master.url });
    const { exits } = await runStartup(svc);
    assertEqual(exits.length, 0, 'a 5xx is not a verdict on the key');
    assertEqual(planWrites(db).length, 0, 'must not touch the subscription limits');
  } finally { await master.close(); }
});

test('master closes the connection mid-response: boot settles instead of hanging', async () => {
  const master = await truncatingMaster();
  try {
    const db = startupDb();
    const svc = loadService(db, { SHENMAY_LICENSE_KEY: 'SHENMAY-ENV-KEY', SHENMAY_LICENSE_VALIDATE_URL: master.url });
    const { settled, exits } = await runStartup(svc);
    assert(settled, 'checkLicenseOnStartup never settled, so boot would hang before app.listen()');
    assertEqual(exits.length, 0, 'a dropped connection is transient');
    assertEqual(planWrites(db).length, 0, 'limits untouched');
  } finally { await master.close(); }
});

test('dashboard key + unreachable master: keeps current limits (no trial demotion)', async () => {
  const db = startupDb({ dbKey: 'SHENMAY-DB-KEY' });
  const svc = loadService(db, { SHENMAY_LICENSE_VALIDATE_URL: await deadUrl() });
  const { exits } = await runStartup(svc);
  assertEqual(exits.length, 0, 'must not exit');
  assertEqual(planWrites(db).length, 0, 'a paying install must not be demoted to trial by an outage');
});

section('checkLicenseOnStartup — license master verdicts (unchanged)');

test('env key the master revokes: still refuses to start (exit 1)', async () => {
  const master = await fakeMaster(403, { error: 'License has been revoked' });
  try {
    const db = startupDb();
    const svc = loadService(db, { SHENMAY_LICENSE_KEY: 'SHENMAY-ENV-KEY', SHENMAY_LICENSE_VALIDATE_URL: master.url });
    const { exits } = await runStartup(svc);
    assertEqual(exits[0], 1, 'a definitive rejection of an env key still fails loud');
  } finally { await master.close(); }
});

test('dashboard key the master says has expired: falls back to trial limits', async () => {
  const master = await fakeMaster(403, { error: 'License has expired' });
  try {
    const db = startupDb({ dbKey: 'SHENMAY-DB-KEY' });
    const svc = loadService(db, { SHENMAY_LICENSE_VALIDATE_URL: master.url });
    const { exits } = await runStartup(svc);
    assertEqual(exits.length, 0, 'dashboard keys never crash the server');
    assertEqual(planWrites(db).join(','), 'trial', 'reverts to trial limits');
  } finally { await master.close(); }
});

test('valid key: applies the plan the master returns', async () => {
  const master = await fakeMaster(200, { valid: true, plan: 'growth', expires_at: null });
  try {
    const db = startupDb();
    const svc = loadService(db, { SHENMAY_LICENSE_KEY: 'SHENMAY-ENV-KEY', SHENMAY_LICENSE_VALIDATE_URL: master.url });
    const { exits } = await runStartup(svc);
    assertEqual(exits.length, 0, 'must not exit');
    assertEqual(planWrites(db).join(','), 'growth', 'growth limits applied');
  } finally { await master.close(); }
});

section('activateLicense — license master unreachable');

test('throws LICENSE_SERVER_UNREACHABLE and persists nothing', async () => {
  const db = startupDb();
  const svc = loadService(db, { SHENMAY_LICENSE_VALIDATE_URL: await deadUrl() });
  let caught = null;
  try { await svc.activateLicense('SHENMAY-NEW-KEY', 'tenant-1'); } catch (e) { caught = e; }
  assert(caught, 'activation must fail');
  assertEqual(caught.code, 'LICENSE_SERVER_UNREACHABLE', 'typed so the route can answer 503');
  assert(!db.calls.some((c) => /UPDATE tenants/i.test(c.sql)), 'the key must not be persisted');
  assertEqual(planWrites(db).length, 0, 'limits must not change');
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
