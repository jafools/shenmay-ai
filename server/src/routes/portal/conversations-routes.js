/**
 * SHENMAY AI — Tenant Portal: Conversations
 *
 * Sub-router mounted by ../portal.js at `/api/portal/conversations`.
 * `requirePortalAuth` already ran on the parent so `req.portal` is populated.
 *
 *   GET    /api/portal/conversations                   — paginated list (filter by status/mode/unread/search)
 *   POST   /api/portal/conversations/:id/score         — advisor rates AI performance 1–5
 *   GET    /api/portal/conversations/:id               — full thread (also marks read)
 *   GET    /api/portal/conversations/:id/transcript    — plain-text download
 *   POST   /api/portal/conversations/:id/takeover      — human agent takes over
 *   POST   /api/portal/conversations/:id/handback      — return control to AI
 *   POST   /api/portal/conversations/:id/reply         — human agent sends a message
 *   POST   /api/portal/conversations/:id/labels/:labelId   — attach label
 *   DELETE /api/portal/conversations/:id/labels/:labelId   — detach label
 *   POST   /api/portal/conversations/bulk              — resolve / assign / label / unlabel batch
 *   POST   /api/portal/conversations/:id/summarize     — fire-and-forget memory rebuild
 */

const router = require('express').Router();
const db = require('../../db');
const { fireNotifications } = require('../../services/notificationService');
const { anonEmailLikeMatch } = require('../../constants/anonDomains');
const { resolveApiKey } = require('../../services/llmService');
const { encryptJson, safeDecryptJson } = require('../../services/cryptoService');
const { generateSessionSummary, applySessionSummary } = require('../../engine/memoryUpdater');

// ── Safe pagination helper (mirrors the one in portal.js) ──────────────────
function parsePage(raw, defaultVal = 1)  { const n = parseInt(raw, 10); return isNaN(n) ? defaultVal : Math.max(1, Math.min(n, 10000)); }
function parseLimit(raw, max = 100, def = 25) { const n = parseInt(raw, 10); return isNaN(n) ? def : Math.max(1, Math.min(n, max)); }

