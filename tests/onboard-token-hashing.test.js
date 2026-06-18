/**
 * SHENMAY AI — Onboard token-hashing round-trip (T17 security polish)
 *
 * Pure-JS unit test — no DB, no server, no network. Runs in ~150ms.
 *
 * Verifies that email-verification tokens are stored as a SHA-256 digest (never
 * plaintext) AND that /verify looks them up by hashing the incoming token — i.e.
 * the write side and the read side use the SAME transform. A hash-on-write-but-
 * not-on-read (or vice-versa) mismatch would let this test go red, so it can't
 * ship green (the e2e signup-funnel plants its own token and so can't catch a
 * write-side regression on its own).
 *
 * Strategy: inject a fake `../db` + fake `../services/emailService` via
 * require.cache, require the real onboard router, pull the route handlers off
 * the router's layer stack, and drive them with fake req/res objects. The fake
 * db records every query so we can read back what /register STORED and what
 * /verify LOOKED UP, and the fake emailService captures the RAW token that was
 * emailed to the user.
 *
 * Run:  node tests/onboard-token-hashing.test.js
 */

'use strict';

const crypto = require('crypto');

// onboard's isSelfHosted() gate would 403 /register in self-hosted mode.
process.env.NODE_ENV = 'test';
delete process.env.SHENMAY_DEPLOYMENT;
delete process.env.NOMII_DEPLOYMENT;

const DB_PATH    = require.resolve('../server/src/db');
const EMAIL_PATH = require.resolve('../server/src/services/emailService');
const SVC_PATH   = require.resolve('../server/src/routes/onboard');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function fakeModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// Shared capture box populated by the fakes as the handlers run.
const cap = {};

// Fake pool — returns shaped rows by SQL substring, records the two values we
// assert on: the token /register STORES, and the token /verify LOOKS UP by.
function makeDb() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      // /register — existence checks must say "not found" so it proceeds
      if (/^SELECT id FROM tenant_admins WHERE email = \$1/.test(s)) return { rows: [] };
      if (/^SELECT id FROM tenants WHERE LOWER\(name\)/.test(s))     return { rows: [] };
      // /register — tenant insert
      if (/^INSERT INTO tenants/.test(s)) {
        return { rows: [{ id: 't1', name: 'Co', slug: 'co', agent_name: 'A', widget_api_key: 'wk', primary_color: '#1', secondary_color: '#2' }] };
      }
      // /register — admin insert: param $7 (index 6) is email_verification_token
      if (/^INSERT INTO tenant_admins/.test(s)) {
        cap.storedToken = params[6];
        return { rows: [{ id: 'a1', email: params[1], first_name: params[3], last_name: params[4], role: 'owner' }] };
      }
      if (/^INSERT INTO subscriptions/.test(s)) return { rows: [] };
      // /verify — token lookup: capture the param it queries by, return a match
      if (/FROM tenant_admins a JOIN tenants t/.test(s) && /email_verification_token = \$1/.test(s)) {
        cap.verifyLookupParam = params[0];
        return { rows: [{
          admin_id: 'a1', email: 'funnel@shenmay.test', first_name: 'F', last_name: 'L', role: 'owner',
          email_verified: false, tenant_id: 't1', tenant_name: 'Co', slug: 'co', agent_name: 'A',
          widget_api_key: 'wk', primary_color: '#1', secondary_color: '#2', onboarding_steps: {},
        }] };
      }
      // /verify — expiry check (future → not expired)
      if (/^SELECT email_verification_expires FROM tenant_admins WHERE id/.test(s)) {
        return { rows: [{ email_verification_expires: new Date(Date.now() + 3_600_000) }] };
      }
      if (/^UPDATE tenant_admins/.test(s)) return { rows: [] };
      return { rows: [] };
    },
  };
}

const fakeEmail = {
  sendVerificationEmail:  async ({ token }) => { cap.emailedRaw = token; },
  sendWelcomeEmail:       async () => {},
  sendPasswordResetEmail: async () => {},
};

fakeModule(DB_PATH, makeDb());
fakeModule(EMAIL_PATH, fakeEmail);
delete require.cache[SVC_PATH];
const onboard = require('../server/src/routes/onboard');

// Pull a route handler off the express Router layer stack (avoids needing an
// http server or the express dep in the test). The limiters live in index.js,
// not the router, so route.stack holds only the handler.
function findHandler(method, path) {
  const layer = onboard.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`route handler not found: ${method.toUpperCase()} ${path}`);
  const sub = layer.route.stack;
  return sub[sub.length - 1].handle;
}

// Invoke a handler with a fake req/res; resolves with { status, body }.
function invoke(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      send(body) { resolve({ status: this.statusCode, body }); return this; },
    };
    const next = (err) => (err ? reject(err) : undefined);
    Promise.resolve(handler({ headers: {}, socket: {}, params: {}, body: {}, ...req }, res, next)).catch(reject);
  });
}

// ── runner (collect-then-run; matches tests/engine.test.js) ────────────────
let passed = 0;
let failed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'Values differ'}\n      expected: ${JSON.stringify(b)}\n      actual:   ${JSON.stringify(a)}`);
}

const registerHandler = findHandler('post', '/register');
const verifyHandler   = findHandler('get', '/verify/:token');

const REG_BODY = {
  email: 'funnel@shenmay.test',
  password: 'FunnelTestPass!234',
  first_name: 'F',
  last_name: 'L',
  company_name: 'Co Hashing Test',
  vertical: 'other',
  tos_accepted: true,
};

console.log('\n== Onboard token-hashing round-trip (T17) ==\n');

test('register completes and emails a raw token', async () => {
  const r = await invoke(registerHandler, { body: REG_BODY });
  assertEqual(r.status, 201, 'register should return 201');
  assert(r.body && r.body.pending_verification === true, 'pending_verification expected');
  assert(typeof cap.emailedRaw === 'string' && cap.emailedRaw.length >= 32, 'a raw token was emailed');
});

test('register STORES the SHA-256 hash of the emailed token, not the raw token', async () => {
  assert(cap.storedToken, 'register stored an email_verification_token');
  assertEqual(cap.storedToken, sha256(cap.emailedRaw), 'stored value must be sha256(emailed raw token)');
  assert(cap.storedToken !== cap.emailedRaw, 'stored value must NOT equal the raw token (i.e. it is hashed)');
  assert(/^[0-9a-f]{64}$/.test(cap.storedToken), 'stored value is a 64-char hex digest');
});

test('verify LOOKS UP by the hash of the submitted token (read side hashes too)', async () => {
  const r = await invoke(verifyHandler, { params: { token: cap.emailedRaw } });
  assertEqual(cap.verifyLookupParam, sha256(cap.emailedRaw), '/verify must query by sha256(submitted token)');
  assertEqual(r.status, 200, 'verify with the correct raw token should succeed (200)');
  assert(r.body && typeof r.body.token === 'string' && r.body.token.length > 0, 'verify issues a portal JWT');
});

test('round-trip: what register stored === what verify looks up for the same raw token', async () => {
  // The decisive anti-regression check — if write and read used different
  // transforms, these would diverge and a real emailed token would never verify.
  assertEqual(cap.storedToken, cap.verifyLookupParam, 'register-stored token must equal verify-lookup token');
});

(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err.message || err}`);
      failed++;
      failures.push({ name: t.name, message: err.message || String(err) });
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
