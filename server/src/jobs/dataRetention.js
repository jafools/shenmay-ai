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
// Conversation metadata (started_at, summary, topics) and audit logs are kept
// for legal + analytics purposes — they no longer contain PII after anonymisation.

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

module.exports = { start, stop, anonymizeCustomer, runRetentionCycle };
