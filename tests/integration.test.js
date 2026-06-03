/**
 * NOMII AI — Comprehensive Integration Test Suite
 *
 * Tests three deployment modes:
 *   1. Unit tests — subscription middleware pure logic (no server needed)
 *   2. SaaS mode — /api/config, platform routes, license routes behavior
 *   3. Self-hosted mode — /api/config, blocked platform routes, registration
 *   4. License master mode — /api/license/* endpoints + platform/licenses CRUD
 *
 * Requirements:
 *   - PostgreSQL running with nomii_test database
 *   - All migrations applied to nomii_test
 *
 * Run: node tests/integration.test.js
 */

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── Resolve test DB URL ───────────────────────────────────────────────────────
// Priority:
//   1. TEST_DATABASE_URL env var (explicit override)
//   2. DATABASE_URL env var (already set in shell)
//   3. DATABASE_URL parsed from server/.env
//   4. Hardcoded dev default
//
// In all cases, the database name is replaced with <name>_test so we never
// touch a production database.

function parseEnvFile(filePath) {
  const vars = {};
  if (!fs.existsSync(filePath)) return vars;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    vars[key] = val;
  }
  return vars;
}

function makeTestDbUrl(baseUrl) {
  // Replace the database name at the end of the URL with <name>_test
  // e.g. postgresql://user:pass@host:5432/shenmay_ai  →  .../shenmay_ai_test
  try {
    const u = new URL(baseUrl);
    const dbName = u.pathname.replace(/^\//, '');
    u.pathname = `/${dbName}_test`;
    return u.toString();
  } catch {
    return baseUrl; // give up, return as-is
  }
}

const serverEnv = parseEnvFile(path.resolve(__dirname, '..', 'server', '.env'));

const rawDbUrl =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  serverEnv.DATABASE_URL ||
  'postgresql://shenmay:shenmay_dev_2026@localhost:5432/shenmay_ai';

const TEST_DB = makeTestDbUrl(rawDbUrl);

// Derive individual psql connection fields from the test URL (for cleanup)
const _testUrl = new URL(TEST_DB);
const PG = {
  host:     _testUrl.hostname || 'localhost',
  port:     _testUrl.port     || '5432',
  user:     _testUrl.username || 'nomii',
  password: _testUrl.password || '',
  database: _testUrl.pathname.replace(/^\//, ''),
};

// Use the same JWT/encryption secrets as the real server when available
const BASE_ENV = {
  ...process.env,
  ...serverEnv,
  DATABASE_URL: TEST_DB,
  NODE_ENV: 'development',
  // Ensure safe fallbacks — keep server .env values when they exist
  JWT_SECRET:                serverEnv.JWT_SECRET                || 'test-jwt-secret-at-least-32-characters-long-1234',
  WIDGET_JWT_SECRET:         serverEnv.WIDGET_JWT_SECRET         || 'test-widget-secret-at-least-32-chars-1234',
  API_KEY_ENCRYPTION_SECRET: serverEnv.API_KEY_ENCRYPTION_SECRET || 'test-encryption-key-32-chars-long-12345',
  LOGIN_RATE_LIMIT_MAX:      '200',
  WIDGET_SESSION_RATE_LIMIT_MAX: '200',
  PORTAL_RATE_LIMIT_MAX:     '500',
};

console.log(`Test DB: ${PG.host}:${PG.port}/${PG.database} (user: ${PG.user})`);

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    const msg = err.message || String(err);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg}`);
    failed++;
    failures.push({ name, message: msg });
  }
}

class AssertionError extends Error {}

function assert(condition, message) {
  if (!condition) throw new AssertionError(message || 'Assertion failed');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function get(baseUrl, path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${baseUrl}${path}`, { headers });
  const body = await res.text();
  try {
    return { status: res.status, body: JSON.parse(body) };
  } catch {
    return { status: res.status, body };
  }
}

async function post(baseUrl, path, data, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const body = await res.text();
  try {
    return { status: res.status, body: JSON.parse(body) };
  } catch {
    return { status: res.status, body };
  }
}

