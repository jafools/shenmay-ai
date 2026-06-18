/**
 * SHENMAY AI — Subscription Enforcement Middleware
 *
 * Checks tenant subscription status before allowing access to portal
 * and widget routes. Master accounts always pass.
 *
 * Usage:
 *   router.use(requireActiveSubscription);           // after requirePortalAuth
 *   router.use(requireActiveWidgetSubscription);     // after requireWidgetAuth
 */

const db = require('../db');
const { sendTrialLimitEmail } = require('../services/emailService');
const {
  UNRESTRICTED_PLANS,
  TRIAL_PLANS,
  NOTIFICATION_TYPES,
} = require('../config/plans');
const { anonEmailNotLikeGuard } = require('../constants/anonDomains');

/**
 * Load subscription for a tenant. Returns null if none exists.
 */
async function getSubscription(tenantId) {
  const { rows } = await db.query(
    `SELECT s.*, t.is_active
     FROM subscriptions s
     JOIN tenants t ON t.id = s.tenant_id
     WHERE s.tenant_id = $1`,
    [tenantId]
  );
  return rows[0] || null;
}

/**
 * Determine if a subscription is currently valid.
 */
function isSubscriptionValid(sub) {
  if (!sub) return false;
  if (!sub.is_active) return false;
  if (UNRESTRICTED_PLANS.includes(sub.plan)) return true;

  switch (sub.status) {
    case 'active':
      return true;
    case 'trialing':
      return new Date(sub.trial_ends_at) > new Date();
    case 'past_due':
      // Grace period: allow 7 days past_due before blocking
      if (sub.current_period_end) {
        const grace = new Date(sub.current_period_end);
        grace.setDate(grace.getDate() + 7);
        return grace > new Date();
      }
      return false;
    case 'canceled':
    case 'expired':
      return false;
    default:
      return false;
  }
}

/**
 * Build a human-readable reason for subscription failure.
 */
function getBlockReason(sub) {
  if (!sub) return { code: 'no_subscription', message: 'No subscription found. Please upgrade to continue.' };
  if (!sub.is_active) return { code: 'tenant_inactive', message: 'Account has been deactivated.' };

  switch (sub.status) {
    case 'trialing':
      return { code: 'trial_expired', message: 'Your free trial has ended. Upgrade to keep using Shenmay AI.' };
    case 'past_due':
      return { code: 'payment_past_due', message: 'Payment is past due. Please update your billing info.' };
    case 'canceled':
      return { code: 'subscription_canceled', message: 'Your subscription has been canceled.' };
    case 'expired':
      return { code: 'subscription_expired', message: 'Your subscription has expired. Please renew.' };
    default:
      return { code: 'subscription_invalid', message: 'Subscription is not active.' };
  }
}

/**
 * Check message limit for the current month.
 */
function isWithinMessageLimit(sub) {
  if (UNRESTRICTED_PLANS.includes(sub.plan)) return true;
  return sub.messages_used_this_month < sub.max_messages_month;
}

/**
 * Check customer limit.
 */
async function isWithinCustomerLimit(sub) {
  if (UNRESTRICTED_PLANS.includes(sub.plan)) return true;

  const { rows } = await db.query(
    `SELECT COUNT(*) FROM customers
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND ${anonEmailNotLikeGuard()}`,
    [sub.tenant_id]
  );
  return parseInt(rows[0].count) < sub.max_customers;
}


// ═══════════════════════════════════════════════════════════════════════════
// PORTAL MIDDLEWARE — runs after requirePortalAuth (req.portal is set)
// ═══════════════════════════════════════════════════════════════════════════

