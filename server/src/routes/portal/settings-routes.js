/**
 * SHENMAY AI — Tenant Portal: Tenant Settings
 *
 * Sub-router mounted by ../portal.js at `/api/portal/settings`.
 * `requirePortalAuth` already ran on the parent so `req.portal` is populated.
 *
 *   PUT    /api/portal/settings/privacy              — owner-only PII tokenizer toggle
 *   PUT    /api/portal/settings/anonymous-only-mode  — owner-only widget anon-mode flag
 *   GET    /api/portal/settings/data-api-key         — has-key + prefix display
 *   POST   /api/portal/settings/data-api-key         — generate / rotate (returns key ONCE)
 *   DELETE /api/portal/settings/data-api-key         — revoke
 *   GET    /api/portal/settings/agent-soul           — current soul template
 *   POST   /api/portal/settings/generate-soul        — (re)generate soul via Claude
 */

const router = require('express').Router();
const db = require('../../db');
const { writeAuditLog } = require('../../middleware/auditLog');

// bcrypt — graceful fallback (matches the original lazy-load in portal.js)
let bcrypt;
try { bcrypt = require('bcryptjs'); } catch {
  try { bcrypt = require('bcrypt'); } catch { bcrypt = null; }
}

function generateDataApiKey() {
  // Format: shenmay_da_<32 random hex chars>
  // "shenmay_da_" is 11 chars; prefix stored = first 19 chars (prefix + 8 chars).
  const randomPart = require('crypto').randomBytes(16).toString('hex');
  return `shenmay_da_${randomPart}`;
}

// PUT /api/portal/settings/privacy — owner-only tokenizer toggle
//
// The PII tokenizer rewrites regulated identifiers in every outbound Anthropic
// call (chat, CSV import, products extraction). It is ON by default for every
// tenant (see migration 031). Only the original onboarding owner can disable
// it — we don't want a team member to accidentally weaken the safety control.
router.put('/privacy', async (req, res, next) => {
  try {
    if (req.portal.role !== 'owner') {
      return res.status(403).json({ error: 'Only the account owner can change privacy settings.' });
    }
    const { pii_tokenization_enabled } = req.body || {};
    if (typeof pii_tokenization_enabled !== 'boolean') {
      return res.status(400).json({ error: 'pii_tokenization_enabled (boolean) is required.' });
    }

    await db.query(
      `UPDATE tenants SET pii_tokenization_enabled = $1, updated_at = NOW() WHERE id = $2`,
      [pii_tokenization_enabled, req.portal.tenant_id]
    );

    writeAuditLog({
      actorType   : 'admin',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      eventType   : 'privacy.pii_tokenization.toggle',
      resourceType: 'tenant',
      resourceId  : req.portal.tenant_id,
      description : `Owner ${pii_tokenization_enabled ? 'enabled' : 'DISABLED'} PII tokenization for outbound Anthropic calls`,
      req,
      success     : true,
    });

    res.json({ ok: true, pii_tokenization_enabled });
  } catch (err) { next(err); }
});

// PUT /api/portal/settings/anonymous-only-mode — owner-only tenant-wide widget
// privacy posture. When ON, the widget ignores any host-page identity and
// always runs anonymously. See migration 036. Disables per-customer memory /
// continuity for every visitor on this tenant.
router.put('/anonymous-only-mode', async (req, res, next) => {
  try {
    if (req.portal.role !== 'owner') {
      return res.status(403).json({ error: 'Only the account owner can change privacy settings.' });
    }
    const { anonymous_only_mode } = req.body || {};
    if (typeof anonymous_only_mode !== 'boolean') {
      return res.status(400).json({ error: 'anonymous_only_mode (boolean) is required.' });
    }

    await db.query(
      `UPDATE tenants SET anonymous_only_mode = $1, updated_at = NOW() WHERE id = $2`,
      [anonymous_only_mode, req.portal.tenant_id]
    );

    writeAuditLog({
      actorType   : 'admin',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      eventType   : 'privacy.anonymous_only_mode.toggle',
      resourceType: 'tenant',
      resourceId  : req.portal.tenant_id,
      description : `Owner ${anonymous_only_mode ? 'ENABLED anonymous-only mode (widget forces anon sessions for all visitors)' : 'disabled anonymous-only mode'}`,
      req,
      success     : true,
    });

    res.json({ ok: true, anonymous_only_mode });
  } catch (err) { next(err); }
});

