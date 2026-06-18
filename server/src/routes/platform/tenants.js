/**
 * SHENMAY AI — Platform Tenant Management Routes
 *
 * GET    /api/platform/tenants          — List all tenants
 * POST   /api/platform/tenants          — Create new tenant + first admin
 * GET    /api/platform/tenants/:id      — Get tenant details + stats
 * PUT    /api/platform/tenants/:id      — Update tenant config
 * PATCH  /api/platform/tenants/:id/status — Activate / deactivate tenant
 */

const router = require('express').Router();
const crypto = require('crypto');
const db = require('../../db');
const { hashPassword } = require('../../services/authService');
const { requirePlatformAuth } = require('../../middleware/platformAuth');

// All platform tenant routes require platform admin auth
router.use(requirePlatformAuth());


router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        t.id, t.name, t.slug, t.vertical, t.is_active,
        t.primary_color, t.secondary_color, t.logo_url,
        t.created_at,
        COUNT(DISTINCT c.id)  AS customer_count,
        COUNT(DISTINCT a.id)  AS advisor_count
      FROM tenants t
      LEFT JOIN customers c ON c.tenant_id = t.id
      LEFT JOIN advisors  a ON a.tenant_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `);
    res.json({ tenants: rows });
  } catch (err) { next(err); }
});


// Creates a tenant and its first admin advisor atomically.
router.post('/', async (req, res, next) => {
  const client = await db.pool.connect();
  try {
    const {
      // Tenant basics
      name,
      slug,
      vertical = 'general',
      vertical_config = {},
      agent_name = 'AI Assistant',
      primary_color = '#1E3A5F',
      secondary_color = '#4A90D9',
      logo_url,
      compliance_config,
      base_soul_template,
      onboarding_config,
      llm_provider = 'claude',
      llm_model = process.env.LLM_SONNET_MODEL || 'claude-sonnet-4-20250514',

      // First admin account
      admin_name,
      admin_email,
      admin_password,
    } = req.body;

    // Validate required fields
    if (!name || !slug || !admin_name || !admin_email || !admin_password) {
      return res.status(400).json({
        error: 'Required: name, slug, admin_name, admin_email, admin_password',
      });
    }

    // Validate slug format (lowercase, hyphens only)
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return res.status(400).json({
        error: 'slug must be lowercase letters, numbers, and hyphens only',
      });
    }

    // Check slug uniqueness
    const { rows: slugCheck } = await client.query(
      'SELECT id FROM tenants WHERE slug = $1',
      [slug]
    );
    if (slugCheck.length > 0) {
      return res.status(409).json({ error: 'A tenant with this slug already exists' });
    }

    // All validation passed — open the transaction only now. Starting BEGIN
    // earlier meant an early `return` above (bad slug / duplicate) released the
    // pooled client back with an open transaction (the finally always releases,
    // but never ROLLBACKs), so the next borrower could inherit an open BEGIN.
    await client.query('BEGIN');

    // Build default vertical_config if not provided
    const defaultVerticalConfig = {
      domain_label: vertical.charAt(0).toUpperCase() + vertical.slice(1),
      customer_label: 'Client',
      advisor_label: 'Advisor',
      data_categories: [],
      terminology: {
        data_section_title: 'Customer Data',
        primary_value_label: 'Value',
        monthly_value_label: 'Monthly',
      },
      agent_role_description: `AI assistant for ${name}`,
      framing_rules: 'Provide informational guidance only. Do not give specific professional advice.',
    };

    // Create tenant
    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants (
        name, slug, vertical, vertical_config, agent_name,
        primary_color, secondary_color, logo_url,
        compliance_config, base_soul_template, onboarding_config,
        llm_provider, llm_model
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        name,
        slug,
        vertical,
        JSON.stringify(Object.keys(vertical_config).length > 0 ? vertical_config : defaultVerticalConfig),
        agent_name,
        primary_color,
        secondary_color,
        logo_url || null,
        JSON.stringify(compliance_config || {
          disclaimers: ['This is informational guidance only. Please consult a qualified professional for specific advice.'],
          restricted_topics: [],
          escalation_triggers: [],
        }),
        JSON.stringify(base_soul_template || {
          tone: 'warm & reassuring',
          complexity_level: 3,
          pace: 'moderate',
          emotional_awareness: 'high',
          language: 'plain English',
        }),
        JSON.stringify(onboarding_config || {
          categories: [],
          optional_categories: [],
          interview_style: 'freeform',
        }),
        llm_provider,
        llm_model,
      ]
    );

    const tenant = tenantRows[0];

    // Hash admin password
    const password_hash = await hashPassword(admin_password);

    // Create first admin advisor
    const { rows: advisorRows } = await client.query(
      `INSERT INTO advisors (tenant_id, name, email, role, password_hash)
       VALUES ($1, $2, $3, 'admin', $4)
       RETURNING id, tenant_id, name, email, role`,
      [tenant.id, admin_name, admin_email, password_hash]
    );

    const admin = advisorRows[0];

    // Create invitation token (for future use / email flow)
    const inviteToken = crypto.randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO tenant_invitations (tenant_id, advisor_id, token)
       VALUES ($1, $2, $3)`,
      [tenant.id, admin.id, inviteToken]
    );

    await client.query('COMMIT');

    res.status(201).json({
      tenant,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        tenant_id: admin.tenant_id,
      },
      invite_token: inviteToken,
      message: `Tenant "${name}" created successfully. Admin account created for ${admin_email}.`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});


