> **HISTORICAL — frozen, no longer maintained.** Point-in-time artifact kept for reference only.
> For current state see [`docs/SESSION_NOTES.md`](../SESSION_NOTES.md). Archived 2026-06-18 (audit M3/T15).

---

# Shenmay AI — Phase 3 Plan
## Self-Serve Tenant Portal (nomii.pontensolutions.com)

*Written: 2026-03-11*
*Updated: 2026-03-30 — Portal location is nomii.pontensolutions.com (integrated with authenticated dashboard)*

---

## What Phase 3 Is

A complete self-serve tenant onboarding and management portal integrated into **nomii.pontensolutions.com**. A business owner (non-technical) can sign up, configure their Shenmay agent, install the widget on their website, upload their customer and product data, and then monitor everything from a professional dashboard — without needing a developer or a single manual step on the Shenmay backend.

The portal clearly distinguishes between two user experiences:
- **Unauthenticated visitors** (on customer websites): branded AI chatbot without authentication — no soul persistence, no memory, provides value through real-time conversation
- **Authenticated users** (on customer websites): persistent soul + memory — personalized agent that remembers context, provides ongoing relationship value

The proof of success for Phase 3: **Re-onboard Hope for This Nation entirely through nomii.pontensolutions.com**, replacing all manual seeding and chat-based configuration.

---

## Architecture Decision

`pontensolutions.com` is built in Lovable (React/Supabase frontend). Rather than fight that, we use it as the UI layer and route all business logic through the existing Shenmay API at `api.pontensolutions.com`. Lovable handles pages and UI; our Express backend handles all data.

```
pontensolutions.com  (Lovable — React UI)
       │
       │  REST calls
       ▼
api.pontensolutions.com  (Shenmay Express backend)
       │
       ├── /api/onboard/*    NEW — self-serve tenant registration + setup
       ├── /api/portal/*     NEW — tenant dashboard data
       ├── /api/platform/*   existing — superadmin
       └── /api/widget/*     existing — widget runtime
       │
       ▼
PostgreSQL  (existing DB + new tables/columns)
```

**Why not use Supabase for the portal backend?**
All agent data (soul, memory, conversations, customers) lives in our PostgreSQL. Splitting auth and business logic across two backends creates sync problems. Lovable calls our API directly via fetch, the same way the widget does.

---

## The Five Parts of Phase 3

---

### Part 1 — Self-Serve Registration & Tenant Creation

**What the user sees:**
- Landing page at `pontensolutions.com` with a "Get Started" CTA
- Sign-up form: name, email, password, company name, industry/vertical (dropdown)
- On submit: tenant record is created, widget key is generated, they land in the onboarding wizard

**What we build on the backend:**
```
POST /api/onboard/register
  Body: { name, email, password, company_name, vertical, primary_color?, agent_name? }
  Creates: tenant record, hashes password, generates widget_api_key, issues portal JWT
  Returns: { token, tenant_id, widget_key }

POST /api/onboard/login
  Body: { email, password }
  Returns: { token, tenant_id }

GET /api/portal/me
  Auth: portal JWT
  Returns: tenant profile + setup status (which wizard steps are complete)
```

**DB changes:**
- Add `portal_password_hash VARCHAR` to tenants (or create a separate `tenant_admins` table — preferred for multi-user later)
- Add `onboarding_completed_steps JSONB` to tenants — tracks which wizard steps are done
- Add `widget_verified_at TIMESTAMP` to tenants — set when widget phones home

---

### Part 2 — Onboarding Wizard (5 Steps, Status Indicators)

Each step has a status indicator: ⬜ Not started → 🔄 In progress → ✅ Complete

The wizard is non-linear — they can jump to any step. Each step saves independently.

---

#### Step 1: Company Profile
Fields: Company name, industry/vertical, logo upload, brand colors (primary/secondary), agent name, short "who we are" description.

This data feeds directly into the agent's system prompt so it knows who it represents.

**API:**
```
PUT /api/portal/company
  Body: { company_name, vertical, agent_name, primary_color, secondary_color,
          logo_url, company_description }
```

**Status check:** Complete when company_name and agent_name are set.

---

