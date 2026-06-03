/**
 * SHENMAY AI — Shared Plan / Subscription / Notification constants.
 *
 * Single source of truth used by:
 *   - stripe-webhook.js          (SaaS: apply limits after Stripe checkout)
 *   - licenseService.js          (self-hosted: apply limits after license validation)
 *   - seedSelfHostedTenant.js    (self-hosted: seed trial subscription on first boot)
 *   - middleware/subscription.js (gating + in-app notifications)
 *   - routes/widget.js, routes/portal.js, routes/license.js, routes/platform/licenses.js
 *
 * ── JSDoc type definitions ─────────────────────────────────────────────────
 * @typedef {'free'|'trial'|'starter'|'growth'|'professional'|'enterprise'|'master'} PlanName
 * @typedef {'active'|'trialing'|'past_due'|'canceled'|'expired'|'incomplete'} SubscriptionStatus
 * @typedef {'flag'|'human_reply'|'escalation'|'limit_reached'} NotificationType
 * @typedef {'selfhosted'|'saas'} DeploymentMode
 *
 * @typedef {Object} PlanLimits
 * @property {number}  max_customers
 * @property {number}  max_messages_month
 * @property {boolean} managed_ai
 * @property {number}  max_agents
 *
 * @typedef {Object} Subscription
 * @property {string}             tenant_id
 * @property {PlanName}           plan
 * @property {SubscriptionStatus} status
 * @property {boolean}            is_active
 * @property {number}             max_customers
 * @property {number}             max_messages_month
 * @property {number}             messages_used_this_month
 * @property {string|null}        trial_ends_at
 * @property {string|null}        current_period_end
 * @property {string|null}        limit_notified_at
 */

const { envVar } = require('../utils/env');

// Pure BYOK as of v3.3.27: managed_ai is `false` for every SaaS plan, including
// enterprise + master. The flag still exists on the subscriptions row as a manual
// opt-in for internal admin tenants whose key the operator has chosen to provide
// via env (set directly in the DB), but no Stripe upgrade path ever flips it on
// — every customer brings their own key.
/** @type {Record<PlanName, PlanLimits>} */
const PLAN_LIMITS = {
  free:         { max_customers: 1,     max_messages_month: 20,     managed_ai: false, max_agents: 1   },
  trial:        { max_customers: 3,     max_messages_month: 50,     managed_ai: false, max_agents: 1   },
  starter:      { max_customers: 50,    max_messages_month: 1000,   managed_ai: false, max_agents: 10  },
  growth:       { max_customers: 250,   max_messages_month: 5000,   managed_ai: false, max_agents: 25  },
  professional: { max_customers: 1000,  max_messages_month: 25000,  managed_ai: false, max_agents: 100 },
  enterprise:   { max_customers: 99999, max_messages_month: 999999, managed_ai: false, max_agents: 999 },
  master:       { max_customers: 99999, max_messages_month: 999999, managed_ai: false, max_agents: 999 },
};

// ── Plan group constants ───────────────────────────────────────────────────
// Plans that bypass all customer/message/status checks.
/** @type {PlanName[]} */
const UNRESTRICTED_PLANS = ['master', 'enterprise'];

// Plans that show trial-limit UX (small limits, upgrade prompts).
/** @type {PlanName[]} */
const TRIAL_PLANS = ['trial', 'free'];

// Plans a master admin may set on a tenant via /api/portal/admin/set-plan.
/** @type {PlanName[]} */
const VALID_ADMIN_PLANS = ['free', 'trial', 'starter', 'growth', 'professional', 'enterprise', 'master'];

// Plans that may be assigned to a platform license (self-hosted deployment).
// Excludes trial (own issue flow) and master (internal only).
/** @type {PlanName[]} */
const VALID_LICENSE_PLANS = ['starter', 'growth', 'professional', 'enterprise'];

// ── Notification & status enums ────────────────────────────────────────────
// Mirrors `type` values inserted into the `notifications` table (migration 022).
/** @type {Readonly<Record<string, NotificationType>>} */
const NOTIFICATION_TYPES = Object.freeze({
  FLAG:          'flag',
  HUMAN_REPLY:   'human_reply',
  ESCALATION:    'escalation',
  LIMIT_REACHED: 'limit_reached',
});

// Mirrors `subscriptions.status` values written by stripe-webhook + licenseService.
/** @type {Readonly<Record<string, SubscriptionStatus>>} */
const SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE:     'active',
  TRIALING:   'trialing',
  PAST_DUE:   'past_due',
  CANCELED:   'canceled',
  EXPIRED:    'expired',
  INCOMPLETE: 'incomplete',
});

// Deployment modes reported by GET /api/portal/me as `deployment_mode`.
/** @type {Readonly<Record<string, DeploymentMode>>} */
const DEPLOYMENT_MODES = Object.freeze({
  SELFHOSTED: 'selfhosted',
  SAAS:       'saas',
});

/**
 * Returns true when running as a self-hosted single-tenant deployment.
 * Set SHENMAY_DEPLOYMENT=selfhosted in docker-compose.selfhosted.yml.
 * @returns {boolean}
 */
function isSelfHosted() {
  return envVar('DEPLOYMENT') === DEPLOYMENT_MODES.SELFHOSTED;
}

/**
 * @param {Subscription|null|undefined} sub
 * @returns {boolean} true if the subscription's plan bypasses all limit checks.
 */
function isUnrestrictedPlan(sub) {
  return !!sub && UNRESTRICTED_PLANS.includes(sub.plan);
}

module.exports = {
  PLAN_LIMITS,
  UNRESTRICTED_PLANS,
  TRIAL_PLANS,
  VALID_ADMIN_PLANS,
  VALID_LICENSE_PLANS,
  NOTIFICATION_TYPES,
  SUBSCRIPTION_STATUSES,
  DEPLOYMENT_MODES,
  isSelfHosted,
  isUnrestrictedPlan,
};
