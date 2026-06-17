/**
 * SHENMAY AI — Tenant Portal: Concerns
 *
 * Sub-router mounted by ../portal.js at `/api/portal/concerns`.
 * `requirePortalAuth` already ran on the parent so `req.portal` is populated.
 *
 *   GET   /api/portal/concerns               — list escalated conversations
 *   PATCH /api/portal/concerns/:id/resolve   — mark concern resolved (ends escalated conversation)
 */

const router = require('express').Router();
const db = require('../../db');

// GET /api/portal/concerns — escalated conversations
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id AS conversation_id, c.status, c.mode, c.unread, c.created_at,
              cu.id AS customer_id, cu.first_name, cu.last_name, cu.email,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
              c.last_message_at
       FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE cu.tenant_id = $1 AND c.status = 'escalated'
       ORDER BY c.created_at DESC`,
      [req.portal.tenant_id]
    );
    res.json({ concerns: rows });
  } catch (err) { next(err); }
});

// PATCH /api/portal/concerns/:id/resolve — mark a concern resolved (ends the escalated conversation)
router.patch('/:id/resolve', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE conversations
       SET status = 'ended', unread = FALSE, ended_at = COALESCE(ended_at, NOW())
       WHERE id = $1
         AND customer_id IN (SELECT id FROM customers WHERE tenant_id = $2 AND deleted_at IS NULL)
         AND status = 'escalated'
       RETURNING id`,
      [req.params.id, req.portal.tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Concern not found or already resolved' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
