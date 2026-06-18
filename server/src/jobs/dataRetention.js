/**
 * SHENMAY AI — Data Retention Cron Job
 *
 * Runs once on server startup, then every 24 hours.
 *
 * What it does:
 *
 * 1. MESSAGE BODY PURGE
 *    Deletes raw message content for conversations older than the tenant's
 *    message_retention_days setting (default 730 days / 2 years).
 *    Conversation metadata (started_at, ended_at, summary, topics) is kept
 *    for analytics — only the message bodies are removed.
 *    This is the "pseudonymisation" approach endorsed by GDPR Recital 26.
 *
 * 2. ANONYMOUS SESSION PURGE
 *    Fully deletes customer records for anonymous widget visitors (email
 *    ends with @visitor.shenmay) that have not interacted within
 *    anon_session_ttl_days (default 30 days).
 *    Anonymous visitors have no contractual relationship — there is no basis
 *    to retain their data indefinitely.
 *
 * 3. PENDING DELETION QUEUE
 *    Completes erasure for customers with deletion_requested_at set but not
 *    yet anonymized_at. Anonymisation replaces all PII with placeholder values
 *    while keeping the customer row for referential integrity.
 *
 * 4. HOUSEKEEPING TABLE PRUNE
 *    Trims unbounded operational tables that otherwise grow forever. These
 *    hold transient state with no analytics or compliance value past their
 *    useful window, so we delete (not anonymise) rows older than a
 *    conservative, env-overridable retention window:
 *      - notifications          → older than NOTIFICATION_RETENTION_DAYS (90d)
 *      - portal_login_tokens     → expired past PORTAL_TOKEN_RETENTION_DAYS (7d)
 *      - portal_sessions         → expired past PORTAL_SESSION_RETENTION_DAYS (30d)
 *      - processed_stripe_events → older than STRIPE_EVENT_RETENTION_DAYS (90d)
 *    The Stripe ledger window stays well clear of Stripe's ~3-day retry horizon
 *    so replay protection for any event Stripe could still redeliver is intact.
 *    Login tokens / sessions are pruned on their own expires_at, never on rows
 *    still inside their TTL.
 *
 * What it does NOT do:
 *   - Touch audit_logs (legally required 7-year retention)
 *   - Touch conversations metadata (summary, topics, sentiment)
 *   - Run on a per-tenant schedule (runs globally across all tenants)
 *
 * Logging:
 *   All purge events are written to audit_logs with actor_type = 'system'.
 */

const db = require('../db');
const { writeAuditLog } = require('../middleware/auditLog');
const { anonEmailIlikeMatch } = require('../constants/anonDomains');

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function runRetentionCycle() {
  const startedAt = new Date();
  console.log(`[DataRetention] Starting retention cycle at ${startedAt.toISOString()}`);

  try {
    await resetExpiredUsage();
  } catch (err) {
    console.error('[DataRetention] Usage reset error:', err.message);
  }

  try {
    await purgeMessageBodies();
  } catch (err) {
    console.error('[DataRetention] Message body purge error:', err.message);
  }

  try {
    await purgeAnonymousSessions();
  } catch (err) {
    console.error('[DataRetention] Anonymous session purge error:', err.message);
  }

  try {
    await processErasureQueue();
  } catch (err) {
    console.error('[DataRetention] Erasure queue error:', err.message);
  }

  try {
    await purgeHousekeepingTables();
  } catch (err) {
    console.error('[DataRetention] Housekeeping prune error:', err.message);
  }

  const durationMs = Date.now() - startedAt.getTime();
  console.log(`[DataRetention] Cycle complete in ${durationMs}ms`);
}

// ── 1. MESSAGE BODY PURGE ─────────────────────────────────────────────────────