// GET /api/portal/conversations — paginated list with filters
router.get('/', async (req, res, next) => {
  try {
    const page   = parsePage(req.query.page);
    const limit  = parseLimit(req.query.limit);
    const offset = (page - 1) * limit;
    const status = req.query.status || null;           // active | ended | escalated
    const mode   = req.query.mode   || null;           // human | ai
    const unread = req.query.unread === 'true' ? true : null;  // true = unread only
    const search = req.query.search ? req.query.search.trim() : null; // name / email substring

    // Build parameterised WHERE conditions
    const params  = [req.portal.tenant_id];
    const clauses = [
      `cu.tenant_id = $1`,
      `cu.deleted_at IS NULL`,
    ];

    if (status) { params.push(status); clauses.push(`c.status = $${params.length}`); }
    if (mode === 'human') { clauses.push(`c.mode = 'human'`); }
    if (mode === 'ai')    { clauses.push(`(c.mode IS NULL OR c.mode = 'ai')`); }
    if (unread)  { clauses.push(`c.unread = TRUE`); }
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      clauses.push(`(
        LOWER(cu.first_name) LIKE $${params.length}
        OR LOWER(cu.last_name)  LIKE $${params.length}
        OR LOWER(cu.email)      LIKE $${params.length}
        OR LOWER(COALESCE(cu.soul_file->>'customer_name','')) LIKE $${params.length}
      )`);
    }

    const where = clauses.join(' AND ');

    // Main query
    params.push(limit, offset);
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    const { rows } = await db.query(
      `SELECT c.id, c.status, c.mode, c.unread, c.created_at,
              c.csat_score,
              CASE
                WHEN ${anonEmailLikeMatch('cu.email')} THEN 'Anonymous Visitor'
                ELSE COALESCE(cu.soul_file->>'customer_name', NULLIF(TRIM(cu.first_name || ' ' || cu.last_name), ''), cu.email)
              END AS customer_display_name,
              cu.email, cu.id AS customer_id,
              ${anonEmailLikeMatch('cu.email')} AS is_anonymous,
              (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count,
              (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
              c.last_message_at,
              COALESCE(
                (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
                 FROM conversation_labels cl JOIN labels l ON cl.label_id = l.id
                 WHERE cl.conversation_id = c.id),
                '[]'::json
              ) AS labels
       FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE ${where}
       ORDER BY c.last_message_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    // Count query (same WHERE, no LIMIT/OFFSET)
    const countParams = params.slice(0, -2);
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE ${where}`,
      countParams
    );

    res.json({ conversations: rows, total: parseInt(countRows[0].count), page, limit });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/bulk
// Body: { ids: string[], action: 'resolve' | 'assign' | 'label' | 'unlabel',
//         agent_id?: string, label_id?: string }
//
// Mounted before /:id/* routes so the literal "bulk" segment doesn't get
// captured as an :id param.
router.post('/bulk', async (req, res, next) => {
  try {
    const { ids, action, agent_id, label_id } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (ids.length > 100) return res.status(400).json({ error: 'Maximum 100 conversations per bulk operation' });

    // Verify all conversations belong to this tenant
    const { rows: owned } = await db.query(
      `SELECT c.id FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = ANY($1::uuid[]) AND cu.tenant_id = $2`,
      [ids, req.portal.tenant_id]
    );
    const ownedIds = owned.map(r => r.id);
    if (ownedIds.length === 0) return res.status(404).json({ error: 'No matching conversations found' });

    let affected = 0;

    if (action === 'resolve') {
      const { rowCount } = await db.query(
        `UPDATE conversations
         SET status = 'ended', unread = FALSE, ended_at = COALESCE(ended_at, NOW())
         WHERE id = ANY($1::uuid[])`,
        [ownedIds]
      );
      affected = rowCount;

    } else if (action === 'assign') {
      if (!agent_id) return res.status(400).json({ error: 'agent_id is required for assign' });
      // Verify the agent belongs to this tenant
      const { rows: agentCheck } = await db.query(
        `SELECT id FROM tenant_admins WHERE id = $1 AND tenant_id = $2`,
        [agent_id, req.portal.tenant_id]
      );
      if (agentCheck.length === 0) return res.status(404).json({ error: 'Agent not found' });
      // Store as human_agent_id but keep mode as-is (assign ≠ takeover)
      const { rowCount } = await db.query(
        `UPDATE conversations SET human_agent_id = $1 WHERE id = ANY($2::uuid[])`,
        [agent_id, ownedIds]
      );
      affected = rowCount;

    } else if (action === 'label') {
      if (!label_id) return res.status(400).json({ error: 'label_id is required for label' });
      const { rows: labelCheck } = await db.query(
        `SELECT id FROM labels WHERE id = $1 AND tenant_id = $2`,
        [label_id, req.portal.tenant_id]
      );
      if (labelCheck.length === 0) return res.status(404).json({ error: 'Label not found' });
      // Batch upsert — ON CONFLICT DO NOTHING skips already-labelled rows
      const values = ownedIds.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
      const params = ownedIds.flatMap(id => [id, label_id]);
      await db.query(
        `INSERT INTO conversation_labels (conversation_id, label_id) VALUES ${values}
         ON CONFLICT DO NOTHING`,
        params
      );
      affected = ownedIds.length;

    } else if (action === 'unlabel') {
      if (!label_id) return res.status(400).json({ error: 'label_id is required for unlabel' });
      const { rowCount } = await db.query(
        `DELETE FROM conversation_labels
         WHERE conversation_id = ANY($1::uuid[]) AND label_id = $2`,
        [ownedIds, label_id]
      );
      affected = rowCount;

    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    res.json({ ok: true, affected });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/score — advisor rates AI performance 1–5
router.post('/:id/score', async (req, res, next) => {
  try {
    const score = parseInt(req.body.score, 10);
    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: 'score must be an integer between 1 and 5' });
    }
    const { rowCount } = await db.query(
      `UPDATE conversations c
       SET conversation_score = $1
       FROM customers cu
       WHERE c.id = $2
         AND c.customer_id = cu.id
         AND cu.tenant_id = $3`,
      [score, req.params.id, req.portal.tenant_id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ conversation_score: score });
  } catch (err) { next(err); }
});

// GET /api/portal/conversations/:id — full thread + mark as read
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: convRows } = await db.query(
      `SELECT c.id, c.status, c.mode, c.human_agent_id, c.created_at, c.unread,
              c.csat_score, c.csat_comment, c.csat_submitted_at, c.conversation_score,
              cu.id AS customer_id, cu.first_name, cu.last_name, cu.email,
              COALESCE(
                (SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
                 FROM conversation_labels cl JOIN labels l ON cl.label_id = l.id
                 WHERE cl.conversation_id = c.id),
                '[]'::json
              ) AS labels
       FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (convRows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    // Mark as read when portal agent opens it
    await db.query(
      'UPDATE conversations SET unread = FALSE WHERE id = $1',
      [req.params.id]
    );

    const { rows: messages } = await db.query(
      `SELECT m.id, m.role, m.content, m.created_at, m.sent_by_admin_id,
              ta.first_name AS sender_first_name, ta.last_name AS sender_last_name
       FROM messages m
       LEFT JOIN tenant_admins ta ON m.sent_by_admin_id = ta.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.id]
    );

    res.json({ conversation: { ...convRows[0], unread: false }, messages });
  } catch (err) { next(err); }
});

