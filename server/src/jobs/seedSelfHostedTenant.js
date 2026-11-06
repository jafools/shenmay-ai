/**
 * SHENMAY AI — Self-Hosted Tenant Seed
 *
 * Called once on startup when SHENMAY_DEPLOYMENT=selfhosted.
 * If no tenants exist yet, provisions the single tenant + admin account
 * using values from the environment (written by install.sh).
 *
 * After this runs:
 *   - One tenant exists with the operator's company name
 *   - One admin account exists (email = MASTER_EMAIL, pre-verified)
 *   - One trial subscription exists (PLAN_LIMITS.trial: 50 messages/mo, 3 customers)
 *
 * Idempotent: does nothing if a tenant already exists.
 */

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db     = require('../db');
const { PLAN_LIMITS } = require('../config/plans');

async function seedSelfHostedTenant() {
  // Already seeded?
  const { rows: existing } = await db.query('SELECT id FROM tenants LIMIT 1');
  if (existing.length > 0) return;

  const email       = (process.env.MASTER_EMAIL || '').toLowerCase().trim();
  const companyName = (process.env.TENANT_NAME  || 'My Company').trim();
  const rawPassword = process.env.ADMIN_PASSWORD || '';

  // If no credentials are set, the first-run web wizard (POST /api/setup/complete)
  // will handle tenant provisioning instead. Skip silently.
  if (!email || !rawPassword) {
    console.log('[Self-Hosted] No MASTER_EMAIL/ADMIN_PASSWORD set — first-run setup wizard will handle provisioning.');
    return;
  }

  console.log(`[Self-Hosted] Seeding tenant for ${companyName} (${email})…`);

  const slug         = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const widgetApiKey = crypto.randomBytes(32).toString('hex');

  // ── Create tenant ──────────────────────────────────────────────────────────
  const { rows: tenantRows } = await db.query(
    `INSERT INTO tenants (
       name, slug, agent_name, vertical,
       primary_color, secondary_color,
       widget_api_key, is_active, onboarding_steps
     ) VALUES ($1, $2, $3, 'other', '#1E3A5F', '#C9A84C', $4, true, '{}')
     RETURNING id`,
    [companyName, slug, `${companyName} Assistant`, widgetApiKey]
  );
  const tenantId = tenantRows[0].id;

  // ── Create admin (pre-verified — operator ran the installer) ───────────────
  const passwordHash = await bcrypt.hash(rawPassword, 10);
  await db.query(
    `INSERT INTO tenant_admins
       (tenant_id, email, password_hash, first_name, last_name,
        role, email_verified, tos_accepted_at)
     VALUES ($1, $2, $3, 'Admin', '', 'owner', true, NOW())`,
    [tenantId, email, passwordHash]
  );

  // ── Create trial subscription ──────────────────────────────────────────────
  // managed_ai_enabled=true so the server's ANTHROPIC_API_KEY env var is used
  // for LLM calls — the operator already provided their key in .env during install.
  const limits = PLAN_LIMITS.trial;
  const hasServerKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  await db.query(
    `INSERT INTO subscriptions
       (tenant_id, plan, status, max_customers, max_messages_month, managed_ai_enabled, max_agents)
     VALUES ($1, 'trial', 'active', $2, $3, $4, $5)`,
    [tenantId, limits.max_customers, limits.max_messages_month, hasServerKey, limits.max_agents]
  );

  console.log(`[Self-Hosted] ✓ Tenant seeded. Login: ${email}`);
  const appUrl = (process.env.APP_URL || 'https://pontensolutions.com').replace(/\/$/, '');
  console.log(`[Self-Hosted]   Trial: ${limits.max_messages_month} messages/mo, ${limits.max_customers} customers. Upgrade at ${appUrl}/license`);
}

module.exports = { seedSelfHostedTenant };