async function purgeMessageBodies() {
  // Load per-tenant retention settings
  const { rows: tenants } = await db.query(
    `SELECT id, name, COALESCE(message_retention_days, 730) AS retention_days
     FROM tenants WHERE is_active = true`
  );

  let totalPurged = 0;

  for (const tenant of tenants) {
    // Find conversations for this tenant that are:
    //   - Older than retention_days
    //   - Not already purged
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - tenant.retention_days);

    const { rows: conversations } = await db.query(
      `SELECT co.id
       FROM conversations co
       JOIN customers c ON co.customer_id = c.id
       WHERE c.tenant_id = $1
         AND co.started_at < $2
         AND co.messages_purged_at IS NULL`,
      [tenant.id, cutoff.toISOString()]
    );

    if (conversations.length === 0) continue;

    const convIds = conversations.map(c => c.id);

    // Delete message bodies
    const { rowCount } = await db.query(
      `DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])`,
      [convIds]
    );

    // Mark conversations as purged
    await db.query(
      `UPDATE conversations SET messages_purged_at = NOW()
       WHERE id = ANY($1::uuid[])`,
      [convIds]
    );

    totalPurged += rowCount;

    writeAuditLog({
      actorType  : 'system',
      tenantId   : tenant.id,
      eventType  : 'retention.messages_purged',
      resourceType: 'messages',
      description: `Purged ${rowCount} messages from ${conversations.length} conversations older than ${tenant.retention_days} days`,
      success    : true,
    });

    console.log(`[DataRetention] Tenant ${tenant.name}: purged ${rowCount} messages from ${conversations.length} conversations`);
  }

  if (totalPurged > 0) {
    console.log(`[DataRetention] Total message bodies purged: ${totalPurged}`);
  }
}

// ── 2. ANONYMOUS SESSION PURGE ────────────────────────────────────────────────

async function purgeAnonymousSessions() {
  // Load per-tenant anon TTL settings
  const { rows: tenants } = await db.query(
    `SELECT id, name, COALESCE(anon_session_ttl_days, 30) AS anon_ttl
     FROM tenants WHERE is_active = true`
  );

  let totalDeleted = 0;

  for (const tenant of tenants) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - tenant.anon_ttl);

    // Find anonymous customers who haven't interacted since cutoff
    // Anonymous customers have email ending in @visitor.shenmay
    const { rows: anonCustomers } = await db.query(
      `SELECT id FROM customers
       WHERE tenant_id = $1
         AND ${anonEmailIlikeMatch()}
         AND (last_interaction_at < $2 OR last_interaction_at IS NULL)
         AND created_at < $2`,
      [tenant.id, cutoff.toISOString()]
    );

    if (anonCustomers.length === 0) continue;

    const customerIds = anonCustomers.map(c => c.id);

    // Cascade delete (conversations + messages cascade via FK ON DELETE CASCADE)
    const { rowCount } = await db.query(
      `DELETE FROM customers WHERE id = ANY($1::uuid[])`,
      [customerIds]
    );

    totalDeleted += rowCount;

    writeAuditLog({
      actorType  : 'system',
      tenantId   : tenant.id,
      eventType  : 'retention.anon_sessions_purged',
      resourceType: 'customers',
      description: `Deleted ${rowCount} anonymous sessions older than ${tenant.anon_ttl} days`,
      success    : true,
    });

    console.log(`[DataRetention] Tenant ${tenant.name}: deleted ${rowCount} anonymous sessions`);
  }

  if (totalDeleted > 0) {
    console.log(`[DataRetention] Total anonymous sessions deleted: ${totalDeleted}`);
  }
}

// ── 3. ERASURE QUEUE PROCESSOR ────────────────────────────────────────────────
//
// Processes customers with deletion_requested_at set.
// GDPR requires erasure within 30 days of request (Article 17).
// We process the queue daily and immediately on explicit requests.
//
// "Anonymisation" approach:
//   - PII fields (name, email, phone, date_of_birth, location) → placeholder
//   - memory_file and soul_file → empty object
//   - customer_data records → deleted
//   - password_hash → null (account deactivated)
//   - is_active → false
//   - anonymized_at → NOW()
//
// Conversation metadata (started_at) and audit logs are kept for legal +
// analytics purposes. summary + topics_covered ARE scrubbed (step 4b) because
// they are LLM-generated recaps that embed the customer's name and discussion
// specifics in plaintext — they would otherwise survive an Article-17 erasure.

async function processErasureQueue() {
  const { rows: pendingDeletions } = await db.query(
    `SELECT c.id, c.tenant_id, c.first_name, c.last_name, c.email
     FROM customers c
     WHERE c.deletion_requested_at IS NOT NULL
       AND c.anonymized_at IS NULL
     ORDER BY c.deletion_requested_at ASC
     LIMIT 100`  // process max 100 per cycle to avoid long locks
  );

  if (pendingDeletions.length === 0) return;

  console.log(`[DataRetention] Processing ${pendingDeletions.length} erasure requests`);

  for (const customer of pendingDeletions) {
    try {
      await anonymizeCustomer(customer.id, customer.tenant_id, 'system');
    } catch (err) {
      console.error(`[DataRetention] Failed to anonymize customer ${customer.id}:`, err.message);
    }
  }
}