#### Step 2: Products & Services
Upload or manually enter what the company offers. This is the "what do we sell/do" context the agent needs.

**Two input modes:**
- **Manual entry**: Add products/services one at a time (name, description, key details)
- **CSV upload**: Columns — `name`, `description`, `category`, `price` (optional), `notes` (optional)

This data is stored in a new `tenant_products` table and injected into the agent's system prompt.

**API:**
```
POST /api/portal/products          — add single product
PUT  /api/portal/products/:id      — edit product
DELETE /api/portal/products/:id    — remove product
POST /api/portal/products/upload   — CSV bulk import
GET  /api/portal/products          — list all
```

**DB:**
```sql
CREATE TABLE tenant_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price_info VARCHAR(255),
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Status check:** Complete when at least one product/service is added.

---

#### Step 3: Customer Data Upload
Upload the tenant's existing customer roster so agents can recognize users on login and have context about them.

**How it works:**
1. Tenant downloads a CSV template
2. Fills in their customer data (required: email; optional: name, any custom fields)
3. Uploads the CSV
4. Our API maps columns → `customers` table, stores extra columns as JSONB in `customer_data`
5. Status flips to ✅

**CSV template columns:**
```
email (required), first_name, last_name, phone, account_id (their internal ID),
[any custom columns → stored as customer_data JSONB]
```

**How the agent uses this:** When a customer logs into the tenant's website and the widget loads with their email, we look up their record. If they exist, the agent already knows their name and any uploaded data. If they're new, they're auto-created (existing behavior).

**API:**
```
GET  /api/portal/customers/template    — download CSV template
POST /api/portal/customers/upload      — bulk CSV import
GET  /api/portal/customers             — list (paginated)
PUT  /api/portal/customers/:id         — edit individual customer
```

**Status check:** Complete when at least one customer record exists for this tenant.

---

#### Step 4: Widget Installation

This is the most technically varied step. The goal is to guide the tenant through adding the `<script>` tag to their website, then automatically detect when it's live.

**Platform selector (shown first):**
The tenant picks their platform. The UI then shows a tailored guide.

**Platform guides (in order of prevalence):**

**WordPress (~43% of websites)**
Best option: Offer a downloadable Shenmay WordPress Plugin (.zip).
- Tenant downloads the plugin from pontensolutions.com
- Installs it in WordPress Admin → Plugins → Add New → Upload
- Activates it, enters their Widget Key in the plugin settings
- Plugin injects the `<script>` tag on all pages automatically
We build this as a simple PHP plugin (50 lines). This is the highest-value widget install method.

**Webflow**
Settings → Custom Code → Footer Code → paste snippet → Publish

**Squarespace**
Settings → Advanced → Code Injection → Footer → paste snippet

**Wix**
Settings → Custom Code → Add Code → choose "All pages" → paste snippet

**Shopify**
Online Store → Themes → Edit Code → theme.liquid → paste before `</body>`

**Custom React / Next.js (like HFTN/Lovable)**
Add the script injection to the authenticated layout wrapper — provide the exact code block.

**Other / Unknown**
Paste this snippet before `</body>` on every page where you want the widget:
```html
<script
  src="https://api.pontensolutions.com/embed.js"
  data-widget-key="YOUR_KEY"
  data-user-email="LOGGED_IN_USER_EMAIL"
  data-user-name="LOGGED_IN_USER_NAME"
  async>
</script>
```

**The green connector — how widget verification works:**
When `embed.js` loads successfully on any page, it makes a silent one-time POST to:
```
POST /api/widget/verify
  Body: { widget_key }
  Action: sets widget_verified_at = NOW() on the tenant record (if not already set)
