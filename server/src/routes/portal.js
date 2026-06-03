/**
 * SHENMAY AI — Tenant Portal Routes
 *
 * All routes require a valid portal JWT (issued by /api/onboard/login or /register).
 * These power the tenant dashboard at pontensolutions.com.
 *
 *   GET  /api/portal/me                    — Current tenant + admin profile
 *   PUT  /api/portal/company               — Update company profile
 *
 *   GET  /api/portal/products              — List products/services
 *   POST /api/portal/products              — Add a product
 *   PUT  /api/portal/products/:id          — Edit a product
 *   DELETE /api/portal/products/:id        — Remove a product
 *   POST /api/portal/products/upload       — Bulk CSV import
 *   POST /api/portal/products/ai-suggest   — AI extraction from URL or description (preview only)
 *   POST /api/portal/products/bulk-save    — Save AI-suggested products after user approval
 *
 *   GET    /api/portal/customers               — List customers (paginated)
 *   POST   /api/portal/customers/ai-map       — AI column mapping (headers + sample → mapping obj)
 *   POST   /api/portal/customers/upload       — Bulk CSV import (accepts optional mapping)
 *   PUT    /api/portal/customers/:id          — Edit a customer
 *   DELETE /api/portal/customers/:id          — Right-to-Erasure (GDPR Art.17 / CCPA §1798.105)
 *   GET    /api/portal/customers/:id/export   — Data export (GDPR Art.20 / CCPA §1798.100)
 *
 *   GET  /api/portal/dashboard                        — Stats overview
 *   GET  /api/portal/conversations                    — Conversation list
 *   GET  /api/portal/conversations/:id                — Single conversation with messages
 *   POST /api/portal/conversations/:id/takeover       — Human agent takes over from AI
 *   POST /api/portal/conversations/:id/handback       — Return control to AI agent
 *   POST /api/portal/conversations/:id/reply          — Human agent sends a message
 *   GET  /api/portal/concerns                         — Escalated / flagged conversations
 *
 *   GET  /api/portal/visitors             — Anonymous (unlogged) widget visitors
 */

const router  = require('express').Router();
const jwt     = require('jsonwebtoken');
const db      = require('../db');
const { getSubscription } = require('../middleware/subscription');
const { UNRESTRICTED_PLANS } = require('../config/plans');
const { anonEmailNotLikeGuard, anonEmailLikeMatch } = require('../constants/anonDomains');

const PORTAL_JWT_SECRET = process.env.JWT_SECRET || 'shenmay-dev-secret';

// ── Safe pagination helper ─────────────────────────────────────────────────
// Prevents NaN / out-of-range from malformed query params
function parsePage(raw, defaultVal = 1)  { const n = parseInt(raw, 10); return isNaN(n) ? defaultVal : Math.max(1, Math.min(n, 10000)); }
function parseLimit(raw, max = 100, def = 25) { const n = parseInt(raw, 10); return isNaN(n) ? def : Math.max(1, Math.min(n, max)); }

// ── Portal auth middleware ─────────────────────────────────────────────────
function requirePortalAuth(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Portal session required' });

  try {
    const payload = jwt.verify(token, PORTAL_JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload.portal) return res.status(401).json({ error: 'Invalid portal token' });
    req.portal = payload;   // { tenant_id, admin_id, email, role }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired portal session' });
  }
}

router.use(requirePortalAuth);

// Owner-gate state-changing routes (GET stays open to any authenticated seat)
// on the sensitive-config sub-routers — applied at their mounts below.
const { requireOwnerForWrites } = require('../middleware/requireOwner');


// ═══════════════════════════════════════════════════════════════════════════
// CURRENT-USER + ADMIN ACCOUNT — extracted to sub-routers
//
// /me returns the dashboard's bootstrap payload (tenant + admin +
// subscription + deployment_mode). /admin/profile + /admin/password let
// the admin update their own account; /admin/set-plan is a master-only
// override mounted alongside (same /admin prefix).
// ═══════════════════════════════════════════════════════════════════════════
router.use('/me',    require('./portal/me-routes'));
router.use('/admin', require('./portal/admin-routes'));