/**
 * Anonymize a single customer record (shared by the cron job and the
 * portal DELETE endpoint so logic is in one place).
 *
 * @param {string} customerId
 * @param {string} tenantId
 * @param {string} requestedBy — 'system' | advisor UUID | customer UUID
 */
async function anonymizeCustomer(customerId, tenantId, requestedBy) {
  const anonName  = '[deleted]';
  const anonEmail = `deleted_${customerId}@anonymized.shenmay`;

  // 1. Anonymise PII on the customer row
  await db.query(
    `UPDATE customers SET
       first_name        = $1,
       last_name         = $1,
       name              = $1,
       email             = $2,
       phone             = NULL,
       date_of_birth     = NULL,
       location          = NULL,
       password_hash     = NULL,
       memory_file       = '{}'::jsonb,
       soul_file         = '{}'::jsonb,
       is_active         = false,
       anonymized_at     = NOW()
     WHERE id = $3`,
    [anonName, anonEmail, customerId]
  );

  // 2. Delete structured customer data (financial records, etc.)
  await db.query(
    `DELETE FROM customer_data WHERE customer_id = $1`,
    [customerId]
  );

  // 3. Delete flags (contain PII in description field)
  await db.query(
    `DELETE FROM flags WHERE customer_id = $1`,
    [customerId]
  );

  // 3b. Delete PII breach-log rows for this customer. The audit log must not
  // outlive an erasure request — closes the GDPR Art.17 gap where breach-log
  // findings tied to an erased customer were otherwise retained indefinitely.
  await db.query(
    `DELETE FROM pii_breach_log WHERE customer_id = $1`,
    [customerId]
  );

  // 4. Anonymise message content but keep conversation metadata
  await db.query(
    `UPDATE messages m
     SET content = '[message deleted — data erasure request]',
         metadata = '{}'::jsonb
     FROM conversations co
     WHERE m.conversation_id = co.id
       AND co.customer_id = $1`,
    [customerId]
  );

  // 4b. Scrub conversation summaries + topics. These are LLM-generated recaps
  // (e.g. "Conversation with Jane about her retirement timeline…") written as
  // plaintext — unlike memory_file/soul_file, which are encrypted then wiped in
  // step 1. Without this they survive erasure and surface in the portal's
  // conversation history. Closes the remaining Art.17 gap (sister to step 3b).
  await db.query(
    `UPDATE conversations
       SET summary        = NULL,
           topics_covered = '[]'::jsonb
     WHERE customer_id = $1`,
    [customerId]
  );

  writeAuditLog({
    actorType  : requestedBy === 'system' ? 'system' : 'advisor',
    actorId    : requestedBy === 'system' ? null : requestedBy,
    tenantId,
    customerId,
    eventType  : 'customer.anonymized',
    resourceType: 'customer',
    resourceId : customerId,
    description: `Customer record anonymized (GDPR erasure). Requested by: ${requestedBy}`,
    success    : true,
  });

  console.log(`[DataRetention] Anonymized customer ${customerId}`);
}

