/**
 * SHENMAY AI — Self-Hosted License Service
 *
 * Behaviour matrix:
 *
 *   NODE_ENV != 'production'                → skip (dev free pass)
 *   SHENMAY_DEPLOYMENT != 'selfhosted'      → skip (SaaS VPS — not our concern)
 *   selfhosted + no SHENMAY_LICENSE_KEY     → trial mode (local limits, no cloud call)
 *   selfhosted + key present, valid         → apply plan limits; schedule 24h heartbeat
 *   selfhosted + key present, invalid       → log error + exit(1)
 *   heartbeat fails (transient network)     → warn only, do NOT crash running instance
 *
 * Shared shapes
 * -------------
 *
 * @typedef {"trial"|"starter"|"growth"|"professional"|"enterprise"|"master"} LicensePlan
 *
 * @typedef {Object} ValidateResponse
 * @property {true}         valid
 * @property {LicensePlan}  plan
 * @property {string|null}  [expires_at]  ISO 8601 timestamp (or null for perpetual).
 *
 * @typedef {Object} ActivateResult
 * @property {LicensePlan}  plan
 * @property {string|null}  [expires_at]
 *
 * @typedef {Object} LicenseStatus
 * @property {boolean}      has_license       True when any key is pinned (env or DB).
 * @property {string|null}  key_masked        First 12 + last 4 of the key, or null.
 * @property {LicensePlan}  plan              Current plan (falls back to "trial").
 * @property {number|null}  max_messages_month
 * @property {number|null}  max_customers
 * @property {string|null}  validated_at      ISO timestamp of last successful heartbeat.
 * @property {boolean}      env_var_in_use    True if SHENMAY_LICENSE_KEY is set in env.
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const { PLAN_LIMITS, isSelfHosted } = require('../config/plans');
const { envVar } = require('../utils/env');

const VALIDATE_URL = envVar('LICENSE_VALIDATE_URL',
  'https://api.pontensolutions.com/api/license/validate');

const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Stable identifier for this self-hosted install, resolved lazily and cached.
//
// Precedence:
//   1. SHENMAY_INSTANCE_ID env pin — operator-controlled, absolute. Lets an
//      operator carry one id across server moves, or pin it in air-gapped setups.
//   2. Persisted random id (instance_identity table, migration 045) — generated
//      ONCE on first boot and reused across restarts AND domain changes.
//
// Why not derive it from LICENSE_KEY/APP_URL/process.pid (the pre-T9 formula)?
// process.pid changes every restart (node isn't PID 1 under the `migrate &&
// server` shell CMD) and APP_URL changes when an operator goes live — both
// rebind against the master and hard-lock the customer in a crash-loop (audit
// M4). A persisted random id is stable for the life of the install while staying
// unique per install: a key copied to a *fresh* DB gets a new id, so the master
// still rejects the second instance and a deliberate move goes through the
// admin-only unbind endpoint (see docs/RUNBOOK-LICENSE-REBIND.md).
let _heartbeatTimer = null;
let _instanceIdCache = null;

/**
 * Resolve this install's stable instance id (see precedence above). Cached after
 * the first successful resolution. Only ever called on the self-hosted path
 * (checkLicenseOnStartup / scheduleHeartbeat / activateLicense), where the DB and
 * migration 045 are already up.
 * @returns {Promise<string>}
 */
