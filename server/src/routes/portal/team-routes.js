/**
 * SHENMAY AI — Tenant Portal: Team / Agent Management
 *
 * Sub-router mounted by ../portal.js at `/api/portal/team`.
 * All requests have already passed `requirePortalAuth` (set by the parent),
 * so `req.portal` is populated.
 *
 *   GET    /api/portal/team               — list all agents for this tenant
 *   POST   /api/portal/team/invite        — invite a new agent (owner-only)
 *   DELETE /api/portal/team/:agentId      — remove an agent (owner-only)
 */

const router  = require('express').Router();
const db      = require('../../db');
const { PLAN_LIMITS } = require('../../config/plans');

// GET /api/portal/team  — list all agents for this tenant
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, email, first_name, last_name, role, email_verified, created_at, last_login_at
       FROM tenant_admins
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [req.portal.tenant_id]
    );
    // Get agent limit from subscription — if max_agents is NULL on an old row,
    // derive it from the plan name via PLAN_LIMITS so the fallback matches the
    // plan the tenant is actually on (was previously a flat "|| 3" which doesn't
    // match any real tier).
    const { rows: subRows } = await db.query(
      'SELECT max_agents, plan FROM subscriptions WHERE tenant_id = $1',
      [req.portal.tenant_id]
    );
    const currentPlan = subRows[0]?.plan || 'trial';
    const maxAgents   = subRows[0]?.max_agents
                        || PLAN_LIMITS[currentPlan]?.max_agents
                        || PLAN_LIMITS.trial.max_agents;
    res.json({ agents: rows, max_agents: maxAgents, plan: currentPlan });
  } catch (err) { next(err); }
});

// POST /api/portal/team/invite  — invite a new agent
router.post('/invite', async (req, res, next) => {
  try {
    const { email, first_name, last_name } = req.body;
    if (!email) return res.status(400).json({ error: 'email is required' });

    // Only owner can invite
    if (req.portal.role !== 'owner' && req.portal.role !== 'member') {
      return res.status(403).json({ error: 'Only account owners can invite agents' });
    }

    // Enforce plan agent limit (falls back to plan-derived limit when the DB
    // column is NULL on legacy rows)
    const { rows: subRows } = await db.query(
      'SELECT max_agents, plan FROM subscriptions WHERE tenant_id = $1',
      [req.portal.tenant_id]
    );
    const currentPlan = subRows[0]?.plan || 'trial';
    const maxAgents   = subRows[0]?.max_agents
                        || PLAN_LIMITS[currentPlan]?.max_agents
                        || PLAN_LIMITS.trial.max_agents;
    const { rows: countRows } = await db.query(
      'SELECT COUNT(*) FROM tenant_admins WHERE tenant_id = $1',
      [req.portal.tenant_id]
    );
    if (parseInt(countRows[0].count) >= maxAgents) {
      return res.status(402).json({
        error: `Agent limit reached (${maxAgents} on your plan). Please upgrade to add more agents.`,
        code:  'agent_limit_reached',
      });
    }

    // Check email not already in use
    const { rows: existing } = await db.query(
      'SELECT id FROM tenant_admins WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An agent with that email already exists' });
    }

    // Generate invite token
    const crypto = require('crypto');
    const inviteToken   = crypto.randomBytes(32).toString('hex');
    const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Insert agent record (no password yet — set on first login via invite link)
    const bcrypt = require('bcrypt');
    const tempHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const { rows: newAgent } = await db.query(
      `INSERT INTO tenant_admins
         (tenant_id, email, password_hash, first_name, last_name, role,
          email_verified, invite_token, invite_expires_at, invited_by)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, $9)
       RETURNING id, email, first_name, last_name, role`,
      [
        req.portal.tenant_id,
        email.toLowerCase().trim(),
        tempHash,
        first_name || null,
        last_name  || null,
        'agent', // invites create 'agent' seats only — role is NOT read from the body, so a client can't mass-assign a privileged role ('member'=Admin / 'owner'). member/owner are granted by other deliberate flows.
        inviteToken,
        inviteExpires,
        req.portal.admin_id,
      ]
    );

    // Send invite email (fire-and-forget — don't hold the portal UI on SMTP)
    const inviteUrl = `${(process.env.APP_URL || 'https://pontensolutions.com').replace(/\/$/, '')}/accept-invite?token=${inviteToken}`;
    try {
      const { sendAgentInviteEmail } = require('../../services/emailService');
      const { rows: tenantRows } = await db.query('SELECT name FROM tenants WHERE id = $1', [req.portal.tenant_id]);
      const tenantName = tenantRows[0]?.name || 'your team';
      sendAgentInviteEmail({
        to:          email.toLowerCase().trim(),
        firstName:   first_name || null,
        inviterName: req.portal.first_name ? `${req.portal.first_name}` : null,
        tenantName,
        inviteUrl,
      }).catch(err => console.error('[Team] Invite email failed:', err.message));
    } catch (prepErr) {
      // Tenant-name fetch failed — log and continue; token is already in DB,
      // so the invite link still works, the email just won't go out.
      console.error('[Team] Invite email setup failed:', prepErr.message);
    }

    res.json({ ok: true, agent: newAgent[0], invite_url: inviteUrl });
  } catch (err) { next(err); }
});

// DELETE /api/portal/team/:agentId  — remove an agent
router.delete('/:agentId', async (req, res, next) => {
  try {
    const { agentId } = req.params;

    // Only owner can remove agents
    if (req.portal.role !== 'owner' && req.portal.role !== 'member') {
      return res.status(403).json({ error: 'Only account owners can remove agents' });
    }

    // Cannot remove self
    if (agentId === req.portal.admin_id) {
      return res.status(400).json({ error: 'You cannot remove yourself' });
    }

    const { rows } = await db.query(
      'DELETE FROM tenant_admins WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [agentId, req.portal.tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Agent not found' });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