// ═══════════════════════════════════════════════════════════════════════════
// SETTINGS / COMPANY / EMAIL TEMPLATES — extracted to sub-routers
//
// settings-routes.js owns the full /api/portal/settings/* surface (privacy
// + anon-only-mode + data-api-key CRUD + agent-soul + generate-soul). The
// company profile editor and email-template customization each got their
// own file — different prefix, different concern.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/settings',        require('./portal/settings-routes'));
router.use('/company',         require('./portal/company-routes'));
router.use('/email-templates', require('./portal/email-templates-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// PRODUCTS / SERVICES — extracted to ./portal/products-routes.js
// ═══════════════════════════════════════════════════════════════════════════
router.use('/products', require('./portal/products-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// CUSTOMERS — extracted to ./portal/customers-routes.js
//
// All /api/portal/customers/* routes (CSV import, paginated list, detail with
// soul + memory, GDPR erasure + export, customer_data CRUD) live in the
// sub-router. /search stays inline below — it bridges customers AND
// conversations and doesn't share a single prefix.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/customers', require('./portal/customers-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// BRAND LEARNING — anon-visitor learning loop, see docs/BRAND_LEARNING_SCOPE.md
// Read-only by default; toggle/run-now/kill-switch are owner-gated inside.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/brand-learning', require('./portal/brand-learning-routes'));


// GET /api/portal/search — unified search across customers + conversations
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().slice(0, 200);
    if (!q) return res.json({ customers: [], conversations: [] });

    const tid = req.portal.tenant_id;
    const pattern = `%${q}%`;

    const [{ rows: customers }, { rows: conversations }] = await Promise.all([
      // Customer search: name or email
      db.query(
        `SELECT id, email,
                COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), email) AS display_name,
                first_name, last_name, onboarding_status, last_interaction_at
         FROM customers
         WHERE tenant_id = $1 AND deleted_at IS NULL
           AND ${anonEmailNotLikeGuard()}
           AND (
             first_name ILIKE $2 OR last_name ILIKE $2 OR email ILIKE $2 OR
             (first_name || ' ' || last_name) ILIKE $2
           )
         ORDER BY last_interaction_at DESC NULLS LAST
         LIMIT 10`,
        [tid, pattern]
      ),

      // Conversation search: last message content or customer name
      db.query(
        `SELECT c.id, c.status, c.created_at,
                cu.id AS customer_id,
                COALESCE(NULLIF(TRIM(cu.first_name || ' ' || cu.last_name), ''), cu.email) AS customer_display_name,
                cu.email,
                (SELECT content FROM messages WHERE conversation_id = c.id
                 AND content ILIKE $2
                 ORDER BY created_at DESC LIMIT 1) AS matching_message,
                (SELECT created_at FROM messages WHERE conversation_id = c.id
                 ORDER BY created_at DESC LIMIT 1) AS last_message_at
         FROM conversations c
         JOIN customers cu ON c.customer_id = cu.id
         WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id AND m.content ILIKE $2
           )
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT 10`,
        [tid, pattern]
      ),
    ]);

    res.json({ customers, conversations, query: q });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD & CONVERSATIONS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/portal/dashboard  — stats overview
router.get('/dashboard', async (req, res, next) => {
  try {
    const tid = req.portal.tenant_id;

    const [totalConvs, activeCustomers, totalCustomers, anonVisitors, recentConvs, totalMessages, concerns] =
      await Promise.all([
        db.query(
          `SELECT COUNT(*) FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL`,
          [tid]
        ),
        db.query(
          `SELECT COUNT(DISTINCT c.customer_id)
           FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL
             AND c.created_at > NOW() - INTERVAL '30 days'
             AND ${anonEmailNotLikeGuard('cu.email')}`,
          [tid]
        ),
        db.query(
          `SELECT COUNT(*) FROM customers
           WHERE tenant_id = $1 AND deleted_at IS NULL
             AND ${anonEmailNotLikeGuard()}`,
          [tid]
        ),
        db.query(
          `SELECT COUNT(*) FROM customers
           WHERE tenant_id = $1 AND deleted_at IS NULL
             AND ${anonEmailLikeMatch()}`,
          [tid]
        ),
        db.query(
          `SELECT c.id, c.status, c.created_at,
                  CASE
                    WHEN ${anonEmailLikeMatch('cu.email')} THEN 'Anonymous Visitor'
                    ELSE COALESCE(cu.soul_file->>'customer_name', NULLIF(TRIM(cu.first_name || ' ' || cu.last_name), ''), cu.email)
                  END AS customer_display_name,
                  cu.email,
                  ${anonEmailLikeMatch('cu.email')} AS is_anonymous,
                  (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                  (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at,
                  (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) AS message_count
           FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL
           ORDER BY COALESCE(
             (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1),
             c.created_at
           ) DESC LIMIT 10`,
          [tid]
        ),
        db.query(
          `SELECT COUNT(*) FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL`,
          [tid]
        ),
        db.query(
          `SELECT COUNT(*) FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1 AND cu.deleted_at IS NULL AND c.status = 'escalated'`,
          [tid]
        ),
      ]);

    res.json({
      stats: {
        total_conversations:  parseInt(totalConvs.rows[0].count),
        active_customers_30d: parseInt(activeCustomers.rows[0].count),
        total_customers:      parseInt(totalCustomers.rows[0].count),
        anonymous_visitors:   parseInt(anonVisitors.rows[0].count),
        total_messages:       parseInt(totalMessages.rows[0].count),
        open_concerns:        parseInt(concerns.rows[0].count),
      },
      recent_conversations: recentConvs.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/portal/analytics?period=7d|30d|90d  — time-series chart data
router.get('/analytics', async (req, res, next) => {
  try {
    const tid = req.portal.tenant_id;
    const VALID_PERIODS = { '7d': 7, '30d': 30, '90d': 90 };
    const days = VALID_PERIODS[req.query.period] || 30;

    const [dailyMessages, dailyConversations, topCustomers, periodConvs, periodMsgs] =
      await Promise.all([
        // Daily message volume
        db.query(
          `SELECT DATE(m.created_at) AS day, COUNT(*)::int AS count
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1
             AND cu.deleted_at IS NULL
             AND m.created_at >= NOW() - make_interval(days => ${Number(days)})
           GROUP BY DATE(m.created_at)
           ORDER BY day`,
          [tid]
        ),
        // Daily conversation stats (total started + escalated)
        db.query(
          `SELECT DATE(c.created_at) AS day,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE c.status = 'escalated')::int AS escalated
           FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1
             AND cu.deleted_at IS NULL
             AND c.created_at >= NOW() - make_interval(days => ${Number(days)})
           GROUP BY DATE(c.created_at)
           ORDER BY day`,
          [tid]
        ),
        // Top 5 customers by message count in period (excluding anonymous)
        db.query(
          `SELECT
             cu.id,
             COALESCE(
               cu.soul_file->>'customer_name',
               NULLIF(TRIM(cu.first_name || ' ' || cu.last_name), ''),
               cu.email
             ) AS name,
             COUNT(m.id)::int AS message_count,
             COUNT(DISTINCT c.id)::int AS conversation_count
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1
             AND cu.deleted_at IS NULL
             AND ${anonEmailNotLikeGuard('cu.email')}
             AND m.created_at >= NOW() - make_interval(days => ${Number(days)})
           GROUP BY cu.id, name
           ORDER BY message_count DESC
           LIMIT 5`,
          [tid]
        ),
        // Period conversation summary (includes avg advisor score)
        db.query(
          `SELECT
             COUNT(*)::int AS total_conversations,
             COUNT(*) FILTER (WHERE c.status = 'escalated')::int AS escalated,
             COUNT(*) FILTER (WHERE c.status = 'ended')::int AS resolved,
             ROUND(AVG(c.conversation_score) FILTER (WHERE c.conversation_score IS NOT NULL), 1)::float AS avg_score,
             COUNT(*) FILTER (WHERE c.conversation_score IS NOT NULL)::int AS scored_count
           FROM conversations c
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1
             AND cu.deleted_at IS NULL
             AND c.created_at >= NOW() - make_interval(days => ${Number(days)})`,
          [tid]
        ),
        // Period message total
        db.query(
          `SELECT COUNT(*)::int AS total_messages
           FROM messages m
           JOIN conversations c ON m.conversation_id = c.id
           JOIN customers cu ON c.customer_id = cu.id
           WHERE cu.tenant_id = $1
             AND cu.deleted_at IS NULL
             AND m.created_at >= NOW() - make_interval(days => ${Number(days)})`,
          [tid]
        ),
      ]);

    const conv = periodConvs.rows[0] || {};
    res.json({
      period_days:          days,
      daily_messages:       dailyMessages.rows,
      daily_conversations:  dailyConversations.rows,
      top_customers:        topCustomers.rows,
      summary: {
        total_conversations: conv.total_conversations || 0,
        escalated:           conv.escalated || 0,
        resolved:            conv.resolved || 0,
        total_messages:      periodMsgs.rows[0]?.total_messages || 0,
        avg_score:           conv.avg_score ?? null,
        scored_count:        conv.scored_count || 0,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CONVERSATIONS — extracted to ./portal/conversations-routes.js
//
// All /api/portal/conversations/* routes (list, score, detail, transcript,
// takeover, handback, reply, label attach/detach, bulk, summarize) live in
// the sub-router. requirePortalAuth set by parent.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/conversations', require('./portal/conversations-routes'));

// LABELS CRUD — extracted to ./portal/labels-routes.js
// (Conversation-attached label POST/DELETE moved into conversations-routes.js
// since they share the /conversations/:id path prefix.)
router.use('/labels', require('./portal/labels-routes'));

// CONCERNS + BADGE-COUNTS — extracted to ./portal/{concerns,badge-counts}-routes.js
// Inbox-side endpoints: list escalated conversations, mark resolved, and the
// unread-counters used by nav badges. req.portal set by parent.
router.use('/concerns',     require('./portal/concerns-routes'));
router.use('/badge-counts', require('./portal/badge-counts-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// ANONYMOUS VISITORS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/portal/visitors  — anonymous (unlogged) widget visitors
// These are sessions where the host page didn't supply a user email,
// so we auto-generated anon_<uuid>@visitor.shenmay as the identifier
// (migration 033 unified all legacy @visitor.nomii rows onto @visitor.shenmay —
// see server/src/constants/anonDomains.js).
router.get('/visitors', async (req, res, next) => {
  try {
    const page   = parsePage(req.query.page);
    const limit  = parseLimit(req.query.limit);
    const offset = (page - 1) * limit;

    const { rows } = await db.query(
      `SELECT
         cu.id,
         'Anonymous Visitor' AS display_name,
         cu.last_interaction_at,
         cu.created_at,
         CASE
           WHEN cu.last_interaction_at IS NOT NULL
           THEN ROUND(EXTRACT(EPOCH FROM (NOW() - cu.last_interaction_at)) / 60)
           ELSE NULL
         END AS idle_minutes,
         (SELECT COUNT(*) FROM conversations c WHERE c.customer_id = cu.id) AS conversation_count,
         (SELECT COUNT(*) FROM messages m
          JOIN conversations c ON m.conversation_id = c.id
          WHERE c.customer_id = cu.id) AS message_count
       FROM customers cu
       WHERE cu.tenant_id = $1
         AND cu.deleted_at IS NULL
         AND ${anonEmailLikeMatch('cu.email')}
       ORDER BY cu.last_interaction_at DESC NULLS LAST, cu.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.portal.tenant_id, limit, offset]
    );

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM customers
       WHERE tenant_id = $1 AND deleted_at IS NULL
         AND ${anonEmailLikeMatch()}`,
      [req.portal.tenant_id]
    );

    res.json({
      visitors: rows,
      total:    parseInt(countRows[0].count),
      page,
      limit,
    });
  } catch (err) { next(err); }
});


// ═══════════════════════════════════════════════════════════════════════════
// SELF-HOSTED LICENSE MANAGEMENT — extracted to ./portal/license-routes.js
// ═══════════════════════════════════════════════════════════════════════════
router.use('/license', require('./portal/license-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION SUMMARY — extracted to ./portal/subscription-routes.js
// Single GET that returns plan + usage + percentage display data.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/subscription', require('./portal/subscription-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// TEAM / AGENT MANAGEMENT — extracted to ./portal/team-routes.js
// ═══════════════════════════════════════════════════════════════════════════
router.use('/team', require('./portal/team-routes')); // owner||member gate is inline (co-admins manage the team)

// ═══════════════════════════════════════════════════════════════════════════
// API KEY MANAGEMENT — extracted to ./portal/api-key-routes.js
// ═══════════════════════════════════════════════════════════════════════════
router.use('/api-key', requireOwnerForWrites, require('./portal/api-key-routes'));


// ═══════════════════════════════════════════════════════════════════════════
// STRIPE BILLING — extracted to ./portal/billing-routes.js
// POST /billing/checkout (start upgrade) + POST /billing/portal (manage existing).
// All STRIPE_* env-var reads + lazy stripe-client init live in the sub-router.
// ═══════════════════════════════════════════════════════════════════════════
router.use('/billing', require('./portal/billing-routes'));


// GET /api/portal/plans  — available plans for the upgrade page
router.get('/plans', async (req, res) => {
  res.json({
    plans: [
      {
        id: 'starter',
        name: 'Starter',
        price: '$49/mo',
        max_customers: 50,
        max_messages: 1000,
        managed_ai: false,
        features: [
          'Up to 50 customers',
          '1,000 messages/month',
          'Bring your own API key',
          'Full dashboard access',
          'Email support',
        ],
      },
      {
        id: 'growth',
        name: 'Growth',
        price: '$149/mo',
        max_customers: 250,
        max_messages: 5000,
        managed_ai: false,
        popular: true,
        features: [
          'Up to 250 customers',
          '5,000 messages/month',
          'Bring your own API key',
          'Priority support',
          'Advanced analytics',
          'Custom branding',
        ],
      },
      {
        id: 'professional',
        name: 'Professional',
        price: '$399/mo',
        max_customers: 1000,
        max_messages: 25000,
        managed_ai: false,
        features: [
          'Up to 1,000 customers',
          '25,000 messages/month',
          'Bring your own API key',
          'Dedicated support',
          'API access',
          'White-label options',
          'Custom integrations',
        ],
      },
    ],
  });
});


// CUSTOM TOOLS — extracted to ./portal/tools-routes.js
// Self-service tool builder (CRUD) + /:toolId/test sandbox. All routes scoped
// to req.portal.tenant_id; req.portal is populated by requirePortalAuth.
router.use('/tools', requireOwnerForWrites, require('./portal/tools-routes'));




// ── Integrations — extracted to ./portal/{connectors,webhooks}-routes.js ──────
// Slack / Teams lightweight notifications lives in connectors-routes.js;
// the rich HMAC-signed tenant_webhooks flow lives in webhooks-routes.js.
router.use('/connectors', requireOwnerForWrites, require('./portal/connectors-routes'));
router.use('/webhooks',   requireOwnerForWrites, require('./portal/webhooks-routes'));




// NOTIFICATIONS — extracted to ./portal/notifications-routes.js
// Bell-icon notifications list + mark-read. req.portal set by parent.
router.use('/notifications', require('./portal/notifications-routes'));


module.exports = router;


