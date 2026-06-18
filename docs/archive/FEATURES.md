> **HISTORICAL — frozen, no longer maintained.** This inventory stops at Session 20 (pre-v3.4) and is kept for reference only.
> For current state see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md). Archived 2026-06-18 (audit M3/T16).

---

# Shenmay AI — Feature Inventory
*Last updated: 2026-03-27 (Session 20)*

> Frozen snapshot, organized by product area. For session-by-session history see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md).

---

## AI Agent

### Conversational Widget
- Drop-in script tag embed (`<script src="...embed.js" data-key="...">`) — works on any website
- Floating chat bubble with customizable position (bottom-left / bottom-right), colors, and greeting message
- Full chat UI inside a sandboxed iframe — no CSS conflicts with host page
- **Anonymous visitor chat** — unauthenticated visitors chat freely; anon sessions use ephemeral `anon_XXXX@visitor.shenmay` records (legacy `@visitor.nomii` still recognised during the Phase 5 rebrand — see [`server/src/constants/anonDomains.js`](server/src/constants/anonDomains.js)) with `is_anonymous: true` JWT; no persistent profile built unless customer already exists in tenant's system; anon records soft-deleted after claim
- **Seamless auth handoff (session claim)** — the moment a visitor authenticates on the host site, the embed script sends a `shenmay:identify` postMessage to the widget (no iframe reload); widget calls `POST /api/widget/session/claim` which migrates the conversation to the real customer via a single `UPDATE conversations SET customer_id` — conversation history preserved, polling continuity maintained, "✓ Signed in as [Name]" banner shown in chat
- `shenmay:setUser` postMessage: login → in-place identity claim; logout → widget reload
- `MutationObserver` on script tag for non-SPA sites: watches `data-user-email` / `data-user-name` attribute changes, triggers same login/logout split
- Widget key authentication — each tenant has a unique key that scopes all conversations
- Background poll for incoming messages (AI mode: 5s, human takeover mode: 2.5s)
- **Proactive AI greeting for returning users** — on session start, Haiku generates a personalized "welcome back" message using a priority chain: (1) open action items from last session ("Did you get a chance to X?"), (2) session summary text, (3) topic slugs. Emotional tone from last session modulates warmth. Typing indicator shown while loading; falls back to static greeting after 5s

### Soul System (Agent Identity)
- Two-layer soul: `agent_soul_template` (tenant-level blueprint) → seeded into per-customer `soul_file` → evolves over time
- Soul schema: `base_identity` (agent name, org, role), `communication_style` (tone, complexity, pacing, key principles, avoid/prefer phrases), `compliance` (disclaimers, restricted topics, escalation triggers)
- Agent personality and compliance rules injected into every system prompt automatically
- Customer can name their agent mid-conversation — name saved to soul file permanently
- Soul auto-generated via Claude Haiku when tenant saves their API key or updates company profile
- Rule-based fallback soul for 8 industry verticals (financial, retirement, ministry, healthcare, insurance, education, ecommerce, other) when LLM unavailable
- Manual regenerate button in portal settings

### Memory Persistence (Real-Time, Per-Exchange)
Every chat exchange triggers three background operations — none block the response:

**Fact extraction (every message)**
- Claude Haiku extracts explicitly stated personal facts: name, age, location, family, career, goals, concerns
- Deep-merged into `memory_file` — never overwrites, only fills gaps
- Keyword-regex fallback when no API key available
- Wired into both `chat.js` (advisor-chat path) and `widget.js` (customer-facing path) — every exchange, no checkpoints

**Session summaries (on goodbye detection or every 20 messages)**
- Goodbye/end-of-conversation patterns detected automatically
- Haiku generates structured summary: topics covered, key insights, action items, emotional tone, session quality
- Appended to `memory_file.conversation_history` with date + metadata
- Any flags triggered during the session are attached to the summary record
- `conversations.summary` and `conversations.topics_covered` also written for advisor dashboard

**Soul evolution (every 5 messages)**
- Haiku detects communication style signals: complexity preference, tone, pacing shifts
- Updates `soul_file.communication_style` — the agent gradually calibrates to this specific customer
- Silent no-op when no API key available

