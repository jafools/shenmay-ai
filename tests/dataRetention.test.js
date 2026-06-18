/**
 * SHENMAY AI — Data Retention Housekeeping-Prune Unit Tests
 *
 * Pure-JS unit tests — no DB, no server, no network. Runs in ~50ms.
 *
 * Covers the env-overridable retention-window parsing and the housekeeping
 * prune-spec builder added to server/src/jobs/dataRetention.js (audit M3/T18).
 * Both exported functions are pure: parseRetentionDays does no I/O, and
 * buildHousekeepingPrunes returns the exact table / parameterized SQL / params
 * / window for each prune, so the SQL shape, the timestamp cutoff math and the
 * env plumbing can all be asserted without a Postgres connection.
 *
 * Requiring the job module instantiates a pg Pool but opens no connection
 * (Pool is lazy), and neither pure function issues a query, so this stays
 * fully hermetic.
 *
 * Run:  node tests/dataRetention.test.js
 */

'use strict';

// Pin a deterministic env so default-window assertions are stable regardless of
// the developer's shell. Clear the four overridable keys BEFORE requiring the
// module (the day-window constants are read at module load).
for (const k of [
  'NOTIFICATION_RETENTION_DAYS',
  'PORTAL_TOKEN_RETENTION_DAYS',
  'PORTAL_SESSION_RETENTION_DAYS',
  'STRIPE_EVENT_RETENTION_DAYS',
]) {
  delete process.env[k];
}

const {
  parseRetentionDays,
  buildHousekeepingPrunes,
} = require('../server/src/jobs/dataRetention');

// ── Async-aware test runner (collect-then-run; matches tests/engine.test.js) ──

let passed = 0;
let failed = 0;
const failures = [];
const queue = [];