async function patch(baseUrl, path, data, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(data || {}),
  });
  const body = await res.text();
  try {
    return { status: res.status, body: JSON.parse(body) };
  } catch {
    return { status: res.status, body };
  }
}

// ── Server management ──────────────────────────────────────────────────────────

function startServer(port, extraEnv = {}) {
  const serverPath = path.resolve(__dirname, '..', 'server', 'src', 'index.js');
  const env = { ...BASE_ENV, PORT: String(port), ...extraEnv };

  const proc = spawn(process.execPath, [serverPath], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Suppress server output unless there's an error
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => {
    const msg = d.toString();
    if (msg.includes('[ERROR]') || msg.includes('Error')) {
      console.error(`  [server:${port}] ${msg}`);
    }
  });

  return proc;
}

async function waitForServer(port, timeoutMs = 30000) {
  const baseUrl = `http://localhost:${port}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok) return baseUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server on port ${port} did not start within ${timeoutMs}ms`);
}

function stopServer(proc) {
  return new Promise((resolve) => {
    proc.once('close', resolve);
    proc.kill('SIGTERM');
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
    }, 3000);
  });
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// Require pg from the server's node_modules (it ships with the server)
const { Pool } = require(path.resolve(__dirname, '..', 'server', 'node_modules', 'pg'));

let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: TEST_DB });
  return _pool;
}

async function ensureTestDbExists() {
  // Step 1: Try connecting directly to the test DB
  const testPool = new Pool({ connectionString: TEST_DB });
  try {
    await testPool.query('SELECT 1');
    // Connected fine — test DB already exists
    await testPool.end();
    return true;
  } catch (err) {
    await testPool.end().catch(() => {});
    if (!err.message.includes('does not exist')) {
      // Auth error or other problem — can't proceed
      console.error(`\n  Cannot connect to test DB: ${err.message}`);
      console.error(`  URL: ${TEST_DB}\n`);
      return false;
    }
  }

  // Step 2: DB doesn't exist — try to create it.
  // Try connecting to postgres, then the base DB, then template1
  const candidates = ['postgres', rawDbUrl.split('/').pop(), 'template1'];
  for (const dbName of candidates) {
    const tryUrl = new URL(TEST_DB);
    tryUrl.pathname = `/${dbName}`;
    const pool = new Pool({ connectionString: tryUrl.toString() });
    try {
      await pool.query(`CREATE DATABASE "${PG.database}"`);
      console.log(`Created test database: ${PG.database}`);
      await pool.end();
      return true;
    } catch (err) {
      await pool.end().catch(() => {});
      if (err.message.includes('already exists')) return true;
      // Try next candidate
    }
  }

  // Step 3: All creation attempts failed — tell the user how to fix it
  console.error('\n══════════════════════════════════════════════════════');
  console.error(`  Test database "${PG.database}" does not exist and`);
  console.error('  could not be created automatically.');
  console.error('');
  console.error('  Create it manually:');
  console.error(`    sudo -u postgres createdb ${PG.database}`);
  console.error(`    sudo -u postgres psql -c "GRANT ALL ON DATABASE ${PG.database} TO ${PG.user}"`);
  console.error('');
  console.error('  Then re-run:  node tests/integration.test.js');
  console.error('══════════════════════════════════════════════════════\n');
  return false;
}

async function runMigrationsOnTestDb() {
  const migrationsDir = path.resolve(__dirname, '..', 'server', 'db', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const pool = getPool();

  // Enable pgcrypto so gen_random_bytes() works in migrations
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto').catch(() => {});

  const files = fs.readdirSync(migrationsDir).sort().filter(f => f.endsWith('.sql'));

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await pool.query(sql);
    } catch (err) {
      // Ignore "already exists" / "duplicate" from idempotent migrations
      if (!err.message.includes('already exists') && !err.message.includes('duplicate')) {
        // Silently skip — migration may be partially applied
      }
    }
  }
}

