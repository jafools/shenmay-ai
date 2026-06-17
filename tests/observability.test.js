/**
 * SHENMAY AI — Observability Unit Tests (request correlation + 5xx counter +
 * Sentry gating; audit M11/M12, task T10).
 *
 * Pure-JS — no DB, no server, no network. The request middleware is exercised
 * with fake req/res objects (res is an EventEmitter so we can fire 'finish').
 * LOG_LEVEL is silenced so pino doesn't print during the run.
 *
 * Run:  node tests/observability.test.js
 */

'use strict';

process.env.LOG_LEVEL = 'silent';
delete process.env.SENTRY_DSN; // assert silent-by-default

const { EventEmitter } = require('events');

const { requestContext, getHttp5xx } = require('../server/src/middleware/requestContext');
const { initSentry, isEnabled, captureError, captureFatal } = require('../server/src/utils/sentry');
const { runWithContext, getContext, setContext } = require('../server/src/utils/logger');

// ── Fakes ─────────────────────────────────────────────────────────────────────

function makeReq(headers = {}, method = 'GET', path = '/api/x') {
  return { headers, method, path };
}
function makeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// ── Runner (collect-then-run; matches tests/engine.test.js) ────────────────────

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ type: 'test', name, fn }); }
function section(label) { queue.push({ type: 'section', label }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) {
  if (a !== b) throw new Error(`${m || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}

section('\n== Observability Unit Tests ==\n');

section('requestContext — correlation');

test('mints a UUID request id and echoes it as X-Request-Id', async () => {
  const req = makeReq();
  const res = makeRes();
  await new Promise((resolve) => requestContext(req, res, resolve));
  assert(/^[0-9a-f-]{36}$/.test(req.id), `req.id must be a uuid, got "${req.id}"`);
  assertEqual(res.headers['X-Request-Id'], req.id, 'response header must echo the id');
});

test('honours a sane inbound X-Request-Id', async () => {
  const req = makeReq({ 'x-request-id': 'trace-abc.123' });
  const res = makeRes();
  await new Promise((resolve) => requestContext(req, res, resolve));
  assertEqual(req.id, 'trace-abc.123', 'a safe inbound id is reused');
});

test('rejects an unsafe inbound X-Request-Id and mints a fresh one', async () => {
  const evil = 'x'.repeat(200) + '\n[ERROR] injected';
  const req = makeReq({ 'x-request-id': evil });
  const res = makeRes();
  await new Promise((resolve) => requestContext(req, res, resolve));
  assert(req.id !== evil, 'unsafe inbound id must not be trusted');
  assert(/^[0-9a-f-]{36}$/.test(req.id), 'falls back to a minted uuid');
});

test('runs next() inside an AsyncLocalStorage context carrying the id', async () => {
  const req = makeReq();
  const res = makeRes();
  let seen = null;
  await new Promise((resolve) => requestContext(req, res, () => { seen = getContext().requestId; resolve(); }));
  assertEqual(seen, req.id, 'downstream code sees the request id via context');
});

section('http_5xx counter');

test('increments only on 5xx at response finish', async () => {
  const before = getHttp5xx();

  const ok = makeRes();
  await new Promise((resolve) => requestContext(makeReq(), ok, resolve));
  ok.statusCode = 200; ok.emit('finish');

  const clientErr = makeRes();
  await new Promise((resolve) => requestContext(makeReq(), clientErr, resolve));
  clientErr.statusCode = 404; clientErr.emit('finish');

  assertEqual(getHttp5xx(), before, '2xx/4xx must not bump the counter');

  const serverErr = makeRes();
  await new Promise((resolve) => requestContext(makeReq(), serverErr, resolve));
  serverErr.statusCode = 500; serverErr.emit('finish');

  const serverErr2 = makeRes();
  await new Promise((resolve) => requestContext(makeReq(), serverErr2, resolve));
  serverErr2.statusCode = 503; serverErr2.emit('finish');

  assertEqual(getHttp5xx(), before + 2, 'each 5xx bumps the counter once');
});

section('Sentry — DSN-gated, silent by default');

test('stays disabled when SENTRY_DSN is unset; captures are no-ops', async () => {
  assertEqual(initSentry(), null, 'no DSN → no Sentry');
  assertEqual(isEnabled(), false, 'isEnabled() false without a DSN');
  // Must not throw with Sentry inactive.
  captureError(new Error('boom'), { requestId: 'r1' });
  await new Promise((resolve) => captureFatal(new Error('fatal'), resolve));
});

section('logger — context helpers');

test('setContext merges into the active store; getContext is empty outside one', async () => {
  assertEqual(Object.keys(getContext()).length, 0, 'no ambient context outside a request');
  await runWithContext({ requestId: 'r2' }, async () => {
    setContext({ tenantId: 't9' });
    assertEqual(getContext().requestId, 'r2');
    assertEqual(getContext().tenantId, 't9', 'setContext enriches the active store');
  });
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