// ── 4. MONTHLY USAGE RESET ────────────────────────────────────────────────────
//
// Zeroes messages_used_this_month a month after each subscription's last reset.
// The trigger is usage_reset_at (NOT NULL, defaults to NOW(), bumped on every
// reset) — NOT current_period_end, which trial/free and self-hosted rows are
// seeded with as NULL, so the old `current_period_end <= NOW()` predicate never
// matched them (NULL <= NOW() is never true).
//
//   • SaaS PAID plans are reset by the Stripe `invoice.paid` webhook on the real
//     billing cycle — we must NOT touch them here or the two resets would fight.
//   • SaaS trial/free plans have no Stripe subscription, so invoice.paid never
//     fires for them. Without this job their counter never resets and they are
//     permanently capped after the first month's allowance. (The bug this fixes.)
//   • Self-hosted has no Stripe at all, so every active subscription resets here.
//
async function resetExpiredUsage() {
  const { isSelfHosted } = require('../config/plans');

  // On SaaS, scope the reset to trial/free — paid plans belong to Stripe's
  // invoice.paid. On self-hosted (single-tenant, no Stripe) every active sub
  // resets. planScope is a static fragment chosen by deployment mode, never
  // user input, so interpolating it is injection-safe.
  const planScope = isSelfHosted() ? '' : `AND plan IN ('trial', 'free')`;

  const { rowCount } = await db.query(
    `UPDATE subscriptions
        SET messages_used_this_month = 0,
            usage_reset_at           = NOW()
      WHERE status = 'active'
        AND usage_reset_at <= NOW() - INTERVAL '1 month'
        ${planScope}`
  );

  if (rowCount > 0) {
    console.log(`[DataRetention] Reset monthly usage for ${rowCount} subscription(s)`);
  }
}

// ── 5. HOUSEKEEPING TABLE PRUNE ───────────────────────────────────────────────
//
// Several operational tables accumulate transient rows that are never cleaned
// up at write time, so they grow without bound. None hold analytics or
// compliance value past their useful window (audit_logs, which IS legally
// retained, is deliberately NOT in this list). We delete — not anonymise —
// rows past a conservative, env-overridable retention window.
//
// Windows are expressed in whole days and clamped to a sane floor so a typo'd
// env var can never widen the window to 0 (which would prune live rows) or go
// negative. Each spec deletes on the column that actually governs the row's
// usefulness: created_at for notifications, expires_at for the auth tokens /
// sessions (never their created_at — a long-lived session is still valid until
// it expires), processed_at for the Stripe ledger.

// Conservative defaults (days). Overridable per deployment via env.
const NOTIFICATION_RETENTION_DAYS    = parseRetentionDays('NOTIFICATION_RETENTION_DAYS', 90);
const PORTAL_TOKEN_RETENTION_DAYS    = parseRetentionDays('PORTAL_TOKEN_RETENTION_DAYS', 7);
const PORTAL_SESSION_RETENTION_DAYS  = parseRetentionDays('PORTAL_SESSION_RETENTION_DAYS', 30);
const STRIPE_EVENT_RETENTION_DAYS    = parseRetentionDays('STRIPE_EVENT_RETENTION_DAYS', 90);

/**
 * Read a whole-day retention window from an env var, falling back to a default
 * and clamping to a floor of 1 day so a malformed/zero/negative value can never
 * cause live rows to be pruned. Pure — no I/O, safe to unit-test.
 *
 * @param {string} envVar       — process.env key to read
 * @param {number} defaultDays  — fallback when unset/invalid
 * @param {Object} [env]        — env source (defaults to process.env; injectable for tests)
 * @returns {number} clamped integer day count (>= 1)
 */
function parseRetentionDays(envVar, defaultDays, env = process.env) {
  const raw = parseInt(env[envVar], 10);
  const days = Number.isFinite(raw) && raw > 0 ? raw : defaultDays;
  return Math.max(1, days);
}

/**
 * Build the ordered list of housekeeping prune specs. Pure — returns the exact
 * table / parameterized SQL / params / window for each prune so the SQL and the
 * retention windows can be unit-tested without a database. Each cutoff is
 * `now - <windowDays>` computed once for a stable, testable result.
 *
 * The DELETE predicates are all `<column> < $1` with a single timestamp param,
 * so they are fully parameterized (no string interpolation of any value).
 *
 * @param {Object} [opts]
 * @param {Date}   [opts.now]   — reference "now" (defaults to new Date(); injectable for tests)
 * @param {Object} [opts.days]  — { notification, portalToken, portalSession, stripeEvent } overrides
 * @returns {Array<{label,table,eventType,resourceType,sql,params,windowDays}>}
 */