**Memory + soul encryption (AES-256-GCM)**
- `memory_file` and `soul_file` columns encrypted at rest using `cryptoService.js` (`encryptJson` / `safeDecryptJson`)
- Transparent sentinel format `{ __enc, __iv }` — all read/write paths handle transparently
- Applied across `widget.js`, `memoryUpdater.js`, `promptBuilder.js`, `portal.js`, `soulGenerator.js`

### Agentic Tool System
- Full Claude tool-use loop: agent calls tool → executor runs it → result fed back → agent continues (up to 6 rounds)
- Tools are configuration, not code — non-technical tenants fill out a form, system generates tool config
- 5 universal tool types:

| Tool | What it does |
|------|-------------|
| `lookup_client_data` | Fetches customer records grouped by category |
| `analyze_client_data` | Computes aggregates: totals, monthly figures, category breakdowns |
| `generate_report` | Assembles structured report (title, summary, sections, next steps, disclaimer) and logs it to customer data |
| `send_document` | Emails a formatted HTML document to the customer's address on file; logs delivery to dashboard |
| `request_specialist` | Creates a DB flag and optionally escalates the conversation |
| `connect` (webhook) | Calls a tenant-configured external URL (bearer or API key auth) at query time — Live Connector tier |

- Per-tenant tool descriptions override defaults — same code, different framing per industry
- Tenants with no tools configured run in pure conversation mode — zero change to behavior

### Tool Test Sandbox + Real Customer Mode
- **Test button on all active tool types** (not just connect) — opens a full sandbox modal
- **Mode toggle**: "🧪 Sandbox" (fake customer data, no real records) vs "👤 Real customer" (live data)
- **Real customer picker**: searchable dropdown fetching tenant's actual customer list; tip to use an employee's own profile for safe testing
- **Context-aware warnings**: escalate always simulated (no flag/email regardless of mode); report in real mode notes a log record will be written; sandbox modes note no real data used
- **Test executor**: `escalate` type always simulated; all other types (`lookup`, `calculate`, `report`, `connect`) execute for real against the selected customer's actual data
- **Result panel**: ✓/✗ status, agent response, real customer's name badge, collapsible tool I/O JSON
- Uses the tenant's configured API key — real API call, counts toward quota (warned in UI)

### Onboarding Flow
- 5-step wizard: company profile → widget setup → API key → product catalog → first customer
- Tracks step completion per tenant; picks up where you left off
- Agent soul auto-generates in background when API key step is completed

---

## Customer Data Infrastructure

### Three-Tier Data Model
| Tier | How data enters Shenmay | Best for |
|------|-----------------------|----------|
| **CSV Upload** | Spreadsheet upload from the portal | Small teams, non-technical |
| **Data API** | Push via REST API (`POST /api/v1/`) | CRM integrations, nightly syncs, developers |
| **Live Connector** | Shenmay calls the tenant's own API at query time — data never stored | Regulated industries, privacy-first firms |

### CSV Upload
- Drag-and-drop upload in portal
- AI-powered column mapping — headers + sample rows → Claude suggests the mapping
- Bulk upsert with category/label/value schema

### Data API (`/api/v1/`)
- Auth: `Authorization: Bearer shenmay_da_<key>` (canonical) or `Bearer nomii_da_<key>` (legacy, accepted until 2026-10-20) — prefix lookup + bcrypt verification
- `POST /api/v1/customers` — upsert customer by `external_id`
- `POST /api/v1/customers/:external_id/records` — bulk upsert up to 1,000 records; `replace_category` flag for full re-syncs
- `GET /api/v1/customers` — list with search + pagination
- `GET /api/v1/customers/:external_id/records` — fetch records grouped by category
- `DELETE /api/v1/customers/:external_id/records[/:category]` — clear all or one category
- Per-key rate limiting: 120 req/min (configurable via `DATA_API_RATE_LIMIT` env var)

### Customer Data UI (Portal)
- View all records grouped by category on customer detail page
- Add individual records (category, label, value, value_type)
- Delete single records or clear entire categories (with confirmation)

---

## Tenant Portal / Dashboard