async function getInstanceId() {
  if (_instanceIdCache) return _instanceIdCache;

  const pinned = envVar('INSTANCE_ID');
  if (pinned) {
    _instanceIdCache = pinned;
    return _instanceIdCache;
  }

  try {
    const db = require('../db');
    // Get-or-create the single identity row. The DO UPDATE (no-op self-assign)
    // makes RETURNING yield the existing id on conflict, so concurrent first
    // boots converge on one value without a second round-trip.
    const generated = crypto.randomBytes(16).toString('hex').slice(0, 16);
    const { rows } = await db.query(
      `INSERT INTO instance_identity (id, instance_id)
            VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET instance_id = instance_identity.instance_id
         RETURNING instance_id`,
      [generated]
    );
    _instanceIdCache = rows[0].instance_id;
    return _instanceIdCache;
  } catch (err) {
    // DB unreachable, or 045 not yet applied (e.g. `node server` run without
    // migrating on a dev box). Degrade to a key-derived, restart-stable id so we
    // never crash on identity resolution alone and never churn the bind. NOT
    // cached, so the next call retries the DB and picks up the persisted random.
    console.warn(`[License] Could not read persisted instance id (${err.message}); using key-derived fallback.`);
    return crypto.createHash('sha256')
      .update(envVar('LICENSE_KEY') || '')
      .digest('hex')
      .slice(0, 16);
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

/**
 * POST a JSON body and parse the JSON response.
 * @param {string} url
 * @param {Object} body  JSON-serialisable request body.
 * @returns {Promise<{ status: number, body: Object }>} Parsed body is `{}` on
 *   non-JSON responses (never throws on parse errors).
 */
function post(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent':     'shenmay-selfhosted/1.0',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('License validation timed out')); });
    req.write(payload);
    req.end();
  });
}

// ── Cloud validation call ─────────────────────────────────────────────────────

/**
 * Call the license master's /validate endpoint.
 *
 * @param   {string} licenseKey  Trimmed license key.
 * @returns {Promise<ValidateResponse>}
 * @throws  {Error} `License invalid: <reason>` — caller MUST treat messages
 *          containing "License key not found" / "revoked" / "expired" /
 *          "already bound" as DEFINITIVE (see {@link isDefinitiveFailure}).
 *          All other throws are transient (network, 5xx).
 */
async function callValidate(licenseKey) {
  const { status, body } = await post(VALIDATE_URL, {
    license_key: licenseKey,
    instance_id: await getInstanceId(),
  });

  // Narrow the validated-response shape before returning — everything else
  // becomes a definitive failure the caller can branch on.
  if (status === 200 && body && body.valid === true && typeof body.plan === 'string') {
    return {
      valid:      true,
      plan:       body.plan,
      expires_at: body.expires_at ?? null,
    };
  }

  const reason = (body && body.error) || `HTTP ${status}`;
  throw new Error(`License invalid: ${reason}`);
}

// ── Apply plan limits to the local DB ─────────────────────────────────────────
// Upserts the subscription row for the single self-hosted tenant so the
// existing subscription middleware enforces the correct limits.

/**
 * Apply the limits for `plan` to the single self-hosted tenant's
 * subscription row. Swallows DB errors (only warns).
 * @param {LicensePlan} plan
 * @returns {Promise<void>}
 */