```
The portal wizard polls `GET /api/portal/me` every 5 seconds while this step is open. When `widget_verified_at` is set, the step flips to ✅ automatically — no button click needed. The tenant sees it turn green in real time as soon as they test their website.

**Status check:** `widget_verified_at IS NOT NULL`

---

#### Step 5: Test & Go Live
- Simple chat window in the wizard UI, pre-loaded with the tenant's widget key
- They send a test message to their agent
- Agent responds using real Claude + their company profile + their product data
- If it responds correctly, the step is ✅ and the wizard is complete

This is just the widget.html UI embedded directly in the wizard page.

**Status check:** At least one successful message exchange through the widget API.

---

### Part 3 — Main Dashboard

After the wizard is complete, tenants land on a professional dashboard. Think Intercom or Crisp — clean, data-rich, tells you what your AI agent has been doing.

**Pages:**

#### Overview (Home)
- Total conversations (all time + this month)
- Active customers (had a conversation in last 30 days)
- Average conversations per customer
- Recent activity feed (last 10 conversations, newest first)
- Widget status indicator (live / not detected)

#### Conversations
- List of all conversations, sortable by date / customer / status
- Click a conversation → see the full message thread
- Status badges: active / ended / escalated

#### Customers
- List of all customers with last interaction date
- Click a customer → see their profile: soul file (readable summary, not raw JSON), memory file (same), their conversation history, their uploaded data

#### Concerns & Flags
- All conversations that have been escalated (status = 'escalated') or flagged
- Shows why it was flagged, which customer, when
- Ability to mark as reviewed

#### Settings
- Company profile editor (same as wizard Step 1)
- Products/services manager (same as wizard Step 2)
- Widget key display + copy button
- Regenerate widget key (with confirmation warning)

---

### Part 4 — Backend Changes Summary

New route files to build:
```
server/src/routes/onboard.js    — registration, login, wizard steps
server/src/routes/portal.js     — dashboard data, customer list, conversations
```

New DB migration (`005_portal.sql`):
```sql
-- Tenant admin accounts (separate from customer/advisor/admin roles)
CREATE TABLE tenant_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'owner',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Products/services for agent context
CREATE TABLE tenant_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  category VARCHAR(100),
  price_info VARCHAR(255),
  notes TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Track onboarding progress
ALTER TABLE tenants ADD COLUMN onboarding_steps JSONB DEFAULT '{}';
-- e.g. {"company": true, "products": true, "customers": false, "widget": false, "test": false}

ALTER TABLE tenants ADD COLUMN widget_verified_at TIMESTAMPTZ;

ALTER TABLE tenants ADD COLUMN company_description TEXT;
ALTER TABLE tenants ADD COLUMN logo_url VARCHAR(500);
```

Also update `promptBuilder.js` to inject `tenant_products` into the system prompt.

---

### Part 5 — Lovable Build Guide (pontensolutions.com)

Since pontensolutions.com is Lovable, we'll write a detailed Lovable prompt for each page/component. These will be added as a `LOVABLE_PROMPTS.md` file when we're ready to build.

**Pages to build in Lovable:**
1. Landing page (marketing — "Add AI to your website in minutes")
2. Sign up / Log in
3. Onboarding wizard (5 steps, sidebar progress, status indicators)
4. Dashboard — Overview
5. Dashboard — Conversations
6. Dashboard — Customers + Customer detail
7. Dashboard — Concerns
8. Dashboard — Settings

All pages call `api.pontensolutions.com` directly. Auth via a portal JWT stored in Lovable's state (similar to how HFTN stores Supabase tokens).

---

## Build Order

Phase 3 is built in this sequence — each step is shippable:

1. **DB migration** (`005_portal.sql`) — foundation for everything else
2. **`/api/onboard` routes** — registration + login (unblocks Lovable work)
3. **`/api/portal/company` + `/api/portal/products`** — Steps 1 & 2 of wizard
4. **`/api/portal/customers/upload`** — CSV ingestion (Step 3)
5. **Widget verification** (`/api/widget/verify` + polling) — Step 4
6. **WordPress plugin** — highest-value widget install method
7. **`/api/portal` dashboard routes** — conversations, customers, stats, flags
8. **Update `promptBuilder.js`** to include products in system prompt
9. **Lovable build** — all portal pages calling the new API
10. **HFTN re-onboarding** — validation run through the full wizard

---

## What This Enables

When Phase 3 is done, Shenmay AI is a real self-serve SaaS product. Any business can go to `pontensolutions.com`, sign up, add their data, paste one script tag (or install a WordPress plugin), and have a personalized AI agent running on their website within 30 minutes — with a dashboard to monitor it. No manual backend work, no chat sessions with Claude to seed data.