router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: tenantRows } = await db.query(
      'SELECT * FROM tenants WHERE id = $1',
      [id]
    );
    if (tenantRows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    const tenant = tenantRows[0];

    // Stats
    const { rows: stats } = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM customers  WHERE tenant_id = $1) AS customer_count,
        (SELECT COUNT(*) FROM advisors   WHERE tenant_id = $1) AS advisor_count,
        (SELECT COUNT(*) FROM customers  WHERE tenant_id = $1 AND onboarding_status = 'complete') AS onboarded_count,
        (SELECT COUNT(*) FROM conversations c
           JOIN customers cu ON cu.id = c.customer_id
           WHERE cu.tenant_id = $1) AS conversation_count,
        (SELECT COUNT(*) FROM flags f
           JOIN customers cu ON cu.id = f.customer_id
           WHERE cu.tenant_id = $1 AND f.status = 'open') AS open_flags
    `, [id]);

    // Advisors list
    const { rows: advisors } = await db.query(
      'SELECT id, name, email, role, is_active, created_at FROM advisors WHERE tenant_id = $1 ORDER BY role DESC, name',
      [id]
    );

    res.json({ tenant, stats: stats[0], advisors });
  } catch (err) { next(err); }
});


router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Check tenant exists
    const { rows: existing } = await db.query('SELECT id FROM tenants WHERE id = $1', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const {
      name, slug, vertical, vertical_config, agent_name,
      primary_color, secondary_color, logo_url,
      compliance_config, base_soul_template, onboarding_config,
      llm_provider, llm_model,
    } = req.body;

    const { rows } = await db.query(
      `UPDATE tenants SET
        name              = COALESCE($1,  name),
        slug              = COALESCE($2,  slug),
        vertical          = COALESCE($3,  vertical),
        vertical_config   = COALESCE($4::jsonb, vertical_config),
        agent_name        = COALESCE($5,  agent_name),
        primary_color     = COALESCE($6,  primary_color),
        secondary_color   = COALESCE($7,  secondary_color),
        logo_url          = COALESCE($8,  logo_url),
        compliance_config = COALESCE($9::jsonb, compliance_config),
        base_soul_template = COALESCE($10::jsonb, base_soul_template),
        onboarding_config = COALESCE($11::jsonb, onboarding_config),
        llm_provider      = COALESCE($12, llm_provider),
        llm_model         = COALESCE($13, llm_model),
        updated_at        = NOW()
       WHERE id = $14
       RETURNING *`,
      [
        name || null,
        slug || null,
        vertical || null,
        vertical_config ? JSON.stringify(vertical_config) : null,
        agent_name || null,
        primary_color || null,
        secondary_color || null,
        logo_url !== undefined ? logo_url : null,
        compliance_config ? JSON.stringify(compliance_config) : null,
        base_soul_template ? JSON.stringify(base_soul_template) : null,
        onboarding_config ? JSON.stringify(onboarding_config) : null,
        llm_provider || null,
        llm_model || null,
        id,
      ]
    );

    res.json({ tenant: rows[0] });
  } catch (err) { next(err); }
});


router.patch('/:id/status', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active (boolean) is required' });
    }

    const { rows } = await db.query(
      'UPDATE tenants SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, is_active',
      [is_active, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json({ tenant: rows[0] });
  } catch (err) { next(err); }
});


module.exports = router;