function test(name, fn) {
  queue.push({ type: 'test', name, fn });
}
function section(label) {
  queue.push({ type: 'section', label });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function assertEqual(a, b, message) {
  if (a !== b) throw new Error(`${message || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}
function assertContains(hay, needle, message) {
  if (!String(hay).includes(needle)) throw new Error(`${message || 'Does not contain'}: expected "${hay}" to include "${needle}"`);
}
function assertNotContains(hay, needle, message) {
  if (String(hay).includes(needle)) throw new Error(`${message || 'Contains forbidden value'}: "${hay}" should NOT include "${needle}"`);
}

section('\n== Data Retention Housekeeping-Prune Unit Tests ==\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1. parseRetentionDays — env-overridable window parsing + clamp floor
// ═══════════════════════════════════════════════════════════════════════════

section('parseRetentionDays');

test('returns the default when the env var is unset', () => {
  assertEqual(parseRetentionDays('UNSET_RETENTION_KEY', 90, {}), 90);
});

test('reads and parses a valid integer override', () => {
  assertEqual(parseRetentionDays('X', 90, { X: '45' }), 45);
});

test('parses leading-integer strings the way parseInt does', () => {
  assertEqual(parseRetentionDays('X', 90, { X: '14days' }), 14);
});

test('falls back to the default for a non-numeric value', () => {
  assertEqual(parseRetentionDays('X', 90, { X: 'soon' }), 90);
});

test('clamps a zero override to the 1-day floor (never prunes live rows)', () => {
  // 0 is not > 0, so it falls back to default; default itself floors at 1.
  assertEqual(parseRetentionDays('X', 7, { X: '0' }), 7);
});

test('clamps a negative override to the 1-day floor', () => {
  assertEqual(parseRetentionDays('X', 7, { X: '-30' }), 7);
});

test('a default of 0 or negative is itself floored to 1 day', () => {
  assertEqual(parseRetentionDays('UNSET', 0, {}), 1);
  assertEqual(parseRetentionDays('UNSET', -5, {}), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. buildHousekeepingPrunes — table / column / SQL / cutoff correctness
// ═══════════════════════════════════════════════════════════════════════════

section('buildHousekeepingPrunes');

test('returns exactly the four housekeeping tables, in order', () => {
  const prunes = buildHousekeepingPrunes();
  assertEqual(prunes.length, 4, 'must produce four prune specs');
  assertEqual(prunes[0].table, 'notifications');
  assertEqual(prunes[1].table, 'portal_login_tokens');
  assertEqual(prunes[2].table, 'portal_sessions');
  assertEqual(prunes[3].table, 'processed_stripe_events');
});

test('each prune deletes from its own table on the correct timestamp column', () => {
  const prunes = buildHousekeepingPrunes();
  // notifications → created_at
  assertContains(prunes[0].sql, 'DELETE FROM notifications WHERE created_at < $1');
  // portal_login_tokens → expires_at (NOT created_at — TTL governs usefulness)
  assertContains(prunes[1].sql, 'DELETE FROM portal_login_tokens WHERE expires_at < $1');
  // portal_sessions → expires_at
  assertContains(prunes[2].sql, 'DELETE FROM portal_sessions WHERE expires_at < $1');
  // processed_stripe_events → processed_at
  assertContains(prunes[3].sql, 'DELETE FROM processed_stripe_events WHERE processed_at < $1');
});

test('login tokens and sessions prune on expires_at, never created_at', () => {
  const prunes = buildHousekeepingPrunes();
  assertNotContains(prunes[1].sql, 'created_at', 'login tokens must NOT prune on created_at');
  assertNotContains(prunes[2].sql, 'created_at', 'sessions must NOT prune on created_at');
});

test('every prune is fully parameterized — one $1 placeholder, one param, no literal dates', () => {
  for (const prune of buildHousekeepingPrunes()) {
    assertContains(prune.sql, '$1', `${prune.table} must use a placeholder`);
    assertEqual(prune.params.length, 1, `${prune.table} must pass exactly one param`);
    assert(typeof prune.params[0] === 'string', `${prune.table} param must be an ISO string`);
    // The window value must never be interpolated into the SQL text.
    assertNotContains(prune.sql, String(prune.windowDays), `${prune.table} must not interpolate the window`);
  }
});

test('NEVER prunes audit_logs (legally retained) or any non-target table', () => {
  for (const prune of buildHousekeepingPrunes()) {
    assertNotContains(prune.sql.toLowerCase(), 'audit_logs', 'audit_logs must never appear in a prune');
    assertNotContains(prune.sql.toLowerCase(), 'conversations', 'conversations must never appear in a prune');
    assertNotContains(prune.sql.toLowerCase(), 'customers', 'customers must never appear in a prune');
    assertNotContains(prune.sql.toLowerCase(), 'messages', 'messages must never appear in a prune');
  }
});

test('default windows are the documented conservative values', () => {
  const prunes = buildHousekeepingPrunes();
  assertEqual(prunes[0].windowDays, 90, 'notifications default = 90d');
  assertEqual(prunes[1].windowDays, 7,  'portal_login_tokens default = 7d');
  assertEqual(prunes[2].windowDays, 30, 'portal_sessions default = 30d');
  assertEqual(prunes[3].windowDays, 90, 'processed_stripe_events default = 90d');
});

test('Stripe ledger window stays well clear of Stripe\'s ~3-day retry horizon', () => {
  const stripe = buildHousekeepingPrunes()[3];
  assert(stripe.windowDays >= 30, 'a Stripe window under 30d would risk pruning replayable events');
});

test('cutoff is computed as now - windowDays for the given reference time', () => {
  // Fixed reference: 2026-06-18T00:00:00Z. 90 days earlier = 2026-03-20.
  const now = new Date('2026-06-18T00:00:00.000Z');
  const prunes = buildHousekeepingPrunes({ now });

  const notifCutoff = new Date(prunes[0].params[0]);
  const expectedNotif = new Date('2026-06-18T00:00:00.000Z');
  expectedNotif.setDate(expectedNotif.getDate() - 90);
  assertEqual(notifCutoff.getTime(), expectedNotif.getTime(), 'notifications cutoff must be now-90d');

  const tokenCutoff = new Date(prunes[1].params[0]);
  const expectedToken = new Date('2026-06-18T00:00:00.000Z');
  expectedToken.setDate(expectedToken.getDate() - 7);
  assertEqual(tokenCutoff.getTime(), expectedToken.getTime(), 'token cutoff must be now-7d');
});

test('cutoffs are always in the past relative to now', () => {
  const now = new Date('2026-06-18T00:00:00.000Z');
  for (const prune of buildHousekeepingPrunes({ now })) {
    assert(new Date(prune.params[0]).getTime() < now.getTime(),
      `${prune.table} cutoff must be strictly before now`);
  }
});

test('per-call day overrides flow into both the window label and the cutoff', () => {
  const now = new Date('2026-06-18T00:00:00.000Z');
  const prunes = buildHousekeepingPrunes({
    now,
    days: { notification: 10, portalToken: 2, portalSession: 5, stripeEvent: 120 },
  });
  assertEqual(prunes[0].windowDays, 10);
  assertEqual(prunes[1].windowDays, 2);
  assertEqual(prunes[2].windowDays, 5);
  assertEqual(prunes[3].windowDays, 120);

  const expected = new Date('2026-06-18T00:00:00.000Z');
  expected.setDate(expected.getDate() - 120);
  assertEqual(new Date(prunes[3].params[0]).getTime(), expected.getTime(),
    'stripe cutoff must reflect the 120d override');
});

test('each prune carries a system audit event_type under the retention.* namespace', () => {
  for (const prune of buildHousekeepingPrunes()) {
    assertContains(prune.eventType, 'retention.', `${prune.table} event_type must be namespaced`);
    assert(prune.eventType.length <= 60, 'event_type must fit audit_logs VARCHAR(60)');
    assertEqual(prune.resourceType, prune.table, 'resourceType should name the pruned table');
  }
});

// ── Run queue ────────────────────────────────────────────────────────────────

(async () => {
  for (const item of queue) {
    if (item.type === 'section') {
      console.log(item.label);
      continue;
    }
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
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})();
