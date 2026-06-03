/**
 * SHENMAY AI — Slack & Teams Notification Service
 *
 * Sends real-time notifications to Slack (Block Kit) and Microsoft Teams
 * (MessageCard) when key conversation events occur.
 *
 * Supported events:
 *   conversation.started   — new authenticated conversation opened
 *   conversation.escalated — concern raised / escalated
 *   handoff.requested      — customer clicked "Request human support"
 *   human.takeover         — advisor took over a conversation
 *   human.handback         — advisor handed back to AI
 *   csat.received          — customer submitted a CSAT rating
 *
 * Delivery model: fire-and-forget via setImmediate, 8s timeout, no retry
 * (notifications are best-effort — missing one is acceptable, blocking is not).
 */

'use strict';

const db = require('../db');
const { validateWebhookUrlAsync } = require('../utils/validateWebhookUrl');

const PORTAL_URL  = (process.env.PORTAL_URL || 'https://shenmay.ai').replace(/\/$/, '');
const TIMEOUT_MS  = 8_000;
const BRAND_COLOR = 'C9A84C';

// ── Event metadata ─────────────────────────────────────────────────────────────
const EVENT_META = {
  'conversation.started':   { emoji: '💬', title: 'New Conversation',          urgent: false },
  'conversation.escalated': { emoji: '🚨', title: 'Conversation Escalated',    urgent: true  },
  'handoff.requested':      { emoji: '🙋', title: 'Human Support Requested',   urgent: true  },
  'human.takeover':         { emoji: '👤', title: 'Advisor Took Over',          urgent: false },
  'human.handback':         { emoji: '🤖', title: 'Handed Back to AI',          urgent: false },
  'csat.received':          { emoji: '⭐', title: 'Customer Rating Received',   urgent: false },
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fire Slack + Teams notifications for a tenant event.
 * Non-blocking — returns immediately, dispatches in background.
 *
 * @param {string} tenantId  — tenant UUID
 * @param {string} eventType — one of EVENT_META keys
 * @param {object} data      — event payload:
 *   {
 *     conversation_id?: string,
 *     customer_name?:   string,
 *     customer_email?:  string,
 *     message_preview?: string,  // snippet of last message
 *     csat_score?:      number,  // 1 or 2
 *     agent_name?:      string,  // advisor who acted
 *   }
 */
function fireNotifications(tenantId, eventType, data = {}) {
  setImmediate(() => _dispatch(tenantId, eventType, data).catch(() => {}));
}

// ── Internal dispatch ──────────────────────────────────────────────────────────

async function _dispatch(tenantId, eventType, data) {
  const { rows } = await db.query(
    `SELECT slack_webhook_url, teams_webhook_url,
            slack_notify_events, teams_notify_events,
            name AS tenant_name
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (rows.length === 0) return;

  const t = rows[0];
  const promises = [];

  if (t.slack_webhook_url && (t.slack_notify_events || []).includes(eventType)) {
    promises.push(
      _sendSlack(t.slack_webhook_url, eventType, data, t.tenant_name)
        .catch(err => console.warn('[Notifications] Slack delivery failed:', err.message))
    );
  }

  if (t.teams_webhook_url && (t.teams_notify_events || []).includes(eventType)) {
    promises.push(
      _sendTeams(t.teams_webhook_url, eventType, data, t.tenant_name)
        .catch(err => console.warn('[Notifications] Teams delivery failed:', err.message))
    );
  }

  if (promises.length > 0) await Promise.allSettled(promises);
}

// ── Slack (Block Kit) ──────────────────────────────────────────────────────────

async function _sendSlack(url, eventType, data, tenantName) {
  const meta         = EVENT_META[eventType] || { emoji: '🔔', title: eventType, urgent: false };
  const customerLine = data.customer_name
    ? `*${data.customer_name}*${data.customer_email ? ` · ${data.customer_email}` : ''}`
    : (data.customer_email || 'Unknown customer');
  const convUrl      = _portalConvUrl(data.conversation_id);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${meta.emoji}  ${meta.title}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: customerLine },
    },
  ];

  // Context fields
  const fields = [];
  if (data.customer_email && data.customer_name) {
    fields.push({ type: 'mrkdwn', text: `*Email*\n${data.customer_email}` });
  }
  if (data.csat_score) {
    fields.push({ type: 'mrkdwn', text: `*Rating*\n${data.csat_score === 2 ? '👍  Positive' : '👎  Negative'}` });
  }
  if (data.agent_name) {
    fields.push({ type: 'mrkdwn', text: `*Advisor*\n${data.agent_name}` });
  }
  if (fields.length > 0) {
    blocks.push({ type: 'section', fields: fields.slice(0, 4) });
  }

  if (data.message_preview) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `_"${data.message_preview.slice(0, 120).replace(/"/g, '\\"')}…"_` },
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    elements: [{
      type: 'button',
      text:  { type: 'plain_text', text: 'View in Portal →', emoji: true },
      url:   convUrl,
      style: meta.urgent ? 'danger' : 'primary',
    }],
  });

  // Optional footer context
  if (tenantName) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Shenmay AI · ${tenantName}` }],
    });
  }

  await _post(url, { blocks });
}

// ── Teams (MessageCard / Legacy connector format) ──────────────────────────────

async function _sendTeams(url, eventType, data, tenantName) {
  const meta         = EVENT_META[eventType] || { emoji: '🔔', title: eventType, urgent: false };
  const customerName = data.customer_name || data.customer_email || 'Unknown customer';
  const convUrl      = _portalConvUrl(data.conversation_id);
  const color        = meta.urgent ? 'FF4444' : BRAND_COLOR;

  const facts = [];
  if (data.customer_email) facts.push({ name: 'Email',    value: data.customer_email });
  if (data.agent_name)     facts.push({ name: 'Advisor',  value: data.agent_name });
  if (data.csat_score)     facts.push({ name: 'Rating',   value: data.csat_score === 2 ? '👍 Positive' : '👎 Negative' });
  if (data.message_preview) {
    facts.push({ name: 'Last message', value: data.message_preview.slice(0, 150) });
  }

  const payload = {
    '@type':    'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: color,
    summary:    `${meta.title} — ${customerName}`,
    sections: [{
      activityTitle:    `${meta.emoji} **${meta.title}**`,
      activitySubtitle: customerName,
      facts,
    }],
    potentialAction: [{
      '@type': 'OpenUri',
      name:    'View in Portal',
      targets: [{ os: 'default', uri: convUrl }],
    }],
  };

  await _post(url, payload);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function _post(url, payload) {
  // Re-validate at send time (DNS-resolving): the stored Slack/Teams URL passed
  // a string-only check on write, but a host can resolve to an internal IP.
  const urlErr = await validateWebhookUrlAsync(url);
  if (urlErr) throw new Error(`Blocked notification URL: ${urlErr}`);

  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'User-Agent': 'Shenmay-Notifications/1.0' },
      body:     JSON.stringify(payload),
      signal:   controller.signal,
      redirect: 'manual', // block a 3xx hop to an internal host
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new Error('Notification URL attempted a redirect, which is blocked.');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 100)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function _portalConvUrl(conversationId) {
  return conversationId
    ? `${PORTAL_URL}/dashboard/conversations/${conversationId}`
    : `${PORTAL_URL}/dashboard/conversations`;
}

module.exports = { fireNotifications };
