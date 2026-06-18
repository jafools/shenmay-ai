# Shenmay AI — Personalized AI Agent Platform

> *Känn mej* ("know me" in Swedish, pronounced *Shen-may*) — B2B platform for deploying persistent, personalized AI agents that deeply understand each customer.

**Status:** v3.6.2 in production at [shenmay.ai](https://shenmay.ai). Three deployment modes: multi-tenant SaaS, single-tenant self-hosted, and license master.

## What is it?

Tenants (companies) deploy per-customer AI agents backed by two persistent files:

- **Soul** — *who the agent is* for this customer (tone, style, identity)
- **Memory** — *what the agent knows* (profile, conversation history, structured data, goals)

The first vertical is retirement planning; the data model is industry-agnostic.

## Architecture

| Layer | Stack |
|---|---|
| Backend | Node.js 20 + Express + PostgreSQL 16 |
| Frontend | React 18 + Vite + Tailwind, served via nginx |
| Widget | Embeddable chat (`server/public/widget.html` + `embed.js`), JWT-isolated |
| Modes | SaaS multi-tenant, `SHENMAY_DEPLOYMENT=selfhosted`, `SHENMAY_LICENSE_MASTER=true` |
| Packaging | Docker Compose + GHCR images, immutable semver tags per release |
| Email | Resend SMTP (SPF + DKIM + DMARC pass) |

## Quick Start — Self-Hosted (Docker)

```bash
cp .env.example .env                   # fill SMTP, Stripe, Anthropic keys, secrets
docker compose -f docker-compose.selfhosted.yml up -d
curl http://localhost:3001/api/health  # → {"status":"ok","service":"shenmay-ai"}
```

First visit to `http://localhost` launches the setup wizard (admin + company).

## Quick Start — Local Development

Requires Node.js 20+, PostgreSQL 16+.

```bash
createdb shenmay_ai
npm run install:all
cd server && npm run db:migrate && cd ..
npm run dev           # server :3001, client :5173 (with /api proxy)
```

## Build · Test · Lint

```bash
npm run build         # client production bundle
npm run test:unit     # Node unit suites in /tests (no DB required)
npm test              # the unit suites + tests/integration.test.js (needs Postgres)
npm run lint          # ESLint across server + client
npm run test:e2e      # Playwright E2E suite (specs in tests/e2e)
```

`npm run test:unit` runs the standalone Node test files in [`tests/`](tests/) (tokenizer/prompt-builder, engine, brand-learning, OpenAI adapter, webhook SSRF, owner-gate, license, observability, chat service). `npm test` adds [`tests/integration.test.js`](tests/integration.test.js), which needs a live Postgres.

The Playwright E2E suite ([`tests/e2e/`](tests/e2e)) runs in CI on every PR ([`ci.yml`](.github/workflows/ci.yml)) against a fresh Postgres **and** against a live `docker-compose.selfhosted.yml` stack, covering both SaaS and on-prem customer journeys. A 5×5 repeatability matrix ([`e2e-repeatability.yml`](.github/workflows/e2e-repeatability.yml)) gates every release tag — 10 parallel cells must all pass before cutting `vX.Y.Z`.

## Project Layout

```
shenmay-ai/
├── server/                        Node.js + Express backend
│   └── src/
│       ├── engine/                Soul + Memory + prompt-building core
│       ├── routes/                HTTP handlers (portal, widget, onboard, setup, stripe-webhook, …)
│       ├── services/              LLM, email, license, Stripe, encryption
│       ├── middleware/            Auth, subscription, rate limiting, PII scanning
│       └── jobs/                  Scheduled jobs (data retention, self-hosted seed)
├── client/                        React + Vite frontend
│   └── src/
│       ├── pages/shenmay/         Auth pages (login, signup, verify-email, onboarding, …)
│       └── pages/shenmay/dashboard/   Tenant dashboard (settings, conversations, analytics, …)
├── tests/
│   ├── e2e/                       Playwright specs (SaaS + on-prem customer journeys)
│   ├── *.test.js                  Node unit suites (tokenizer, engine, brand-learning, chatService, …)
│   └── integration.test.js        Server integration tests (needs Postgres)
├── docs/
│   ├── RELEASING.md               Full release + deploy procedure
│   ├── SESSION_NOTES.md           Live dev-session handoff
│   ├── MONITORING.md              Ops, logs, health, error-budget
│   ├── PRIVACY.md                 GDPR policy (retention, erasure, anonymisation)
│   └── API-CONVENTIONS.md         Internal HTTP conventions
├── .github/workflows/             CI, image publish, E2E, repeatability matrix
├── docker-compose.yml             SaaS stack (db + backend + frontend)
└── docker-compose.selfhosted.yml  Self-hosted single-tenant stack
```

## Release Flow

1. Feature branch (`feat/*`, `fix/*`, `chore/*`, `docs/*`) → PR → CI green → **squash-merge** to branch-protected `main`.
2. Merge to `main` builds `ghcr.io/jafools/shenmay-{backend,frontend}:edge` and staging auto-refreshes every 5 minutes at [`nomii-staging.pontensolutions.com`](https://nomii-staging.pontensolutions.com).
3. Release tag `vX.Y.Z` builds `:stable`, `:latest`, `:X.Y.Z`, `:X.Y`; on-prem customers pin to the immutable version tag.
4. SaaS deployment to Hetzner Helsinki is an explicit SSH + `docker compose pull` step against the tagged image — never a direct push to main.

Full procedure: [`docs/RELEASING.md`](docs/RELEASING.md).

## Security Posture

- Branch-protected `main` — all changes go through PR + CI.
- Key-only SSH to production, `root` disabled, UFW firewall to ports 22/80/443.
- Cloudflare Origin CA (valid to 2041) + Full-Strict TLS.
- Secrets managed via `.env` (never committed); `API_KEY_ENCRYPTION_SECRET` encrypts tenant-scoped Anthropic keys at rest.
- Inbound PII scanning on widget messages (blocks credit cards, SSNs, passport numbers before they reach the LLM).
- Outbound email: SPF + DKIM + DMARC all passing for `pontensolutions.com`.

## Further Reading

- [`CLAUDE.md`](CLAUDE.md) — Operating instructions for AI agents working in this repo (branching rules, deployment, gotchas).
- [`docs/SESSION_NOTES.md`](docs/SESSION_NOTES.md) — Live handoff between dev sessions (current prod tag, open queue, deploy state).
- [`docs/RELEASING.md`](docs/RELEASING.md) — Release + Hetzner deploy procedure.
- [`docs/MONITORING.md`](docs/MONITORING.md) — Production observability.
- [`docs/PRIVACY.md`](docs/PRIVACY.md) — GDPR / data-retention policy.
