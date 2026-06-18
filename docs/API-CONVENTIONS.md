# Shenmay AI — API Conventions

> Living doc. Touch this whenever a new public API path is added or a
> convention is re-decided. Addresses **Findings #17 and #18** from
> [`AUDIT-2026-04-17.md`](AUDIT-2026-04-17.md).

---

## Field-naming — snake_case for all NEW public APIs

**Use snake_case for request and response field names.** Matches the
Postgres column names (so there's no serialization layer to argue about)
and matches the majority of current public endpoints.

```json
// Good
{ "first_name": "Austin", "company_name": "Acme", "tos_accepted": true }

// Bad — don't add new camelCase fields to the public API
{ "firstName": "Austin", "companyName": "Acme", "tosAccepted": true }
```

### Historical inconsistency (known tech debt)

`/api/setup/complete` (first-install wizard for self-hosted) and
`/api/onboard/register` (SaaS signup) both write to the same `tenant_admins`
table but use different conventions:

| Endpoint | Convention | Example fields |
|---|---|---|
| `POST /api/setup/complete` | **camelCase** | `companyName`, `firstName`, `anthropicApiKey` |
| `POST /api/onboard/register` | **snake_case** | `company_name`, `first_name`, `tos_accepted` |

Both are internally consistent, both work, and both are covered by the
Playwright suite. But anyone hand-writing an integration against one will
stumble on the other.

**Resolution:** do not write new camelCase endpoints. When `/api/setup/*`
is next touched for product reasons, migrate it to snake_case in the same
PR (breaking change, but the only caller is the self-hosted setup wizard
which ships in the same repo — coordinated change).

**Why not fix it now?** `/api/setup/complete` is only called by the
self-hosted first-install flow, which works. Changing it would churn the
install scripts, tests, and on-prem docs for zero customer benefit. Fix
on next touch.

---

## Three `/login` endpoints — three distinct user populations

Shenmay has three logical user populations, stored in three different
tables. Each has its own login endpoint with its own JWT shape. This is
intentional, not a refactor target — but it confused a third-party
auditor who naturally reached for `/api/auth/login` first. Documented
here so the next human (or LLM) doesn't have to read source to figure it
out.

| Endpoint | Users | Table | Who logs in here |
|---|---|---|---|
| `POST /api/auth/login` | **Widget end-users** | `customers`, `advisors` | The people Austin's *customer's customers* are — the end-users who chat with a widget deployed on a customer site. Also the advisor dashboard (human takeover). |
| `POST /api/onboard/login` | **Tenant admins** | `tenant_admins` | Austin's direct SaaS customers. The person who signed up at pontensolutions.com to run a chatbot on their site. Logs into the Shenmay dashboard at `/nomii/portal`. |
| `POST /api/platform/auth/login` | **Platform admins** | `platform_admins` | Austin + future Shenmay operators. Logs into the super-admin panel that manages tenants, licenses, billing across the SaaS. Only mounted when `SHENMAY_LICENSE_MASTER=true`. |

### JWT payloads differ per endpoint

Each login issues a JWT with a different shape. Middleware picks them apart:

| Endpoint | JWT payload shape | Middleware | Protects |
|---|---|---|---|
| `/api/auth/login` | `{ tenant_id, user_id, role, email, ... }` | `requireAuth` | `/api/*` tenant-scoped routes |
| `/api/onboard/login` | `{ portal: true, tenant_id, admin_id, email }` | portal JWT check | `/api/portal/*` (tenant admin dashboard) |
| `/api/platform/auth/login` | `{ platform_admin_id, user_type: 'platform_admin', email }` | `requirePlatformAuth` | `/api/platform/*` (super-admin) |

**Do not try to collapse these.** Three user populations, three tables,
three authz models — merging them is a non-trivial refactor that produces
a worse surface (a single endpoint that returns wildly different user
objects depending on what it finds). Keep separate, keep documented.

### Common confusion

- "My `/api/auth/login` attempt with the tenant admin creds returns
  `Invalid email or password`." — Correct behavior. Tenant admins live
  in `tenant_admins`, not `customers`/`advisors`. Use `/api/onboard/login`.
- "My setup-wizard-created admin can't log in via `/api/onboard/login`
  until they verify their email." — Also correct. `/api/setup/complete`
  marks the admin as email-verified at creation time; normal signups
  require the email-verification link. Check the `email_verified` flag
  on the `tenant_admins` row.

---

## Error response shape

All error responses should be a JSON object with a consistent shape:

```json
{ "error": "short_machine_code", "message": "Human-readable detail (optional)" }
```

- `error` — a stable, short string usable for switch-on-value logic
  (`tos_not_accepted`, `email_not_verified`, `rate_limit_exceeded`).
- `message` — human-readable, may change; do not key logic off this.

HTTP status follows REST conventions: `400` for validation, `401` for
missing/bad auth, `403` for authenticated-but-not-allowed, `429` for
rate-limit, `5xx` for bugs.

Legacy endpoints may return just `{ error: "<human sentence>" }` — ok to
leave alone, but new endpoints should use the structured shape.

---

## Rate limiting — per-endpoint, documented in `docs/testing.md`

See `docs/testing.md` for the current limiter table. When adding a
limiter, add an `*_RATE_LIMIT_MAX` env override (see `REGISTER_RATE_LIMIT_MAX`
for the pattern) — makes E2E tests and staging usable without hitting
prod-facing limits.

---

## Versioning — not yet

No API version prefix (`/api/v1/*`) today. Customers integrate via the
widget embed (not direct API calls), so breaking changes are absorbed by
shipping the matching widget. When we first ship an integration that a
third party writes code against, add `/api/v1/*` prefixes then.

Until then: breaking API changes are fine, they only affect the widget
and the dashboard (both in this repo).