// GET /api/portal/settings/data-api-key — has-key + prefix display
router.get('/data-api-key', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT data_api_key_prefix FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    const prefix = rows[0]?.data_api_key_prefix;
    res.json({
      has_key: !!prefix,
      prefix:  prefix ? `${prefix}...` : null,
    });
  } catch (err) { next(err); }
});

// POST /api/portal/settings/data-api-key — generate / rotate
// Returns the full key ONCE — never stored in plain text, cannot be retrieved again.
router.post('/data-api-key', async (req, res, next) => {
  try {
    // Owner-only: a Data API key grants full programmatic read/write over the
    // tenant's customer book via /api/v1/*. Mirror the privacy/anon-mode gates.
    if (req.portal.role !== 'owner') {
      return res.status(403).json({ error: 'Only the account owner can manage the Data API key.' });
    }
    if (!bcrypt) return res.status(500).json({ error: 'Auth module not available on server.' });

    const fullKey = generateDataApiKey();
    const prefix  = fullKey.slice(0, 17);
    const hash    = await bcrypt.hash(fullKey, 10);

    await db.query(
      `UPDATE tenants SET data_api_key_hash = $1, data_api_key_prefix = $2 WHERE id = $3`,
      [hash, prefix, req.portal.tenant_id]
    );

    writeAuditLog({
      actorType   : 'admin',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      eventType   : 'data_api_key.rotated',
      resourceType: 'tenant',
      resourceId  : req.portal.tenant_id,
      description : 'Owner generated/rotated the Data API key',
      req,
      success     : true,
    });

    res.json({
      key:     fullKey,
      prefix:  `${prefix}...`,
      warning: 'Save this key now — it will never be shown again.',
    });
  } catch (err) { next(err); }
});

// DELETE /api/portal/settings/data-api-key — revoke
router.delete('/data-api-key', async (req, res, next) => {
  try {
    if (req.portal.role !== 'owner') {
      return res.status(403).json({ error: 'Only the account owner can manage the Data API key.' });
    }
    await db.query(
      `UPDATE tenants SET data_api_key_hash = NULL, data_api_key_prefix = NULL WHERE id = $1`,
      [req.portal.tenant_id]
    );

    writeAuditLog({
      actorType   : 'admin',
      actorId     : req.portal.admin_id,
      actorEmail  : req.portal.email,
      tenantId    : req.portal.tenant_id,
      eventType   : 'data_api_key.revoked',
      resourceType: 'tenant',
      resourceId  : req.portal.tenant_id,
      description : 'Owner revoked the Data API key',
      req,
      success     : true,
    });

    res.json({ ok: true, message: 'Data API key revoked.' });
  } catch (err) { next(err); }
});

// GET /api/portal/settings/agent-soul — return current soul template
router.get('/agent-soul', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT agent_soul_template FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    const soul = rows[0]?.agent_soul_template || null;
    res.json({ soul });
  } catch (err) { next(err); }
});

// POST /api/portal/settings/generate-soul — (re)generate soul using Claude
router.post('/generate-soul', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, agent_name, vertical, company_description, website_url
       FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });

    const tenant   = rows[0];
    const { generateAgentSoul } = require('../../engine/soulGenerator');
    const soul = await generateAgentSoul(tenant, null);

    await db.query(
      `UPDATE tenants SET agent_soul_template = $1::jsonb WHERE id = $2`,
      [JSON.stringify(soul), req.portal.tenant_id]
    );

    res.json({ soul });
  } catch (err) { next(err); }
});

module.exports = router;