function buildHousekeepingPrunes({ now = new Date(), days = {} } = {}) {
  const win = {
    notification : days.notification  ?? NOTIFICATION_RETENTION_DAYS,
    portalToken  : days.portalToken   ?? PORTAL_TOKEN_RETENTION_DAYS,
    portalSession: days.portalSession ?? PORTAL_SESSION_RETENTION_DAYS,
    stripeEvent  : days.stripeEvent   ?? STRIPE_EVENT_RETENTION_DAYS,
  };

  const cutoff = (windowDays) => {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - windowDays);
    return d.toISOString();
  };

  return [
    {
      // In-app advisor notifications. The portal only ever shows the latest 30,
      // so anything older than the window is already invisible. Pruned on
      // created_at — read/unread state is irrelevant once the row is this old.
      label       : 'notifications',
      table       : 'notifications',
      eventType   : 'retention.notifications_purged',
      resourceType: 'notifications',
      windowDays  : win.notification,
      sql         : `DELETE FROM notifications WHERE created_at < $1`,
      params      : [cutoff(win.notification)],
    },
    {
      // Single-use magic-link tokens (15-min TTL). Pruned only once they have
      // been expired for the window — never while still inside expires_at.
      label       : 'portal_login_tokens',
      table       : 'portal_login_tokens',
      eventType   : 'retention.portal_tokens_purged',
      resourceType: 'portal_login_tokens',
      windowDays  : win.portalToken,
      sql         : `DELETE FROM portal_login_tokens WHERE expires_at < $1`,
      params      : [cutoff(win.portalToken)],
    },
    {
      // Authenticated portal sessions (30-day TTL). Pruned on expires_at so a
      // still-valid long-lived session is never cut short; only sessions that
      // expired more than the window ago are removed.
      label       : 'portal_sessions',
      table       : 'portal_sessions',
      eventType   : 'retention.portal_sessions_purged',
      resourceType: 'portal_sessions',
      windowDays  : win.portalSession,
      sql         : `DELETE FROM portal_sessions WHERE expires_at < $1`,
      params      : [cutoff(win.portalSession)],
    },
    {
      // Stripe webhook idempotency ledger (#200/#214). Stripe never retries a
      // webhook beyond ~3 days, so a 90-day default keeps replay protection for
      // every event Stripe could still redeliver while letting old ids drop.
      label       : 'processed_stripe_events',
      table       : 'processed_stripe_events',
      eventType   : 'retention.stripe_events_purged',
      resourceType: 'processed_stripe_events',
      windowDays  : win.stripeEvent,
      sql         : `DELETE FROM processed_stripe_events WHERE processed_at < $1`,
      params      : [cutoff(win.stripeEvent)],
    },
  ];
}

/**
 * Execute the housekeeping prunes. Cross-tenant / global tables, so each prune
 * runs once (no per-tenant loop) and logs a single system audit row. Failures
 * in one prune are caught so the rest still run.
 */
async function purgeHousekeepingTables() {
  const prunes = buildHousekeepingPrunes();
  let totalDeleted = 0;

  for (const prune of prunes) {
    try {
      const { rowCount } = await db.query(prune.sql, prune.params);
      if (rowCount === 0) continue;

      totalDeleted += rowCount;

      writeAuditLog({
        actorType   : 'system',
        eventType   : prune.eventType,
        resourceType: prune.resourceType,
        description : `Pruned ${rowCount} ${prune.label} rows older than ${prune.windowDays} days`,
        success     : true,
      });

      console.log(`[DataRetention] Pruned ${rowCount} ${prune.label} rows older than ${prune.windowDays} days`);
    } catch (err) {
      console.error(`[DataRetention] Failed to prune ${prune.label}:`, err.message);
    }
  }

  if (totalDeleted > 0) {
    console.log(`[DataRetention] Total housekeeping rows pruned: ${totalDeleted}`);
  }
}

// ── Module exports ────────────────────────────────────────────────────────────

let _timer = null;

function start() {
  console.log('[DataRetention] Cron job starting — will run every 24 hours');

  // Run immediately on startup (catches any backlog from downtime)
  runRetentionCycle().catch(err =>
    console.error('[DataRetention] Initial cycle failed:', err.message)
  );

  // Then every 24 hours
  _timer = setInterval(() => {
    runRetentionCycle().catch(err =>
      console.error('[DataRetention] Scheduled cycle failed:', err.message)
    );
  }, INTERVAL_MS);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
    console.log('[DataRetention] Cron job stopped');
  }
}

// Graceful shutdown — clear interval so process can exit cleanly
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

module.exports = {
  start,
  stop,
  anonymizeCustomer,
  runRetentionCycle,
  // Exported for unit testing (pure — no DB):
  parseRetentionDays,
  buildHousekeepingPrunes,
};
