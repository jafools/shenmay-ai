/**
 * SHENMAY AI — Portal Owner-Gate Middleware Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no network. Validates the centralized
 * owner gate that protects the sensitive-config portal sub-routers (api-key,
 * connectors, webhooks, tools) and the data-API-key routes.
 *
 * Run:  node tests/owner-gate.test.js
 */

'use strict';

const { requireOwner, requireOwnerForWrites } = require('../server/src/middleware/requireOwner');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message || err}`);
    failed++;
    failures.push({ name, message: err.message || String(err) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Minimal Express req/res doubles.
function mkRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function run(mw, { role, method = 'POST' } = {}) {
  const req = { method, portal: role === undefined ? undefined : { role } };
  const res = mkRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { nextCalled, status: res.statusCode };
}

console.log('\n== Portal Owner-Gate Middleware Unit Tests ==\n');

console.log('requireOwner');
test('owner → next()', () => {
  const r = run(requireOwner, { role: 'owner' });
  assert(r.nextCalled, 'owner must pass through');
});
test('member ("Admin") → 403', () => {
  const r = run(requireOwner, { role: 'member' });
  assert(!r.nextCalled && r.status === 403, 'member must be blocked');
});
test('agent → 403 (the actual threat role)', () => {
  const r = run(requireOwner, { role: 'agent' });
  assert(!r.nextCalled && r.status === 403, 'agent must be blocked');
});
test('missing req.portal → 403 (fail closed)', () => {
  const r = run(requireOwner, { role: undefined });
  assert(!r.nextCalled && r.status === 403, 'missing portal must be blocked');
});

console.log('\nrequireOwnerForWrites');
test('GET passes for any seat (agent)', () => {
  const r = run(requireOwnerForWrites, { role: 'agent', method: 'GET' });
  assert(r.nextCalled, 'GET must stay open');
});
test('POST as agent → 403', () => {
  const r = run(requireOwnerForWrites, { role: 'agent', method: 'POST' });
  assert(!r.nextCalled && r.status === 403, 'agent write must be blocked');
});
test('DELETE as member → 403 (sensitive-config writes are owner-only)', () => {
  const r = run(requireOwnerForWrites, { role: 'member', method: 'DELETE' });
  assert(!r.nextCalled && r.status === 403, 'member write must be blocked');
});
test('PATCH as owner → next()', () => {
  const r = run(requireOwnerForWrites, { role: 'owner', method: 'PATCH' });
  assert(r.nextCalled, 'owner write must pass');
});
test('PUT as agent → 403', () => {
  const r = run(requireOwnerForWrites, { role: 'agent', method: 'PUT' });
  assert(!r.nextCalled && r.status === 403, 'agent write must be blocked');
});

console.log(`\n== Results: ${passed} passed, ${failed} failed ==`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}\n    ${f.message}`);
  process.exit(1);
}
process.exit(0);