### Dashboard Overview
- Stats: total customers, conversations today/week, messages sent, flags raised
- Quick-access to concerns and recent conversations

### Customer Management
- List with search, pagination, filter by status
- Customer detail: profile, all conversations, data records, memory summary, flags
- Right-to-erasure: DELETE anonymises all PII and soft-deletes the customer record

### Conversation Monitoring
- Full conversation history with message-level timestamps
- System prompt inspector (debug endpoint) — shows exactly what the agent sees
- Unread badge on Conversations nav (resets when advisor opens)
- **Visual triage indicators in conversation list**: yellow dot + bold name + yellow left border for unread conversations; green "HUMAN" badge when advisor has taken over; red "ESCALATED" badge for escalated conversations
- **Search + filter**: free-text search bar (debounced 300ms) + status pills (All / Open / Human / Escalated / Ended) + mode pills (All / AI / Human / Anonymous) + Unread toggle + result count

### Concerns / Flag System
- Automatic keyword-based flag detection on every message:
  - `exploitation_concern` (critical) — wire transfer, gift cards, "gave them my..."
  - `high_emotion` (medium) — panic, terrified, can't sleep
  - `escalation` (high) — large withdrawal requests
  - `advisor_requested` (medium) — customer asks for a human
- Each flag stored in DB with type, severity, description, conversation link
- Assigned to primary advisor automatically
- Red concerns badge in sidebar (unread count)
- "Jump In" CTA on unread concerns
- **Concern resolution** — green "Resolve" button on each concern; sets conversation status to `ended`; optimistic removal from list on success; prevents concern list from growing indefinitely

### In-App Notification Bell
- Bell icon in top-bar with red unread count badge
- Polls every 15 seconds for new notifications; also refreshes on bell open
- Notification types: `flag` (🚩 red), `human_reply` (💬 blue), `escalation` (📢 orange)
- Dropdown panel: unread notifications shown with left border accent, relative timestamps, customer name
- "Mark all read" button + individual click-to-navigate to the relevant conversation
- Click-outside dismissal
- `notifications` table (migration 022): `tenant_id`, `type`, `title`, `body`, `resource_type`, `resource_id`, `customer_name`, `read_at`; indexed on `(tenant_id, read_at) WHERE read_at IS NULL`

### Advisor Email Notifications
- Immediate email to assigned advisor when a flag is triggered
- Severity-coded HTML: critical=red, high=orange, medium=yellow, low=green
- Includes customer name, flag type, description excerpt, and dashboard CTA link
- Fire-and-forget — never delays the chat response

### Human Takeover
- Advisor clicks "Take Over" → conversation switches from AI to human mode
- Widget polls faster in human mode (2.5s vs 5s)
- Advisor types replies directly in the dashboard
- "Hand Back" returns control to the AI agent
- All messages timestamped and attributed (agent vs advisor)
- **Customer reply notification** — when customer sends a message in human mode, a fire-and-forget branded email is sent to the assigned advisor (or all admins as fallback) with the message snippet and a "Reply Now" deep-link to the conversation

### Manual Memory Sync
- `POST /api/portal/conversations/:id/summarize` — force memory + soul update for any conversation
- Responds immediately; update runs in background
- Useful after human takeover sessions or whenever advisor wants agent fully up-to-date
- **"⚡ Sync" button** on each conversation row in the customer detail page — one click queues a background sync

### Team Management
- Invite advisors/agents by email (7-day token, branded HTML invite email)
- Plan-enforced agent seat limits (Starter: 10, Growth: 25, Professional: 100)
- Capacity bar showing seats used vs available
- Remove agents with one click

### Soul Settings
- View current `agent_soul_template`: base identity, key principles, compliance rules
- "Generate" / "Regenerate" button — triggers Claude Haiku soul generation
- Auto-regenerates in background when company name, agent name, vertical, or description changes