async function cleanupDb() {
  const pool = getPool();
  try {
    await pool.query(`
      DELETE FROM portal_sessions;
      DELETE FROM portal_login_tokens;
      DELETE FROM portal_rate_limits;
      DELETE FROM notifications;
      DELETE FROM licenses;
      DELETE FROM subscriptions;
      DELETE FROM tenant_admins;
      DELETE FROM platform_admins;
      DELETE FROM tenants;
    `);
  } catch (err) {
    // ignore cleanup errors (table might not exist yet)
  }
}

async function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main test runner ──────────────────────────────────────────────────────────

async function runTests() {
  // ── Ensure test DB exists and is migrated ─────────────────────────────────
  const dbReady = await ensureTestDbExists();
  if (dbReady) {
    await runMigrationsOnTestDb();
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // UNIT TESTS — Subscription Middleware Logic
  // ══════════════════════════════════════════════════════════════════════════════

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Unit Tests — Subscription Middleware Logic');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const subscriptionModule = require('../server/src/middleware/subscription');
  const plansModule = require('../server/src/config/plans');

  const {
    isSubscriptionValid,
    getBlockReason,
    isWithinMessageLimit,
  } = subscriptionModule;
  const { PLAN_LIMITS, isSelfHosted } = plansModule;

  console.log('\nisSubscriptionValid()');

  await test('null subscription → false', () => {
    assert(isSubscriptionValid(null) === false);
  });

  await test('inactive tenant → false', () => {
    const sub = { is_active: false, plan: 'starter', status: 'active' };
    assert(isSubscriptionValid(sub) === false);
  });

  await test('master plan → true', () => {
    const sub = { is_active: true, plan: 'master', status: 'active' };
    assert(isSubscriptionValid(sub) === true);
  });

  await test('enterprise plan → true', () => {
    const sub = { is_active: true, plan: 'enterprise', status: 'active' };
    assert(isSubscriptionValid(sub) === true);
  });

  await test('active status → true', () => {
    const sub = { is_active: true, plan: 'starter', status: 'active' };
    assert(isSubscriptionValid(sub) === true);
  });

  await test('trialing + future end date → true', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const sub = { is_active: true, plan: 'starter', status: 'trialing', trial_ends_at: future };
    assert(isSubscriptionValid(sub) === true);
  });

  await test('trialing + past end date → false', () => {
    const past = new Date(Date.now() - 1000);
    const sub = { is_active: true, plan: 'starter', status: 'trialing', trial_ends_at: past };
    assert(isSubscriptionValid(sub) === false);
  });

  await test('past_due within grace period → true', () => {
    const gracePeriod = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const sub = { is_active: true, plan: 'starter', status: 'past_due', current_period_end: gracePeriod };
    assert(isSubscriptionValid(sub) === true);
  });

  await test('past_due beyond grace period → false', () => {
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const sub = { is_active: true, plan: 'starter', status: 'past_due', current_period_end: old };
    assert(isSubscriptionValid(sub) === false);
  });

  await test('canceled status → false', () => {
    const sub = { is_active: true, plan: 'starter', status: 'canceled' };
    assert(isSubscriptionValid(sub) === false);
  });

  console.log('\ngetBlockReason()');

  await test('null subscription → no_subscription', () => {
    const reason = getBlockReason(null);
    assert(reason.code === 'no_subscription');
  });

  await test('inactive tenant → tenant_inactive', () => {
    const reason = getBlockReason({ is_active: false });
    assert(reason.code === 'tenant_inactive');
  });

  await test('trialing → trial_expired', () => {
    const reason = getBlockReason({ is_active: true, status: 'trialing' });
    assert(reason.code === 'trial_expired');
  });

  await test('past_due → payment_past_due', () => {
    const reason = getBlockReason({ is_active: true, status: 'past_due' });
    assert(reason.code === 'payment_past_due');
  });

  await test('canceled → subscription_canceled', () => {
    const reason = getBlockReason({ is_active: true, status: 'canceled' });
    assert(reason.code === 'subscription_canceled');
  });

  console.log('\nisWithinMessageLimit()');

  await test('master plan → true (unlimited)', () => {
    const sub = { plan: 'master', messages_used_this_month: 999999, max_messages_month: 1000 };
    assert(isWithinMessageLimit(sub) === true);
  });

  await test('trial plan under limit → true', () => {
    const sub = { plan: 'trial', messages_used_this_month: 25, max_messages_month: 50 };
    assert(isWithinMessageLimit(sub) === true);
  });

  await test('trial plan at limit → false', () => {
    const sub = { plan: 'trial', messages_used_this_month: 50, max_messages_month: 50 };
    assert(isWithinMessageLimit(sub) === false);
  });

  console.log('\nPLAN_LIMITS');

  await test('trial limits: 50 msg/mo, 3 customers', () => {
    const trial = PLAN_LIMITS.trial;
    assert(trial.max_messages_month === 50, `Expected 50, got ${trial.max_messages_month}`);
    assert(trial.max_customers === 3, `Expected 3, got ${trial.max_customers}`);
  });

  await test('starter limits: 1000 msg/mo, 50 customers', () => {
    const starter = PLAN_LIMITS.starter;
    assert(starter.max_messages_month === 1000);
    assert(starter.max_customers === 50);
  });

  await test('isSelfHosted() reflects SHENMAY_DEPLOYMENT env', () => {
    const isSelfHostedNow = process.env.SHENMAY_DEPLOYMENT === 'selfhosted';
    assert(isSelfHosted() === isSelfHostedNow);
  });

  console.log('\nJWT algorithm pinning (auth hardening)');

  const authService = require('../server/src/services/authService');

  await test('validateToken accepts a normal HS256 token', () => {
    const token = authService.generateToken({ user_id: 'u1', tenant_id: 't1', user_type: 'customer', role: 'member', email: 'a@b.co' });
    const decoded = authService.validateToken(token);
    assert(decoded.user_id === 'u1', 'round-trip HS256 token must validate');
  });

  await test('validateToken rejects an alg:none token (algorithm is pinned)', () => {
    // Hand-craft an unsigned token claiming alg:none (no jsonwebtoken dep needed
    // here — server deps live in server/node_modules, not root). With
    // algorithms:['HS256'] pinned, jwt.verify must reject it.
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({ user_id: 'attacker', user_type: 'platform_admin' }) + '.';
    let threw = false;
    try { authService.validateToken(forged); } catch { threw = true; }
    assert(threw, 'validateToken must reject an alg:none token');
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // INTEGRATION TESTS — Server Mode Behavior
  // ══════════════════════════════════════════════════════════════════════════════

  if (!dbReady) {
    console.log('\n  Skipping integration tests — test DB not available.');
    console.log('  Unit tests above still ran. Fix the DB issue and re-run.\n');
  } else {

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Integration Tests — SaaS Mode Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let saasUrl = null;
  let saasProc = null;

  try {
    await cleanupDb();
    await waitMs(500);

    // Start SaaS server (SHENMAY_DEPLOYMENT not set)
    saasProc = startServer(3101, {
      SHENMAY_DEPLOYMENT: undefined,
    });

    saasUrl = await waitForServer(3101);
    console.log(`Server started at ${saasUrl}`);

    await test('GET /api/health → 200', async () => {
      const res = await get(saasUrl, '/api/health');
      assert(res.status === 200, `Expected 200, got ${res.status}`);
    });

    await test('GET /api/config → deployment: saas', async () => {
      const res = await get(saasUrl, '/api/config');
      assert(res.status === 200);
      assert(res.body.deployment === 'saas', `Expected 'saas', got '${res.body.deployment}'`);
    });

    await test('GET /api/config → features.registration: true', async () => {
      const res = await get(saasUrl, '/api/config');
      assert(res.body.features.registration === true);
    });

    await test('GET /api/config → features.stripeBilling: true', async () => {
      const res = await get(saasUrl, '/api/config');
      assert(res.body.features.stripeBilling === true);
    });

    await test('GET /api/config → features.licenseManagement: false', async () => {
      const res = await get(saasUrl, '/api/config');
      assert(res.body.features.licenseManagement === false);
    });

    await test('POST /api/platform/auth/login without creds → 400', async () => {
      const res = await post(saasUrl, '/api/platform/auth/login', {});
      assert(res.status === 400, `Expected 400, got ${res.status}`);
    });

    await test('GET /api/platform/licenses without token → 401 (route exists)', async () => {
      const res = await get(saasUrl, '/api/platform/licenses');
      assert(res.status === 401, `Expected 401, got ${res.status}`);
    });

    await test('POST /api/license/validate → 404 (SHENMAY_LICENSE_MASTER not set)', async () => {
      const res = await post(saasUrl, '/api/license/validate', { license_key: 'test' });
      assert(res.status === 404, `Expected 404, got ${res.status}`);
    });

    await test('POST /api/onboard/register accessible (not blocked)', async () => {
      const res = await post(saasUrl, '/api/onboard/register', {
        email: 'test@example.com',
        password: 'Test123!',
        first_name: 'Test',
        company_name: 'Test Co',
      });
      // Could be 400 (validation) or 201 (success), but should NOT be 403
      assert(res.status !== 403, `Expected anything but 403, got ${res.status}`);
    });

    await stopServer(saasProc);
    saasProc = null;
  } catch (err) {
    console.error('SaaS tests error:', err.message);
    if (saasProc) await stopServer(saasProc);
  }

  // ──────────────────────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Integration Tests — Self-Hosted Mode Server');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let selfhostedUrl = null;
  let selfhostedProc = null;

  try {
    await cleanupDb();
    await waitMs(500);

    // Start self-hosted server
    selfhostedProc = startServer(3102, {
      SHENMAY_DEPLOYMENT: 'selfhosted',
      MASTER_EMAIL: 'admin@selfhosted.test',
      ADMIN_PASSWORD: 'TestPassword123!',
      TENANT_NAME: 'Self-Hosted Test',
    });

    selfhostedUrl = await waitForServer(3102);
    console.log(`Server started at ${selfhostedUrl}`);

    await test('GET /api/config → deployment: selfhosted', async () => {
      const res = await get(selfhostedUrl, '/api/config');
      assert(res.status === 200);
      assert(
        res.body.deployment === 'selfhosted',
        `Expected 'selfhosted', got '${res.body.deployment}'`
      );
    });

    await test('GET /api/config → features.registration: false', async () => {
      const res = await get(selfhostedUrl, '/api/config');
      assert(res.body.features.registration === false);
    });

    await test('GET /api/config → features.licenseManagement: true', async () => {
      const res = await get(selfhostedUrl, '/api/config');
      assert(res.body.features.licenseManagement === true);
    });

    await test('GET /api/config → features.stripeBilling: false', async () => {
      const res = await get(selfhostedUrl, '/api/config');
      assert(res.body.features.stripeBilling === false);
    });

    await test('GET /api/platform/licenses → 404 (routes disabled)', async () => {
      const res = await get(selfhostedUrl, '/api/platform/licenses');
      assert(res.status === 404, `Expected 404, got ${res.status}`);
    });

    await test('POST /api/platform/auth/login → 404 (routes disabled)', async () => {
      const res = await post(selfhostedUrl, '/api/platform/auth/login', {});
      assert(res.status === 404, `Expected 404, got ${res.status}`);
    });

    await test('POST /api/onboard/register → 403 registration_disabled', async () => {
      const res = await post(selfhostedUrl, '/api/onboard/register', {
        email: 'test@example.com',
        password: 'Test123!',
      });
      assert(res.status === 403, `Expected 403, got ${res.status}`);
      assert(res.body.error === 'registration_disabled', `Expected 'registration_disabled', got '${res.body.error}'`);
    });

    await test('POST /api/onboard/login accessible (tenant was seeded)', async () => {
      const res = await post(selfhostedUrl, '/api/onboard/login', {
        email: 'admin@selfhosted.test',
        password: 'TestPassword123!',
      });
      // Should succeed since tenant was seeded
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.token, 'Expected token in response');
    });

    await stopServer(selfhostedProc);
    selfhostedProc = null;
  } catch (err) {
    console.error('Self-hosted tests error:', err.message);
    if (selfhostedProc) await stopServer(selfhostedProc);
  }

  // ──────────────────────────────────────────────────────────────────────────────

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Integration Tests — License Master Mode');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let licenseUrl = null;
  let licenseProc = null;

  try {
    await cleanupDb();
    await waitMs(500);

    // Start license master server
    licenseProc = startServer(3103, {
      SHENMAY_DEPLOYMENT: undefined,
      SHENMAY_LICENSE_MASTER: 'true',
    });

    licenseUrl = await waitForServer(3103);
    console.log(`Server started at ${licenseUrl}`);

    await test('POST /api/license/validate without key → 400', async () => {
      const res = await post(licenseUrl, '/api/license/validate', {});
      assert(res.status === 400, `Expected 400, got ${res.status}`);
    });

    await test('POST /api/license/validate with unknown key → 403', async () => {
      const res = await post(licenseUrl, '/api/license/validate', {
        license_key: 'SHENMAY-XXXX-XXXX-XXXX-XXXX',
        instance_id: 'test-instance-1',
      });
      assert(res.status === 403, `Expected 403, got ${res.status}`);
    });

    await test('POST /api/license/trial with invalid email → 400', async () => {
      const res = await post(licenseUrl, '/api/license/trial', { email: 'not-an-email' });
      assert(res.status === 400, `Expected 400, got ${res.status}`);
    });

    let trialKey = null;
    await test('POST /api/license/trial with valid email → 201', async () => {
      const res = await post(licenseUrl, '/api/license/trial', {
        email: 'trial@example.com',
        instance_id: 'test-instance-1',
      });
      assert(res.status === 201, `Expected 201, got ${res.status}`);
      assert(res.body.trial_key, 'Expected trial_key in response');
      assert(res.body.plan === 'trial', `Expected plan 'trial', got '${res.body.plan}'`);
      trialKey = res.body.trial_key;
    });

    await test('POST /api/license/trial same email again → 200 (existing)', async () => {
      const res = await post(licenseUrl, '/api/license/trial', {
        email: 'trial@example.com',
        instance_id: 'test-instance-1',
      });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.existing === true, 'Expected existing: true');
    });

    await test('POST /api/license/validate with issued trial key → 200 valid', async () => {
      assert(trialKey, 'Trial key was not issued');
      const res = await post(licenseUrl, '/api/license/validate', {
        license_key: trialKey,
        instance_id: 'test-instance-1',
      });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.valid === true, `Expected valid: true, got ${res.body.valid}`);
      assert(res.body.plan === 'trial', `Expected plan 'trial', got '${res.body.plan}'`);
    });

    // Now test platform/licenses admin routes (requires auth)
    let platformToken = null;

    await test('POST /api/platform/auth/setup → create first platform admin', async () => {
      const res = await post(licenseUrl, '/api/platform/auth/setup', {
        name: 'Test Admin',
        email: 'admin@platform.test',
        password: 'AdminPass123!',
      });
      assert(res.status === 201, `Expected 201, got ${res.status}`);
      assert(res.body.token, 'Expected token in response');
      platformToken = res.body.token;
    });

    let issuedLicenseId = null;

    await test('POST /api/platform/licenses → issue new license', async () => {
      assert(platformToken, 'No platform token');
      const res = await post(
        licenseUrl,
        '/api/platform/licenses',
        {
          issued_to_email: 'customer@example.com',
          issued_to_name: 'Test Customer',
          plan: 'starter',
        },
        platformToken
      );
      assert(res.status === 201, `Expected 201, got ${res.status}`);
      assert(res.body.license, 'Expected license in response');
      assert(res.body.license.license_key, 'Expected license_key');
      issuedLicenseId = res.body.license.id;
    });

    await test('GET /api/platform/licenses → list all licenses', async () => {
      assert(platformToken, 'No platform token');
      const res = await get(licenseUrl, '/api/platform/licenses', platformToken);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(Array.isArray(res.body.licenses), 'Expected licenses array');
      assert(res.body.licenses.length >= 1, 'Expected at least 1 license');
    });

    await test('GET /api/platform/licenses/:id → get license detail', async () => {
      assert(platformToken, 'No platform token');
      assert(issuedLicenseId, 'No issued license ID');
      const res = await get(licenseUrl, `/api/platform/licenses/${issuedLicenseId}`, platformToken);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.license, 'Expected license in response');
      assert(res.body.license.is_active === true, 'Expected license to be active');
    });

    await test('PATCH /api/platform/licenses/:id/revoke → revoke license', async () => {
      assert(platformToken, 'No platform token');
      assert(issuedLicenseId, 'No issued license ID');
      const res = await patch(licenseUrl, `/api/platform/licenses/${issuedLicenseId}/revoke`, {}, platformToken);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.license.is_active === false, 'Expected license to be revoked');
    });

    await test('PATCH /api/platform/licenses/:id/reactivate → reactivate license', async () => {
      assert(platformToken, 'No platform token');
      assert(issuedLicenseId, 'No issued license ID');
      const res = await patch(
        licenseUrl,
        `/api/platform/licenses/${issuedLicenseId}/reactivate`,
        {},
        platformToken
      );
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.license.is_active === true, 'Expected license to be active again');
    });

    // ── Customer Portal (magic-link + session) ────────────────────────────────
    // Exercises the Shenmay-native portal at /api/public/portal/*.
    // Uses the license issued above (customer@example.com, reactivated) as the
    // "has-licenses" email. Uses an unrelated address for enumeration-defense.

    let portalSessionToken = null;

    await test('POST /api/public/portal/request-login with malformed body → 400', async () => {
      const res = await post(licenseUrl, '/api/public/portal/request-login', {});
      assert(res.status === 400, `Expected 400, got ${res.status}`);
      assert(res.body.ok === false, 'Expected ok:false');
    });

    await test('POST /api/public/portal/request-login with invalid email → 400', async () => {
      const res = await post(licenseUrl, '/api/public/portal/request-login', { email: 'not-an-email' });
      assert(res.status === 400, `Expected 400, got ${res.status}`);
      assert(res.body.error === 'invalid_email', `Expected invalid_email, got ${res.body.error}`);
    });

    await test('POST /api/public/portal/request-login for email WITH license → 200 ok + token created', async () => {
      const res = await post(licenseUrl, '/api/public/portal/request-login', {
        email: 'customer@example.com',
      });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.ok === true, 'Expected ok:true');

      // Verify a token was persisted (the email goes to stdout in dev since SMTP isn't configured)
      const { rows } = await getPool().query(
        `SELECT COUNT(*)::int AS n FROM portal_login_tokens WHERE email = $1 AND consumed_at IS NULL`,
        ['customer@example.com']
      );
      assert(rows[0].n === 1, `Expected 1 unconsumed token, got ${rows[0].n}`);
    });

    await test('POST /api/public/portal/request-login for email WITHOUT license → 200 ok + NO token (enumeration defense)', async () => {
      const res = await post(licenseUrl, '/api/public/portal/request-login', {
        email: 'stranger@example.com',
      });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.ok === true, 'Expected ok:true');

      // No token should have been created for this email
      const { rows } = await getPool().query(
        `SELECT COUNT(*)::int AS n FROM portal_login_tokens WHERE email = $1`,
        ['stranger@example.com']
      );
      assert(rows[0].n === 0, `Expected 0 tokens for stranger, got ${rows[0].n}`);
    });

    await test('POST /api/public/portal/verify with invalid token → 400', async () => {
      const res = await post(licenseUrl, '/api/public/portal/verify', {
        token: 'definitely-not-a-real-token',
      });
      assert(res.status === 400, `Expected 400, got ${res.status}`);
      assert(res.body.error === 'invalid_token', `Expected invalid_token, got ${res.body.error}`);
    });

    await test('POST /api/public/portal/verify with valid token → 200 + session_token', async () => {
      // Fetch the token we know exists for customer@example.com
      const { rows } = await getPool().query(
        `SELECT token FROM portal_login_tokens
          WHERE email = $1 AND consumed_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        ['customer@example.com']
      );
      assert(rows[0], 'Expected a token in the DB for customer@example.com');

      const res = await post(licenseUrl, '/api/public/portal/verify', {
        token: rows[0].token,
      });
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.ok === true, 'Expected ok:true');
      assert(res.body.session_token, 'Expected session_token in response');
      assert(res.body.email === 'customer@example.com', `Expected customer@example.com, got ${res.body.email}`);
      portalSessionToken = res.body.session_token;
    });

    await test('POST /api/public/portal/verify same token again → 400 (single-use)', async () => {
      const { rows } = await getPool().query(
        `SELECT token FROM portal_login_tokens
          WHERE email = $1 ORDER BY created_at DESC LIMIT 1`,
        ['customer@example.com']
      );
      const res = await post(licenseUrl, '/api/public/portal/verify', { token: rows[0].token });
      assert(res.status === 400, `Expected 400 for already-consumed token, got ${res.status}`);
    });

    await test('GET /api/public/portal/licenses without Authorization → 401 missing_auth', async () => {
      const res = await get(licenseUrl, '/api/public/portal/licenses');
      assert(res.status === 401, `Expected 401, got ${res.status}`);
      assert(res.body.error === 'missing_auth', `Expected missing_auth, got ${res.body.error}`);
    });

    await test('GET /api/public/portal/licenses with invalid Bearer → 401 invalid_session', async () => {
      const res = await get(licenseUrl, '/api/public/portal/licenses', 'bogus-session-token');
      assert(res.status === 401, `Expected 401, got ${res.status}`);
      assert(res.body.error === 'invalid_session', `Expected invalid_session, got ${res.body.error}`);
    });

    await test('GET /api/public/portal/licenses with valid session → 200 + licenses list', async () => {
      assert(portalSessionToken, 'No portal session token from verify step');
      const res = await get(licenseUrl, '/api/public/portal/licenses', portalSessionToken);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.email === 'customer@example.com', `Expected email, got ${res.body.email}`);
      assert(res.body.product === 'shenmay', `Expected product:'shenmay', got ${res.body.product}`);
      assert(Array.isArray(res.body.licenses), 'Expected licenses array');
      assert(res.body.licenses.length === 1, `Expected 1 license, got ${res.body.licenses.length}`);
      assert(res.body.licenses[0].status === 'active', `Expected active license, got ${res.body.licenses[0].status}`);
    });

    await test('POST /api/public/portal/logout → 200 ok + session revoked', async () => {
      assert(portalSessionToken, 'No portal session token');
      const res = await post(licenseUrl, '/api/public/portal/logout', {}, portalSessionToken);
      assert(res.status === 200, `Expected 200, got ${res.status}`);
      assert(res.body.ok === true, 'Expected ok:true');
    });

    await test('GET /api/public/portal/licenses after logout → 401 invalid_session', async () => {
      assert(portalSessionToken, 'No portal session token');
      const res = await get(licenseUrl, '/api/public/portal/licenses', portalSessionToken);
      assert(res.status === 401, `Expected 401 after logout, got ${res.status}`);
    });

    await stopServer(licenseProc);
    licenseProc = null;
  } catch (err) {
    console.error('License master tests error:', err.message);
    if (licenseProc) await stopServer(licenseProc);
  }

  } // end if (dbReady)

  // ══════════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════════

  // Close pool
  if (_pool) await _pool.end().catch(() => {});

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const total = passed + failed;
  console.log(`Test Results: ${passed}/${total} passed`);

  if (failed > 0) {
    console.log(`\nFailed tests (${failed}):`);
    for (const f of failures) {
      console.log(`  • ${f.name}`);
      console.log(`    ${f.message}`);
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(1);
  } else {
    console.log('All tests passed! ✓');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
