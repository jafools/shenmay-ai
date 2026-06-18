/**
 * Direct DB access for E2E specs.
 *
 * Some flows (email verification, magic-link portal, Stripe webhook) rely
 * on server-generated tokens that are normally delivered via email. Instead
 * of wiring a test inbox / mail-service, we read the tokens straight from
 * the DB. This is fast, deterministic, and matches CI needs.
 *
 * Only safe when DATABASE_URL points at a test/dev/staging DB. The
 * seed-test-admin script has a similar refuse-prod guard — we rely on that
 * same hygiene assumption here (the seed would have blown up already if
 * DATABASE_URL was prod).
 *
 * The pg pool is lazily constructed on first call and reused for the whole
 * test session. Playwright closes the Node process after its global
 * teardown, which releases connections automatically.
 */

// pg is lazily required inside getPool() so specs can `require('./db')`
// in environments that don't have DB access (e.g. onprem-e2e, which
// doesn't install server deps and relies on mode.hasDbAccess() skipping
// the DB-dependent tests). Without the lazy require, merely importing
// this module would crash the worker before any test.skip() could fire.
let pool = null;

function getPool() {
  if (pool) return pool;
  const { Pool } = require('pg');
  const connectionString =
    process.env.DATABASE_URL ||
    process.env.TEST_DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/shenmay_ai';
  pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 5_000,
    // SSL off for local/CI; prod runs through the app server which has its
    // own SSL config — tests should never hit that path.
  });
  return pool;
}

/** Run a parameterized query. */
async function query(sql, params = []) {
  const { rows } = await getPool().query(sql, params);
  return rows;
}

/**
 * Plant a known email-verification token for an unverified admin and return the
 * RAW value to submit to /verify.
 *
 * The server stores a SHA-256 *digest* of the token (it hashes on write), so the
 * raw token can no longer be read back from the DB. We therefore write a hash we
 * control and hand back its preimage. This still exercises /verify's hash-lookup
 * + JWT issuance end-to-end (the read side); the register write side — that the
 * stored value is the hash of the emailed token — is covered by the onboard
 * unit tests (tests/onboard-token-hashing.test.js).
 *
 * Returns null if no matching unverified admin exists.
 */
async function planEmailVerificationToken(email) {
  const crypto = require('crypto');
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const rows = await query(
    `UPDATE tenant_admins
        SET email_verification_token   = $2,
            email_verification_expires = NOW() + INTERVAL '24 hours'
      WHERE LOWER(email) = LOWER($1)
        AND email_verified = false
      RETURNING id`,
    [email, hash],
  );
  return rows.length ? raw : null;
}

/**
 * Look up the most recent portal magic-link token for an email.
 * Returns the raw token string; caller appends it to /license/verify?t=...
 */
async function getPortalLoginToken(email) {
  const rows = await query(
    `SELECT token
       FROM portal_login_tokens
      WHERE LOWER(email) = LOWER($1)
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at DESC
      LIMIT 1`,
    [email],
  );
  return rows[0]?.token || null;
}

/**
 * Seed a license row for a test email. Returns the generated license key.
 * Safe to call repeatedly — always issues a fresh key so each test run has
 * its own license record.
 */
async function seedLicense(email, plan = 'starter') {
  const crypto = require('crypto');
  const keyBody = crypto.randomBytes(6).toString('hex').toUpperCase();
  const key = `SHENMAY-${keyBody.slice(0, 4)}-${keyBody.slice(4, 8)}-${keyBody.slice(8, 12)}-E2E0`;
  await query(
    `INSERT INTO licenses (license_key, plan, issued_to_email, issued_to_name, is_active)
     VALUES ($1, $2, LOWER($3), 'E2E Licensee', true)
     ON CONFLICT (license_key) DO NOTHING`,
    [key, plan, email],
  );
  return key;
}

/**
 * Full cleanup of records created by a spec run. Call from `afterAll` in
 * each spec that creates tenants / licenses.
 *
 * Deletes tenants + admins + subscriptions + licenses matching `%${suffix}%`
 * on email / name. Cascades take care of dependent rows.
 */
async function cleanupBySuffix(suffix) {
  if (!suffix || suffix.length < 4) {
    throw new Error('cleanupBySuffix requires a >=4-char disambiguator to avoid wiping unrelated rows');
  }
  const wildcard = `%${suffix}%`;
  await query(`DELETE FROM licenses        WHERE issued_to_email LIKE $1`, [wildcard]);
  await query(`DELETE FROM portal_login_tokens WHERE email LIKE $1`, [wildcard]);
  await query(`DELETE FROM portal_sessions     WHERE email LIKE $1`, [wildcard]);
  // Tenants cascade to admins + subscriptions + customers + everything else.
  await query(`DELETE FROM tenants          WHERE slug LIKE $1 OR name LIKE $1`, [wildcard]);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  query,
  planEmailVerificationToken,
  getPortalLoginToken,
  seedLicense,
  cleanupBySuffix,
  close,
};