### Webhook Management
- Tenants configure outbound webhooks from the Settings page
- Each webhook has: label, target URL, subscribed events (multi-select), enable/disable toggle
- Supported events: `session.started`, `session.ended`, `customer.created`, `flag.created`, `concern.raised`
- HMAC-SHA256 signing: every POST carries `X-Shenmay-Signature` header for payload verification
- Secret shown once on creation (never retrievable again) — advisory banner prompts tenant to save it
- Test ping button: fires a sample payload and shows HTTP status + response snippet inline
- Consecutive failure counter shown per hook — helps diagnose dead endpoints
- `tenant_webhooks` table; migration 021

### Data API Key Management
- Generate key — shown once, never stored in plain text (bcrypt hash stored)
- View key prefix and generation date
- Revoke key immediately

---

## Subscription & Billing

### Plans

| Plan | Price | Customers | Messages/mo | Agents | Managed AI |
|------|-------|-----------|-------------|--------|------------|
| Trial | Free (14 days) | 25 | 500 | 3 | No |
| Starter | $49/mo | 50 | 1,000 | 10 | No |
| Growth | $149/mo | 250 | 5,000 | 25 | Yes |
| Professional | $399/mo | 1,000 | 25,000 | 100 | Yes |
| Master | Free forever | Unlimited | Unlimited | Unlimited | Yes |

### Stripe Integration
- Stripe pricing table embed (self-serve checkout)
- Full webhook handling: `checkout.session.completed`, `invoice.paid/failed`, `subscription.updated/deleted`
- Plan auto-detected from Stripe price ID
- Customer billing portal (manage payment, cancel, upgrade/downgrade)

### API Keys (BYOK vs Managed AI)
- Starter: Bring Your Own Key — tenant enters their Anthropic API key, validated on entry
- Growth/Professional: Managed AI — platform key used, tenant doesn't need an API key
- AES-256-GCM encryption for stored tenant API keys
- Fallback chain: managed flag → tenant BYOK → global platform key → mock mode

---

## Integrations & Distribution

### WordPress Plugin
- Full plugin at `https://shenmay.ai/downloads/shenmay-wordpress-plugin.zip` (legacy `…/downloads/nomii-wordpress-plugin.zip` URL 301-redirects; sunset 2026-10-20)
- Admin settings page: widget key, position, colors, greeting, auto-embed toggle
- Both `[nomii_widget]` and `[shenmay_widget]` shortcodes supported (interchangeable; same handler) with per-page attribute overrides
- Sitewide auto-embed via `wp_footer` hook
- Duplicate injection prevention

### Widget Embed (Any Site)
- One `<script>` tag, no dependencies
- Configurable: key, position (4 corners), primary color, text color, bubble greeting
- Works on static sites, WordPress, Webflow, Squarespace, custom apps

### Data API (Push Integration)
- REST API for CRM/ERP integrations
- Full CRUD on customers and their data records
- Designed for nightly syncs or real-time pushes from existing systems

---

## Infrastructure & Security

### Multi-Tenant Isolation
- Every query scoped to `tenant_id` — data from different tenants is never mixed
- Widget key scoping — each embed key only serves that tenant's customers

### Authentication (4 Layers)
1. **App JWT** — customer / advisor / admin in the React dashboard
2. **Platform JWT** — superadmin routes
3. **Widget JWT** — issued per session, 15-min expiry
4. **Portal JWT** — tenant dashboard, `{ portal: true }` claim

### Rate Limiting
- Widget session creation: 6/5min per IP
- Widget chat: 20/min per IP (primary LLM cost protection)
- Tenant registration: 3/hr per IP
- Tenant login: 5/15min per IP
- Data API: 60/min per key (in-memory, per-key prefix)
- Global safety net: 150/min per IP