// GET /api/portal/conversations/:id/transcript — download full conversation as plain text
router.get('/:id/transcript', async (req, res, next) => {
  try {
    const { rows: convRows } = await db.query(
      `SELECT c.id, c.status, c.created_at,
              cu.first_name, cu.last_name, cu.email,
              t.name AS tenant_name, t.agent_name
       FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       JOIN tenants   t  ON cu.tenant_id  = t.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (convRows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    const conv = convRows[0];
    const { rows: messages } = await db.query(
      `SELECT m.role, m.content, m.created_at, m.sent_by_admin_id,
              ta.first_name AS sender_first_name, ta.last_name AS sender_last_name
       FROM messages m
       LEFT JOIN tenant_admins ta ON m.sent_by_admin_id = ta.id
       WHERE m.conversation_id = $1
       ORDER BY m.created_at ASC`,
      [req.params.id]
    );

    const customerName = `${conv.first_name || ''} ${conv.last_name || ''}`.trim() || conv.email || 'Customer';
    const agentName    = conv.agent_name || 'Agent';
    const date         = new Date(conv.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    // Build plain-text transcript
    const lines = [
      `CONVERSATION TRANSCRIPT`,
      `═══════════════════════════════════════`,
      `Tenant:   ${conv.tenant_name}`,
      `Customer: ${customerName} <${conv.email}>`,
      `Date:     ${date}`,
      `Status:   ${conv.status}`,
      `ID:       ${conv.id}`,
      `═══════════════════════════════════════`,
      '',
      ...messages.map(m => {
        let speaker;
        if (m.role === 'customer') {
          speaker = customerName;
        } else if (m.sent_by_admin_id) {
          const human = `${m.sender_first_name || ''} ${m.sender_last_name || ''}`.trim() || 'Human agent';
          speaker = `${human} (human)`;
        } else {
          speaker = agentName;
        }
        const time = new Date(m.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        return `[${time}] ${speaker}:\n${m.content}\n`;
      }),
      `═══════════════════════════════════════`,
      `Exported: ${new Date().toISOString()}`,
    ];

    const transcript = lines.join('\n');
    const safeName   = customerName.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const dateStr    = new Date(conv.created_at).toISOString().split('T')[0];

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transcript_${safeName}_${dateStr}.txt"`);
    res.send(transcript);
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/takeover — human agent takes over
router.post('/:id/takeover', async (req, res, next) => {
  try {
    const { id }        = req.params;
    const { tenant_id, admin_id } = req.portal;

    // Verify conversation belongs to this tenant
    const { rows } = await db.query(
      `SELECT c.id FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [id, tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    await db.query(
      `UPDATE conversations SET mode = 'human', human_agent_id = $1 WHERE id = $2`,
      [admin_id, id]
    );

    // Post a system notice into the message thread so the customer sees the handover
    await db.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, 'agent', '👋 You are now connected with a human support agent. How can I help you?')`,
      [id]
    );

    // Slack/Teams + webhooks notification
    try {
      const { rows: ctx } = await db.query(
        `SELECT cu.first_name, cu.last_name, cu.email, ta.first_name AS agent_first, ta.last_name AS agent_last
         FROM conversations c
         JOIN customers cu ON c.customer_id = cu.id
         LEFT JOIN tenant_admins ta ON ta.id = $1
         WHERE c.id = $2 LIMIT 1`,
        [admin_id, id]
      );
      if (ctx.length > 0) {
        const cName = [ctx[0].first_name, ctx[0].last_name].filter(Boolean).join(' ') || ctx[0].email || '';
        const aName = [ctx[0].agent_first, ctx[0].agent_last].filter(Boolean).join(' ') || 'Advisor';
        fireNotifications(tenant_id, 'human.takeover', {
          conversation_id: id, customer_name: cName, customer_email: ctx[0].email, agent_name: aName,
        });
      }
    } catch (_) {}

    res.json({ ok: true, mode: 'human' });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/handback — return control to AI agent
// Body: { note?: string }  — optional context note for the AI's next turn (single-use)
router.post('/:id/handback', async (req, res, next) => {
  try {
    const { id }        = req.params;
    const { tenant_id } = req.portal;
    const { note }      = req.body || {};

    const { rows } = await db.query(
      `SELECT c.id FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [id, tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    // Store advisor note (if provided) — consumed on next AI turn, then cleared
    const cleanNote = note && note.trim() ? note.trim().slice(0, 1000) : null;

    await db.query(
      `UPDATE conversations
       SET mode = 'ai', human_agent_id = NULL, handback_note = $1
       WHERE id = $2`,
      [cleanNote, id]
    );

    // Post a system notice so the customer knows the AI is back
    await db.query(
      `INSERT INTO messages (conversation_id, role, content)
       VALUES ($1, 'agent', '🤖 You are now back with your AI assistant. Is there anything else I can help you with?')`,
      [id]
    );

    // Slack/Teams notification
    try {
      const { rows: ctx } = await db.query(
        `SELECT cu.first_name, cu.last_name, cu.email
         FROM conversations c JOIN customers cu ON c.customer_id = cu.id
         WHERE c.id = $1 LIMIT 1`, [id]
      );
      if (ctx.length > 0) {
        const cName = [ctx[0].first_name, ctx[0].last_name].filter(Boolean).join(' ') || ctx[0].email || '';
        fireNotifications(tenant_id, 'human.handback', {
          conversation_id: id, customer_name: cName, customer_email: ctx[0].email,
        });
      }
    } catch (_) {}

    res.json({ ok: true, mode: 'ai' });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/reply — human agent sends a message
router.post('/:id/reply', async (req, res, next) => {
  try {
    const { id }       = req.params;
    const { content }  = req.body;
    const { tenant_id, admin_id } = req.portal;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    const { rows } = await db.query(
      `SELECT c.id, c.customer_id, c.mode FROM conversations c
       JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [id, tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    // Only allow replies when the conversation is in human mode
    if (rows[0].mode !== 'human') {
      return res.status(409).json({ error: 'Conversation is not in human mode. Take over first.' });
    }

    const { rows: msgRows } = await db.query(
      `INSERT INTO messages (conversation_id, role, content, sent_by_admin_id)
       VALUES ($1, 'agent', $2, $3)
       RETURNING id, role, content, created_at, sent_by_admin_id`,
      [id, content.trim(), admin_id]
    );

    // Update customer last interaction + mark conversation unread so widget poll picks it up
    await Promise.all([
      db.query('UPDATE customers SET last_interaction_at = NOW() WHERE id = $1', [rows[0].customer_id]),
      db.query('UPDATE conversations SET unread = TRUE WHERE id = $1', [id]),
    ]);

    res.json({ ok: true, message: msgRows[0] });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/labels/:labelId — assign label to conversation
router.post('/:id/labels/:labelId', async (req, res, next) => {
  try {
    // Verify the conversation belongs to this tenant
    const { rows: convCheck } = await db.query(
      `SELECT c.id FROM conversations c JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (convCheck.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    // Verify the label belongs to this tenant
    const { rows: labelCheck } = await db.query(
      `SELECT id FROM labels WHERE id = $1 AND tenant_id = $2`,
      [req.params.labelId, req.portal.tenant_id]
    );
    if (labelCheck.length === 0) return res.status(404).json({ error: 'Label not found' });

    await db.query(
      `INSERT INTO conversation_labels (conversation_id, label_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.params.id, req.params.labelId]
    );

    // Return updated label list for the conversation
    const { rows: labels } = await db.query(
      `SELECT l.id, l.name, l.color FROM conversation_labels cl
       JOIN labels l ON cl.label_id = l.id
       WHERE cl.conversation_id = $1 ORDER BY l.name`,
      [req.params.id]
    );
    res.json({ labels });
  } catch (err) { next(err); }
});

// DELETE /api/portal/conversations/:id/labels/:labelId — remove label from conversation
router.delete('/:id/labels/:labelId', async (req, res, next) => {
  try {
    const { rows: convCheck } = await db.query(
      `SELECT c.id FROM conversations c JOIN customers cu ON c.customer_id = cu.id
       WHERE c.id = $1 AND cu.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (convCheck.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    await db.query(
      `DELETE FROM conversation_labels WHERE conversation_id = $1 AND label_id = $2`,
      [req.params.id, req.params.labelId]
    );

    const { rows: labels } = await db.query(
      `SELECT l.id, l.name, l.color FROM conversation_labels cl
       JOIN labels l ON cl.label_id = l.id
       WHERE cl.conversation_id = $1 ORDER BY l.name`,
      [req.params.id]
    );
    res.json({ labels });
  } catch (err) { next(err); }
});

// POST /api/portal/conversations/:id/summarize
// Advisor-triggered force summarize: re-runs full memory + soul update for a conversation.
// Useful after a human takeover session, or when the advisor wants to ensure memory is current.
router.post('/:id/summarize', async (req, res, next) => {
  try {
    // Verify the conversation belongs to this tenant
    const { rows: convRows } = await db.query(
      `SELECT co.id, co.customer_id, c.memory_file, c.soul_file,
              t.llm_api_key_encrypted, t.llm_api_key_iv, t.llm_api_key_validated,
              s.managed_ai_enabled
       FROM conversations co
       JOIN customers c ON co.customer_id = c.id
       JOIN tenants t ON c.tenant_id = t.id
       JOIN subscriptions s ON s.tenant_id = t.id
       WHERE co.id = $1 AND c.tenant_id = $2`,
      [req.params.id, req.portal.tenant_id]
    );
    if (!convRows.length) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const conv = convRows[0];

    // Respond immediately — update happens in background
    res.json({ success: true, message: 'Memory update queued — will complete in background.' });

    // Fire-and-forget force summarize
    setImmediate(async () => {
      try {
        const { rows: msgRows } = await db.query(
          'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC',
          [req.params.id]
        );
        if (!msgRows.length) return;

        const apiKey = resolveApiKey(conv);
        if (!apiKey) {
          console.warn(`[Portal] Force summarize skipped for conversation ${req.params.id} — tenant has no validated API key`);
          return;
        }
        const currentMemory = safeDecryptJson(conv.memory_file);
        const updatedMemory = JSON.parse(JSON.stringify(currentMemory || {}));

        // Force-generate a session summary regardless of message count or goodbye detection
        const summary = await generateSessionSummary({
          messages:      msgRows,
          currentMemory: updatedMemory,
          sessionType:   'regular',
          apiKey,
        });

        if (summary) {
          const sessionNum = (updatedMemory.conversation_history || []).length + 1;
          const finalMemory = applySessionSummary(updatedMemory, summary, sessionNum);

          // Persist the updated memory
          await db.query(
            'UPDATE customers SET memory_file = $1 WHERE id = $2',
            [JSON.stringify(encryptJson(finalMemory)), conv.customer_id]
          );

          // Also update conversation summary for the dashboard
          await db.query(
            `UPDATE conversations SET summary = $1, topics_covered = $2 WHERE id = $3`,
            [summary.summary, JSON.stringify(summary.topics || []), req.params.id]
          ).catch(() => {});

          console.log(`[Portal] Force summarize complete for conversation ${req.params.id}`);
        }
      } catch (err) {
        console.error('[Portal] Force summarize error:', err.message);
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