async function requireActiveSubscription(req, res, next) {
  try {
    const sub = await getSubscription(req.portal.tenant_id);

    if (!isSubscriptionValid(sub)) {
      const reason = getBlockReason(sub);
      return res.status(403).json({
        error: 'subscription_required',
        ...reason,
        subscription: sub ? {
          plan:           sub.plan,
          status:         sub.status,
          trial_ends_at:  sub.trial_ends_at,
        } : null,
      });
    }

    // Attach subscription to request for downstream use
    req.subscription = sub;
    next();
  } catch (err) {
    next(err);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// WIDGET MIDDLEWARE — runs after requireWidgetAuth (req.widgetSession is set)
// ═══════════════════════════════════════════════════════════════════════════

async function requireActiveWidgetSubscription(req, res, next) {
  try {
    const sub = await getSubscription(req.widgetSession.tenant_id);

    if (!isSubscriptionValid(sub)) {
      return res.status(403).json({
        error: 'widget_unavailable',
        message: 'This chat service is temporarily unavailable.',
      });
    }

    // Check message limit on chat endpoint
    if (req.path === '/chat' && !isWithinMessageLimit(sub)) {
      // Fire one-time notification email for trial tenants
      sendLimitNotificationIfNeeded(req.widgetSession.tenant_id);
      return res.status(429).json({
        error: 'message_limit_reached',
        message: 'Monthly message limit reached. The site owner needs to upgrade their plan.',
      });
    }

    req.subscription = sub;
    next();
  } catch (err) {
    next(err);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
// INCREMENT MESSAGE COUNTER
// ═══════════════════════════════════════════════════════════════════════════

async function incrementMessageCount(tenantId) {
  // Atomic compare-and-set (P3-3): only count while under the cap, so N
  // concurrent /chat requests can't drive messages_used_this_month past
  // max_messages_month through the read-then-increment gap (the limit check at
  // the gate and this increment straddle a multi-second LLM round-trip).
  // Unrestricted plans always count (stat only). Returns false when the row was
  // already at its cap so the increment was a no-op — current callers ignore
  // the result; the value here is the atomicity, not the return.
  const { rowCount } = await db.query(
    `UPDATE subscriptions
     SET messages_used_this_month = messages_used_this_month + 1,
         updated_at = NOW()
     WHERE tenant_id = $1
       AND (plan = ANY($2) OR messages_used_this_month < max_messages_month)`,
    [tenantId, UNRESTRICTED_PLANS]
  );
  return rowCount > 0;
}


// ═══════════════════════════════════════════════════════════════════════════
// TRIAL LIMIT NOTIFICATION
// Fires a one-time email when a trial tenant first hits a usage limit.
// Uses limit_notified_at as a sent-flag so we never spam.
// ═══════════════════════════════════════════════════════════════════════════

async function sendLimitNotificationIfNeeded(tenantId) {
  try {
    // Only notify for trial plans that haven't been notified yet
    const { rows } = await db.query(
      `SELECT s.plan, s.limit_notified_at,
              t.name AS tenant_name,
              a.email, a.first_name
       FROM subscriptions s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN tenant_admins a ON a.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1
         AND s.plan IN ('trial', 'free')
         AND s.limit_notified_at IS NULL
       LIMIT 1`,
      [tenantId]
    );

    if (rows.length === 0) return; // already notified, or not a trial plan

    const { email, first_name, tenant_name, plan } = rows[0];

    // Mark as notified BEFORE sending so a retry can't double-send
    await db.query(
      `UPDATE subscriptions SET limit_notified_at = NOW() WHERE tenant_id = $1`,
      [tenantId]
    );

    // Fire email async — don't block the request
    sendTrialLimitEmail({ to: email, firstName: first_name, tenantName: tenant_name, plan })
      .catch(err => console.error('[Subscription] Failed to send trial limit email:', err.message));

    // Also create an in-app notification so owners are warned even when SMTP
    // isn't configured (the default after install.sh). The bell icon in the
    // dashboard sidebar will pick this up via /api/portal/notifications.
    db.query(
      `INSERT INTO notifications (tenant_id, type, title, body)
       VALUES ($1, $2, $3, $4)`,
      [
        tenantId,
        NOTIFICATION_TYPES.LIMIT_REACHED,
        'Trial limit reached',
        'Your trial allowance has been exhausted. Upgrade your plan to restore service.',
      ]
    ).catch(err => console.error('[Subscription] Failed to create in-app notification:', err.message));

    console.log(`[Subscription] Trial limit notification sent for tenant ${tenantId}`);
  } catch (err) {
    // Never let notification errors break the main flow
    console.error('[Subscription] sendLimitNotificationIfNeeded error:', err.message);
  }
}


module.exports = {
  requireActiveSubscription,
  requireActiveWidgetSubscription,
  incrementMessageCount,
  getSubscription,
  isSubscriptionValid,
  getBlockReason,
  isWithinMessageLimit,
  isWithinCustomerLimit,
  sendLimitNotificationIfNeeded,
};