### Data & Privacy (Session 17)
- **Audit log**: every sensitive data access written to `audit_logs` table — actor, event, IP, tenant, customer, outcome. Append-only, 7-year retention
- **Right to Erasure (GDPR Art. 17 / CCPA §1798.105)**: `DELETE /api/portal/customers/:id` fully anonymises all PII, wipes memory/soul, deletes structured data, redacts message content — leaves conversation metadata intact
- **Right to Access / Data Portability (GDPR Art. 20 / CCPA §1798.100)**: `GET /api/portal/customers/:id/export` returns full JSON data package including personal data, AI memory, structured data, conversations, flags, and access log
- **Consent capture**: widget session creation stores `consent_given_at`, `consent_ip`, `consent_version` when new authenticated customer created
- **Data retention**: 24h cron job purges message bodies older than `message_retention_days` (default 2yr), deletes anonymous sessions after `anon_session_ttl_days` (default 30d), processes pending erasure queue
- **Security headers**: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`, `X-XSS-Protection` applied to all non-widget routes
- **CORS hardening**: portal routes restricted to known frontend origins; preflight returns 403 for unknown origins in production
- **AES-256-GCM encryption**: API keys encrypted at rest; `cryptoService.js` provides `encryptJson`/`decryptJson` for future column-level encryption rollout
- **Login audit**: auth success and all failure modes written to audit log
- **Per-tenant compliance config**: `gdpr_contact_email`, `data_processing_basis`, `message_retention_days`, `anon_session_ttl_days` on tenant row

---

## Planned / In Progress

| Feature | Status | Notes |
|---------|--------|-------|
| Memory view in advisor dashboard | ✅ Done | PersonalProfile, Goals, ConversationHistory all shown; Sync button per conversation |
| Widget proactive greeting | ✅ Done | AI-generated welcome-back message; action item → summary → topic slug priority; emotional tone modulation |
| Document delivery tool | ✅ Done | `send_document` tool + `sendDocumentEmail`; logs delivery to dashboard |
| GDPR / CCPA compliance infrastructure | ✅ Done | Audit log, erasure, export, consent, retention, security headers — Session 17 |
| Portal UI for GDPR actions | ✅ Done | Export + Erase (GDPR Art. 17) buttons in customer detail view — Session 18 |
| Column-level encryption (memory/soul) | ✅ Done | `memory_file` + `soul_file` encrypted with AES-256-GCM; all read/write paths updated — Session 18 |
| Webhook management | ✅ Done | HMAC-SHA256 signed webhooks; CRUD + test ping UI in Settings; migration 021 — Session 19 |
| Concern resolution | ✅ Done | Resolve button on concerns list; `PATCH /concerns/:id/resolve`; optimistic UI removal — Session 19 |
| Conversation triage indicators | ✅ Done | Unread dot, bold name, yellow border; HUMAN + ESCALATED badges — Session 19 |
| Human mode reply notifications | ✅ Done | Fire-and-forget email to assigned advisor when customer replies in human mode — Session 19 |
| Per-exchange memory update in widget | ✅ Done | `updateMemoryAfterExchange` called on every widget exchange — Session 19 |
| Open follow-ups in system prompt | ✅ Done | `OPEN FOLLOW-UPS` block at top of history; action items surfaced prominently — Session 19 |
| Conversation search + filter | ✅ Done | Debounced search bar, status/mode pills, unread toggle — Session 20 |
| Anonymous visitor widget | ✅ Done | Anon sessions with ephemeral records; no profile built unless customer exists — Session 20 |
| Seamless auth handoff (session claim) | ✅ Done | `shenmay:identify` → `POST /session/claim` migrates conversation to real user, no reload — Session 20 |
| In-app notification bell | ✅ Done | Bell + dropdown in dashboard; 15s poll; flags + human_reply types; migration 022 — Session 20 |
| Tool test sandbox (all types) | ✅ Done | Test modal on all active tools; sandbox + real customer modes; escalate always simulated — Session 20 |
| Privacy Policy + ToS + DPA docs | Planned | Legal documents — requires attorney review before EU tenant onboarding |
| Live Connector skeleton | Planned | Tier 3 data model — Shenmay calls tenant's own API at query time, data never stored |
| Production infrastructure migration | Planned | Move from Proxmox to Hetzner CX22 (~$6/mo) |
| Per-agent read tracking | Backlog | Currently `unread` is per-conversation global |
| SOC 2 Type II | Backlog | Required for enterprise financial firms. 6–12 month process |
| BAA | Backlog | Required alongside SOC 2 for financial/healthcare |
| External CRM connectors | Backlog | Orion, Envestnet, Redtail, Wealthbox — enterprise tier |
| On-premise deployment | Backlog | Architecture already supports it; needs packaging |
