/**
 * SHENMAY AI — Tenant Portal: Slack / Teams Connectors
 *
 * Sub-router mounted by ../portal.js at `/api/portal/connectors`.
 * All requests have already passed `requirePortalAuth` (set by the parent),
 * so `req.portal` is populated.
 *
 *   GET  /api/portal/connectors             — current Slack/Teams config
 *   PUT  /api/portal/connectors             — save URLs + event prefs (SSRF-guarded)
 *   POST /api/portal/connectors/slack/test  — fire a real test message to Slack
 *   POST /api/portal/connectors/teams/test  — fire a real test message to Teams
 *
 * These are the "lightweight" notification integrations. The richer
 * tenant_webhooks HMAC-signed flow lives in ./webhooks-routes.js.
 */

const router = require('express').Router();
const db = require('../../db');
const { validateWebhookUrl, validateWebhookUrlAsync } = require('../../utils/validateWebhookUrl');

const CONNECTOR_EVENTS = [
  'conversation.started',
  'conversation.escalated',
  'handoff.requested',
  'human.takeover',
  'human.handback',
  'csat.received',
];

// GET /api/portal/connectors — current Slack/Teams config for this tenant
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT slack_webhook_url, teams_webhook_url,
              slack_notify_events, teams_notify_events
       FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ connectors: rows[0], supported_events: CONNECTOR_EVENTS });
  } catch (err) { next(err); }
});

// PUT /api/portal/connectors — save Slack/Teams webhook URLs and event prefs
router.put('/', async (req, res, next) => {
  try {
    const { slack_webhook_url, teams_webhook_url, slack_notify_events, teams_notify_events } = req.body;

    // Validate URLs — must be HTTPS, non-private (SSRF guard), or null/empty to clear
    let cleanSlackUrl = null;
    if (slack_webhook_url && slack_webhook_url.trim()) {
      const urlErr = validateWebhookUrl(slack_webhook_url);
      if (urlErr) return res.status(400).json({ error: `Slack URL: ${urlErr}` });
      cleanSlackUrl = slack_webhook_url.trim().slice(0, 512);
    }
    let cleanTeamsUrl = null;
    if (teams_webhook_url && teams_webhook_url.trim()) {
      const urlErr = validateWebhookUrl(teams_webhook_url);
      if (urlErr) return res.status(400).json({ error: `Teams URL: ${urlErr}` });
      cleanTeamsUrl = teams_webhook_url.trim().slice(0, 512);
    }

    // Filter events to only allowed values
    const cleanSlackEvents = Array.isArray(slack_notify_events)
      ? slack_notify_events.filter(e => CONNECTOR_EVENTS.includes(e))
      : CONNECTOR_EVENTS;
    const cleanTeamsEvents = Array.isArray(teams_notify_events)
      ? teams_notify_events.filter(e => CONNECTOR_EVENTS.includes(e))
      : CONNECTOR_EVENTS;

    await db.query(
      `UPDATE tenants
       SET slack_webhook_url   = $1,
           teams_webhook_url   = $2,
           slack_notify_events = $3,
           teams_notify_events = $4
       WHERE id = $5`,
      [cleanSlackUrl, cleanTeamsUrl, cleanSlackEvents, cleanTeamsEvents, req.portal.tenant_id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/portal/connectors/slack/test — fire a test message to the configured Slack webhook
router.post('/slack/test', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT slack_webhook_url, name FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    const url = rows[0]?.slack_webhook_url;
    if (!url) return res.status(400).json({ error: 'No Slack webhook URL configured' });

    // Re-validate at fetch time (DNS-resolving): the stored URL passed a
    // string-only check on write, but a host can resolve to an internal IP.
    const urlErr = await validateWebhookUrlAsync(url);
    if (urlErr) return res.status(400).json({ error: `Slack URL: ${urlErr}` });

    const payload = {
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '✅  Shenmay AI — Connection Successful', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Your Slack integration is working correctly. You'll now receive notifications here for your configured events.\n\n*Workspace:* ${rows[0].name || 'Your company'}` } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Sent from Shenmay AI · Test message' }] },
      ],
    };

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 8000);
    try {
      const slackRes = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
        redirect: 'manual', // block a 3xx hop to an internal host
      });
      clearTimeout(timer);
      if (slackRes.type === 'opaqueredirect' || (slackRes.status >= 300 && slackRes.status < 400)) {
        return res.status(502).json({ error: 'Slack webhook attempted a redirect, which is blocked.' });
      }
      if (!slackRes.ok) {
        const body = await slackRes.text().catch(() => '');
        return res.status(502).json({ error: `Slack returned ${slackRes.status}: ${body.slice(0, 120)}` });
      }
      res.json({ ok: true });
    } catch {
      clearTimeout(timer);
      return res.status(502).json({ error: 'Could not reach Slack.' });
    }
  } catch (err) { next(err); }
});

// POST /api/portal/connectors/teams/test — fire a test message to the configured Teams webhook
router.post('/teams/test', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT teams_webhook_url, name FROM tenants WHERE id = $1`,
      [req.portal.tenant_id]
    );
    const url = rows[0]?.teams_webhook_url;
    if (!url) return res.status(400).json({ error: 'No Teams webhook URL configured' });

    // Re-validate at fetch time (DNS-resolving): the stored URL passed a
    // string-only check on write, but a host can resolve to an internal IP.
    const urlErr = await validateWebhookUrlAsync(url);
    if (urlErr) return res.status(400).json({ error: `Teams URL: ${urlErr}` });

    const payload = {
      '@type':    'MessageCard',
      '@context': 'http://schema.org/extensions',
      themeColor: 'C9A84C',
      summary:    'Shenmay AI — Connection Successful',
      sections: [{
        activityTitle:    '✅ Shenmay AI — Connection Successful',
        activitySubtitle: rows[0].name || 'Your company',
        text: 'Your Microsoft Teams integration is working correctly. You\'ll now receive notifications here for your configured events.',
      }],
    };

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), 8000);
    try {
      const teamsRes = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal,
        redirect: 'manual', // block a 3xx hop to an internal host
      });
      clearTimeout(timer);
      if (teamsRes.type === 'opaqueredirect' || (teamsRes.status >= 300 && teamsRes.status < 400)) {
        return res.status(502).json({ error: 'Teams webhook attempted a redirect, which is blocked.' });
      }
      if (!teamsRes.ok) {
        const body = await teamsRes.text().catch(() => '');
        return res.status(502).json({ error: `Teams returned ${teamsRes.status}: ${body.slice(0, 120)}` });
      }
      res.json({ ok: true });
    } catch {
      clearTimeout(timer);
      return res.status(502).json({ error: 'Could not reach Teams.' });
    }
  } catch (err) { next(err); }
});

module.exports = router;
