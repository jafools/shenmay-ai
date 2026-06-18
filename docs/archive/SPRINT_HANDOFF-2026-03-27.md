> **HISTORICAL — frozen, no longer maintained.** Point-in-time artifact kept for reference only.
> For current state see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md). Archived 2026-06-18 (audit M3/T15).
> (Previously tracked at repo root as `SPRINT_HANDOFF.md`, which is also `.gitignore`d; renamed on archive to keep it tracked.)

---

# Shenmay AI — Sprint Handoff Notes
**Last updated:** 2026-03-27
**Status:** Sprints 1–3 complete, ready to push/pull/rebuild

---

## Deploy checklist (run on server)

```bash
cd ~/Knomi/knomi-ai
git pull
# Run new migrations (in order)
docker compose exec db psql -U nomii -d nomii -f /migrations/024_labels.sql
docker compose exec db psql -U nomii -d nomii -f /migrations/025_csat.sql
docker compose exec db psql -U nomii -d nomii -f /migrations/026_connectors.sql
docker compose up --build -d
```

---

## Sprint 1 — Widget Conversation History

### What was built
When a returning authenticated user opens the widget, they now see their recent conversation history rendered before the AI greeting. Sessions are separated by date-aware dividers ("Yesterday", "3 days ago", etc.) and days are separated within a session.

### Key files changed
- `server/public/widget.html` — conversation history rendering, session/day dividers, system message styling (`.msg.system` pills), CSAT overlay

### How it works
- `/api/widget/session` already returns `recent_messages[]` — the widget now renders these before firing the greeting
- History messages render without the fade animation (feels like memory, not new messages)
- Emoji-starting messages (👋 greeting, 🤖 handback) are detected and rendered as centered `.msg.system` pills instead of agent bubbles

---

## Sprint 2 — Labels, CSAT, Bulk Operations

### Migrations
- `server/db/migrations/024_labels.sql` — `labels` table + `conversation_labels` junction table
- `server/db/migrations/025_csat.sql` — adds `csat_score`, `csat_comment`, `csat_submitted_at` to `conversations`