async function applyPlanLimits(plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
  try {
    const db = require('../db');
    // Self-hosted is always BYOK — the tenant's API key is stored encrypted
    // on the tenant row. The "managed AI" concept only applies to SaaS where
    // the platform provides the key. Forcing false here prevents growth+ plans
    // from breaking LLM calls on self-hosted (resolveApiKey would otherwise
    // try process.env.ANTHROPIC_API_KEY and fail).
    await db.query(
      `UPDATE subscriptions
       SET plan                  = $1,
           max_messages_month    = $2,
           max_customers         = $3,
           managed_ai_enabled    = false,
           max_agents            = $4,
           status                = 'active',
           updated_at            = NOW()
       WHERE tenant_id = (SELECT id FROM tenants ORDER BY created_at LIMIT 1)`,
      [plan, limits.max_messages_month, limits.max_customers, limits.max_agents]
    );
    console.log(`[License] Plan limits applied: ${plan} (${limits.max_messages_month} msg/mo, ${limits.max_customers} customers)`);
  } catch (err) {
    console.warn('[License] Could not upsert subscription limits:', err.message);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
//
// Definitive failure (revoked / expired / not found / instance bind mismatch)
// REVERTS the local subscription to trial limits — protects against a customer
// letting their license lapse while still enjoying paid limits.
//
// Transient failure (network timeout, 5xx) just logs a warning. The heartbeat
// retries every 24h; we don't want a 30-second blip to demote a paying customer.

const DEFINITIVE_FAILURE_PATTERNS = [
  'License key not found',
  'License has been revoked',
  'License has expired',
  'License key is already bound',
];

function isDefinitiveFailure(errMessage) {
  return DEFINITIVE_FAILURE_PATTERNS.some(p => errMessage.includes(p));
}

function scheduleHeartbeat(licenseKey) {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);

  _heartbeatTimer = setInterval(async () => {
    try {
      const result = await callValidate(licenseKey);
      console.log(`[License] Heartbeat OK — plan: ${result.plan}`);
      await applyPlanLimits(result.plan);
      // Track last successful validation on the tenant row (best-effort).
      try {
        const db = require('../db');
        await db.query(
          `UPDATE tenants SET license_key_validated_at = NOW() WHERE license_key = $1`,
          [licenseKey]
        );
      } catch { /* tenant column may not exist on pre-migration installs — non-fatal */ }
    } catch (err) {
      if (isDefinitiveFailure(err.message)) {
        console.warn(`[License] Heartbeat: license is no longer valid — reverting to trial. Reason: ${err.message}`);
        await applyPlanLimits('trial');
        // Don't clear the key. Owner sees status in dashboard and can reactivate.
      } else {
        console.warn(`[License] Heartbeat failed (transient?): ${err.message}`);
        console.warn('[License] Server continues running. Will retry in 24h.');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);

  if (_heartbeatTimer.unref) _heartbeatTimer.unref();
}

function clearHeartbeat() {
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
}

// ── Startup check ─────────────────────────────────────────────────────────────

async function checkLicenseOnStartup() {
  // Not production → skip entirely
  if (process.env.NODE_ENV !== 'production') return;

  // SaaS VPS → skip (license enforcement is for self-hosted only)
  if (!isSelfHosted()) return;

  // Precedence: env var > DB column > trial mode.
  // Env var lets operators pin a key in .env (the original behaviour).
  // DB column lets owners activate from the dashboard without restart.
  let licenseKey = envVar('LICENSE_KEY');
  let keySource  = 'env';

  if (!licenseKey) {
    // Try DB. Wrapped in try/catch because the column was added in migration
    // 030; a server starting up before that migration runs would throw here.
    try {
      const db = require('../db');
      const { rows } = await db.query(
        `SELECT license_key FROM tenants
         WHERE license_key IS NOT NULL
         ORDER BY created_at LIMIT 1`
      );
      if (rows.length > 0) {
        licenseKey = rows[0].license_key;
        keySource  = 'db';
      }
    } catch { /* column missing → fall through to trial */ }
  }

  if (!licenseKey) {
    // ── Trial mode ───────────────────────────────────────────────────────────
    // No key required to start the trial. Limits are enforced via the
    // subscription row seeded by seedSelfHostedTenant (20 msg, 1 customer).
    console.log('[License] No license key — running in self-hosted trial mode.');
    console.log('[License]   Limits: 20 messages/mo, 1 customer.');
    const appUrl = (process.env.APP_URL || 'https://shenmay.ai').replace(/\/$/, '');
    console.log(`[License]   Upgrade: ${appUrl}/license`);
    return;
  }

  // ── Paid mode ────────────────────────────────────────────────────────────
  console.log(`[License] Validating license key from ${keySource} (instance ${await getInstanceId()})…`);
  try {
    const result = await callValidate(licenseKey);
    const expiry = result.expires_at
      ? `expires ${new Date(result.expires_at).toDateString()}`
      : 'no expiry';
    console.log(`[License] ✓ Valid — plan: ${result.plan}, ${expiry}`);
    await applyPlanLimits(result.plan);
    scheduleHeartbeat(licenseKey);
  } catch (err) {
    console.error(`[License] Validation failed: ${err.message}`);
    if (keySource === 'db') {
      // Dashboard-activated key turned out to be invalid (revoked, expired,
      // network down on first boot, etc). Don't crash — fall back to trial
      // limits and let the owner reactivate from the dashboard.
      console.warn('[License] Falling back to trial limits. Reactivate from /dashboard/plans.');
      try { await applyPlanLimits('trial'); } catch { /* best-effort */ }
    } else {
      // Env-var path stays strict: an invalid key in .env is almost certainly
      // operator error and should fail loud rather than silently downgrade.
      console.error('[License] Check SHENMAY_LICENSE_KEY and internet connectivity.');
      console.error('[License] Refusing to start.');
      process.exit(1);
    }
  }
}

// ── Dashboard activation helpers ──────────────────────────────────────────────
//
// activateLicense / deactivateLicense are called by the portal route to let
// the owner manage their license without editing .env or restarting Docker.
//
// Both run synchronously against the master and apply changes immediately;
// the existing subscription middleware reads from the DB on every request,
// so limits flip on the very next API call.

/**
 * Validate a license key against the master, persist it to the tenant row,
 * apply paid limits immediately, and schedule a 24h heartbeat.
 *
 * @param   {string} licenseKey  Raw user-entered key (trimmed internally).
 * @param   {string} tenantId    UUID of the single self-hosted tenant.
 * @returns {Promise<ActivateResult>}
 * @throws  {Error} Propagates the master's validation error (e.g.
 *          "License invalid: License has expired") so the route can
 *          surface the reason to the dashboard.
 */
async function activateLicense(licenseKey, tenantId) {
  if (!licenseKey || typeof licenseKey !== 'string') {
    throw new Error('License key is required');
  }
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required');
  }
  const trimmed = licenseKey.trim();

  // 1. Validate with the master. Throws on invalid (caller should surface
  //    the original error message — these are user-friendly already).
  const result = await callValidate(trimmed);

  // 2. Persist to tenant row so future restarts pick it up.
  const db = require('../db');
  await db.query(
    `UPDATE tenants
     SET license_key              = $1,
         license_key_validated_at = NOW()
     WHERE id = $2`,
    [trimmed, tenantId]
  );

  // 3. Apply limits immediately — no restart required.
  await applyPlanLimits(result.plan);

  // 4. Start heartbeat so revocation / expiry get caught within 24h.
  scheduleHeartbeat(trimmed);

  console.log(`[License] Dashboard-activated key for tenant ${tenantId} — plan: ${result.plan}`);
  return { plan: result.plan, expires_at: result.expires_at };
}

/**
 * Clear the tenant's license key, stop the heartbeat, and revert to trial
 * limits. Safe to call even when no key is pinned.
 *
 * @param   {string} tenantId
 * @returns {Promise<void>}
 */
async function deactivateLicense(tenantId) {
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required');
  }
  const db = require('../db');
  await db.query(
    `UPDATE tenants
     SET license_key              = NULL,
         license_key_validated_at = NULL
     WHERE id = $1`,
    [tenantId]
  );
  await applyPlanLimits('trial');
  clearHeartbeat();
  console.log(`[License] License deactivated for tenant ${tenantId} — back to trial limits.`);
}

/**
 * Read the licence + plan state for a tenant, with the key MASKED so the
 * dashboard can display it without exposing the secret.
 *
 * @param   {string} tenantId
 * @returns {Promise<LicenseStatus|null>} Null if the tenant row doesn't exist.
 */
async function getLicenseStatus(tenantId) {
  const db = require('../db');
  const { rows } = await db.query(
    `SELECT t.license_key, t.license_key_validated_at,
            s.plan, s.max_messages_month, s.max_customers
     FROM tenants t
     LEFT JOIN subscriptions s ON s.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId]
  );
  if (rows.length === 0) return null;

  const r   = rows[0];
  const key = r.license_key;
  // Mask all but first 12 + last 4 chars; very short keys just show ****
  const masked = key
    ? (key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : '****')
    : null;

  return {
    has_license:           !!key,
    key_masked:            masked,
    plan:                  r.plan || 'trial',
    max_messages_month:    r.max_messages_month,
    max_customers:         r.max_customers,
    validated_at:          r.license_key_validated_at,
    env_var_in_use:        !!envVar('LICENSE_KEY'),
  };
}

module.exports = {
  checkLicenseOnStartup,
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  getInstanceId,
};
