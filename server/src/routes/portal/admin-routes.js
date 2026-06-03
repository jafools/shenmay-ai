/**
 * SHENMAY AI — Tenant Portal: Admin Account + Master Plan Override
 *
 * Sub-router mounted by ../portal.js at `/api/portal/admin`.
 * `requirePortalAuth` already ran on the parent so `req.portal` is populated.
 *
 *   PUT  /api/portal/admin/profile   — update admin's own first/last name
 *   PUT  /api/portal/admin/password  — change own password (requires current_password)
 *   POST /api/portal/admin/set-plan  — master-account-only plan override (no Stripe)
 */

const router = require('express').Router();
const db = require('../../db');
const { VALID_ADMIN_PLANS, PLAN_LIMITS } = require('../../config/plans');

// PUT /api/portal/admin/profile — update admin's own name
// Body: { first_name?: string, last_name?: string }
router.put('/profile', async (req, res, next) => {
  try {
    const { first_name, last_name } = req.body || {};

    // Guard against non-string payloads (e.g. UI bug submitting {first_name: null}
    // as a number). COALESCE already handles undefined, but an explicit array or
    // object would reach the DB as a JSON value which fails the VARCHAR cast.
    if (first_name !== undefined && first_name !== null && typeof first_name !== 'string') {
      return res.status(400).json({ error: 'first_name must be a string' });
    }
    if (last_name !== undefined && last_name !== null && typeof last_name !== 'string') {
      return res.status(400).json({ error: 'last_name must be a string' });
    }

    const cleanFirst = typeof first_name === 'string' ? first_name.trim().slice(0, 100) : null;
    const cleanLast  = typeof last_name  === 'string' ? last_name.trim().slice(0, 100)  : null;

    await db.query(
      `UPDATE tenant_admins SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name)
       WHERE id = $3`,
      [cleanFirst || null, cleanLast || null, req.portal.admin_id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/portal/admin/password — change own password
router.put('/password', async (req, res, next) => {
  try {
    const bcrypt = require('bcrypt');
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const { rows } = await db.query(
      'SELECT password_hash FROM tenant_admins WHERE id = $1',
      [req.portal.admin_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Admin not found' });
    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    const newHash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE tenant_admins SET password_hash = $1 WHERE id = $2', [newHash, req.portal.admin_id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/portal/admin/set-plan — master-account-only plan override
// Body: { plan, max_customers?, max_messages_month?, managed_ai_enabled? }
//
// Only accessible by the master account email (MASTER_EMAIL env var).
// Lets developers switch their own tenant's plan without going through Stripe.
router.post('/set-plan', async (req, res, next) => {
  try {
    const MASTER_EMAIL = process.env.MASTER_EMAIL || '';
    if (!MASTER_EMAIL || req.portal.email !== MASTER_EMAIL) {
      return res.status(403).json({ error: 'Forbidden: master account only' });
    }

    const { plan, max_customers, max_messages_month, managed_ai_enabled } = req.body;

    if (!plan || !VALID_ADMIN_PLANS.includes(plan)) {
      return res.status(400).json({ error: `plan must be one of: ${VALID_ADMIN_PLANS.join(', ')}` });
    }

    // Plan defaults come from the single source of truth (PLAN_LIMITS) so the
    // trial 1/20 → 3/50 drift can't reappear here, and so SaaS plans default to
    // managed_ai=false (pure BYOK, v3.3.27). Any field is still overridable
    // per-request by the master operator via the body params below.
    const defaults = PLAN_LIMITS[plan];
    const finalMaxCustomers = max_customers !== undefined ? max_customers : defaults.max_customers;
    const finalMaxMessages  = max_messages_month !== undefined ? max_messages_month : defaults.max_messages_month;
    const finalManagedAI    = managed_ai_enabled !== undefined ? managed_ai_enabled : defaults.managed_ai;

    await db.query(
      `UPDATE subscriptions SET
         plan                = $1,
         status              = 'active',
         max_customers       = $2,
         max_messages_month  = $3,
         managed_ai_enabled  = $4,
         updated_at          = NOW()
       WHERE tenant_id = $5`,
      [plan, finalMaxCustomers, finalMaxMessages, finalManagedAI, req.portal.tenant_id]
    );

    console.log(`[Admin] Plan override: tenant ${req.portal.tenant_id} → ${plan} by ${req.portal.email}`);

    res.json({
      ok: true,
      plan,
      max_customers:      finalMaxCustomers,
      max_messages_month: finalMaxMessages,
      managed_ai_enabled: finalManagedAI,
    });
  } catch (err) { next(err); }
});

module.exports = router;