### CSAT (Customer Satisfaction)
- Binary thumbs up (score=2) / thumbs down (score=1) overlay shown when customer closes the widget
- Only shown for authenticated users who have exchanged at least one message; skip button always available
- Fire-and-forget — never blocks the close flow
- Displayed in portal conversation list (thumbs icon) and detail view (green/red banner)
- `POST /api/widget/csat` — protected by widget JWT; idempotent (won't overwrite an existing rating)

### Labels
- Tenant-scoped, per-conversation tags with custom colors
- CRUD via `GET/POST/PUT/DELETE /api/portal/labels`
- Assign/remove per conversation: `POST/DELETE /api/portal/conversations/:id/labels/:labelId`
- Inline picker in conversation detail view; chips shown in conversation list
- Managed in Settings → Conversation Labels section

### Bulk Operations
- Select multiple conversations via checkboxes in the list
- Floating toolbar appears: Resolve all, Apply label, Clear selection
- `POST /api/portal/conversations/bulk` — actions: `resolve`, `assign`, `label`, `unlabel`; max 100 ids
- All operations are tenant-scoped (server verifies ownership)

### Key files changed
- `server/src/routes/portal.js` — labels CRUD, bulk route, CSAT display in conv list/detail
- `server/src/routes/widget.js` — `POST /api/widget/csat` endpoint
- `client/src/lib/nomiiApi.js` — label and bulk API functions
- `client/src/pages/nomii/dashboard/NomiiConversations.jsx` — checkboxes, bulk toolbar, CSAT icons, label chips
- `client/src/pages/nomii/dashboard/NomiiConversationDetail.jsx` — label picker, CSAT banner
- `client/src/pages/nomii/dashboard/NomiiSettings.jsx` — `LabelsSection` component

---

## Sprint 3 — Slack, Teams & Zapier Connectors

### Migration
- `server/db/migrations/026_connectors.sql` — adds `slack_webhook_url`, `teams_webhook_url`, `slack_notify_events[]`, `teams_notify_events[]` to `tenants`

### Architecture
The notification system is **separate** from the existing webhook system:
- **Webhooks** (`webhookService.js`) — developer-facing outgoing HTTP payloads, any URL, raw JSON
- **Connectors** (`notificationService.js`) — human-friendly Slack Block Kit / Teams MessageCard messages

Both systems fire in parallel for overlapping events. Neither blocks the request path (fire-and-forget via `setImmediate`).

### Notification events
| Event | Emoji | Urgent |
|-------|-------|--------|
| `conversation.started` | 💬 | No |
| `conversation.escalated` | 🚨 | Yes |
| `handoff.requested` | 🙋 | Yes |
| `human.takeover` | 👤 | No |
| `human.handback` | 🤖 | No |
| `csat.received` | ⭐ | No |

Urgent events render the Slack action button in `danger` (red) style and Teams card in `FF4444` red.

### Where `fireNotifications()` is called
- `widget.js` → `/flag` route → fires `handoff.requested`
- `widget.js` → `/csat` route → fires `csat.received`
- `portal.js` → `/conversations/:id/takeover` route → fires `human.takeover`
- `portal.js` → `/conversations/:id/handback` route → fires `human.handback`

> Note: `conversation.started` and `conversation.escalated` are defined in `EVENT_META` but not yet wired to a call site. Wire them when ready (e.g. session start, auto-escalation logic).

### API routes added to portal.js
```
GET  /api/portal/connectors                   — fetch current config
PUT  /api/portal/connectors                   — save URLs + event prefs
POST /api/portal/connectors/slack/test        — send test Block Kit message
POST /api/portal/connectors/teams/test        — send test MessageCard
```

`PUT /connectors` silently nullifies non-https URLs. Event arrays are filtered to the allowed set on the server side.

### `VALID_WEBHOOK_EVENTS` extended
Added `human.takeover`, `human.handback`, `csat.received` to the webhooks system so tenants can subscribe to these events via the existing webhooks UI too.

### Zapier
No dedicated Zapier integration — the existing webhook system is already Zapier-compatible. The Zapier tab in Settings explains the connection flow and lists supported events with their payload keys.

### Key files changed
- `server/src/services/notificationService.js` — **new file** — core Slack + Teams dispatch service
- `server/src/routes/portal.js` — connector CRUD routes, `fireNotifications` wired to takeover/handback, `VALID_WEBHOOK_EVENTS` extended
- `server/src/routes/widget.js` — `fireNotifications` wired to flag and CSAT routes
- `client/src/lib/nomiiApi.js` — `getConnectors`, `updateConnectors`, `testSlack`, `testTeams`
- `client/src/pages/nomii/dashboard/NomiiSettings.jsx` — `ConnectorsSection` component (Slack / Teams / Zapier tabs)

### UI: ConnectorsSection (Settings page)
Three-tab panel at the bottom of Settings:
- **Slack tab**: HTTPS webhook URL (hidden/show toggle), event checkboxes, "Send test message" button, Save
- **Teams tab**: same layout as Slack
- **Zapier tab**: informational — lists all supported events with their `event.name` keys and a 4-step setup guide

---

## Security hardening applied this session

A full security audit was performed. All CRITICAL and HIGH severity findings were fixed:

| Severity | Finding | Fix |
|----------|---------|-----|
| CRITICAL | Hardcoded dev JWT/encryption secrets accepted in production | `index.js` — startup check now logs a warning in dev and **calls `process.exit(1)`** in production if `JWT_SECRET`, `WIDGET_JWT_SECRET`, or `API_KEY_ENCRYPTION_SECRET` match any known-bad default value |
| HIGH | Weak password validation (6 chars only, no complexity) | `authService.js` — `validatePasswordStrength()` now requires ≥ 8 chars plus at least one uppercase, one lowercase, and one digit |
| HIGH | SSRF on webhook/connector URLs (private IPs allowed) | New `server/src/utils/validateWebhookUrl.js` — blocks localhost, loopback (127.x), private ranges (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), zero address, IPv6 ULA/link-local, and URLs with embedded credentials. Applied to: `POST /webhooks`, `PATCH /webhooks/:id`, `PUT /connectors` |
| HIGH | NaN bypass on pagination params | `portal.js` — `parsePage()` / `parseLimit()` helpers with explicit `isNaN` guard, radix-10 parseInt, and hard bounds (max page 10,000; max limit 100) replace all three raw `parseInt(req.query.*)` call sites |
| HIGH | Login rate limit too permissive (5/15 min) | `index.js` — reduced to **3 attempts per 15 min** per IP |
| MEDIUM | Error handler leaking internal server error messages | `index.js` — 5xx errors now return a generic "An unexpected error occurred" message; 4xx errors still surface their original message (they're intentional/expected) |

MEDIUM and LOW findings (CSRF, CSP headers on widget, console log cleanup, DB connection hardening) are noted in backlog — none are exploitable on their own given the current architecture.

---

## Bug fixes applied this session

1. **`notificationService.js` line 108** — Removed invalid `accessory: { type: 'plain_text_input' }` from Slack Block Kit section block. Slack rejects payloads with unknown accessory types; the tenant name is already shown in the footer context block.

2. **`ConnectorsSection` useEffect** — `getConnectors()` returns `{ connectors: {...}, supported_events: [...] }` but the component was reading `.slack_webhook_url` directly from the top-level response. Fixed to destructure via `d.connectors`.

---

## Environment variables (all already used)
```
PORTAL_URL=https://portal.pontensolutions.com   # used in deep-link URLs in notifications
JWT_SECRET=...                                   # portal auth
```
No new env vars needed for Sprint 3.

---

## Next sprint ideas (backlog)

- **Wire `conversation.started`** — call `fireNotifications(tenantId, 'conversation.started', ...)` from the `/api/widget/session` route when a new conversation is created
- **Wire `conversation.escalated`** — auto-escalation based on sentiment / keyword triggers
- **Notification inbox** — in-portal bell icon already exists; consider surfacing connector failures
- **Email digest** — daily summary of CSAT, conversation counts, escalations
- **Webhook delivery log** — show recent delivery attempts + status codes in Settings
- **Mobile push notifications** — PWA-style if portal is added to homescreen
- **On-prem / enterprise tier** — discussed and deferred; flagged for future product planning
