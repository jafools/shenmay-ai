# Shenmay AI — Uptime Monitoring

> Addresses **Finding #14** from [`AUDIT-2026-04-17.md`](AUDIT-2026-04-17.md):
> No external uptime monitoring on the SaaS. Until this is in place, Austin
> learns about outages when a customer tells him.

---

## TL;DR — recommended setup (free UptimeRobot)

Three HTTP(S) monitors against prod, 5-minute interval. Free tier allows 50
monitors so there's room to grow; these three cover the blast-radius of any
customer-visible outage.

1. Sign up at https://uptimerobot.com (free tier: 50 monitors, 5-min interval).
2. Add **Alert contact**: Austin's email. Set SMS for paging later if needed.
3. Add the three monitors below.

### Monitor 1 — backend deep health (DB-aware)

| Field | Value |
|---|---|
| Monitor Type | `HTTP(s) — Keyword` |
| Friendly Name | `Shenmay prod — /api/health` |
| URL | `https://shenmay.ai/api/health` |
| Keyword Type | `exists` |
| Keyword | `shenmay-ai` |
| Monitoring Interval | `5 minutes` |
| HTTP Method | `GET` |
| Alert When Down After | `2 consecutive failures` (≈ 10 min) |
| Alert Contact | Austin (email) |

Why keyword `shenmay-ai`: unique to Shenmay's healthy response, distinguishes a
real `{"status":"ok","service":"shenmay-ai"}` from a Cloudflare error page that
happens to return 200, or a stale cached response from a different app.

Why this endpoint matters: since PR #96, `/api/health` runs `SELECT 1` against
Postgres. A DB-down outage now returns HTTP 503 with `"status":"degraded"`,
failing both the status-code check and the keyword check. Previously the
endpoint was a hardcoded 200 and could not see a disconnected DB — the
monitor only caught hard crashes of the backend process or nginx.

#### Health counters on `/api/health` (alert on a healthy-DB failure mode)

The healthy response also carries two cumulative-since-boot counters so a
500-spike or dropped-compliance-write is visible even when the DB is fine and
every uptime monitor is green:

```json
{ "status": "ok", "service": "shenmay-ai",
  "audit_write_failures": 0,   // dropped audit-log writes (P3-4)
  "http_5xx_total": 0 }        // 5xx responses since boot (T10/M12)
```

`http_5xx_total` is counted at **response finish**, so it includes the
route-level `res.status(500)` paths that bypass the central error handler. It
resets to 0 on restart (it's an in-process counter, not a persisted metric).

To alert on it with the free UptimeRobot tier, add a second keyword monitor on
the same URL with **Keyword Type `not exists`, Keyword `"http_5xx_total":0`** —
it fires the moment the counter leaves zero (i.e. the first 5xx after a boot).
Early on that's a useful "something just threw" tripwire; once volume grows,
move to a scrape that computes a rate (see *Future* below). The same trick works
for `"audit_write_failures":0`.

### Monitor 2 — apex marketing-to-app redirect

| Field | Value |
|---|---|
| Monitor Type | `HTTP(s)` |
| Friendly Name | `Shenmay prod — apex` |
| URL | `https://shenmay.ai/` |
| Monitoring Interval | `5 minutes` |
| Alert When Down After | `2 consecutive failures` |
| Alert Contact | Austin (email) |

Catches: Cloudflare tunnel down, nginx down, SSL expiry, frontend container
not serving, apex redirect broken.

### Monitor 3 — embed.js (customer-visible widget distribution)

| Field | Value |
|---|---|
| Monitor Type | `HTTP(s) — Keyword` |
| Friendly Name | `Shenmay prod — embed.js` |
| URL | `https://shenmay.ai/embed.js` |
| Keyword Type | `exists` |
| Keyword | `widget-key` |
| Monitoring Interval | `5 minutes` |
| Alert When Down After | `2 consecutive failures` |
| Alert Contact | Austin (email) |

Why: `embed.js` is loaded on every customer's website. If it 404s or returns
garbage, widget rendering breaks everywhere at once. The `widget-key` keyword
is what the embed script uses to read `data-widget-key="..."` from the host
page — its presence confirms the script is the real file, not a Cloudflare
error.

---

## Alert policy — what Austin wants to see

- **Hard down** (HTTP 5xx / timeout / keyword missing, ≥ 2 checks in a row):
  email alert.
- **Soft degradation** (single failed check, then recovered): no alert —
  noisy and not actionable.
- **Recovery:** email when the monitor comes back up.

Cloudflare's "Always Online" is not a substitute — it caches static pages and
doesn't probe the backend.

---

## Optional: staging monitor

`https://nomii-staging.pontensolutions.com/api/health` is publicly reachable
and auto-refreshes to `:edge` every 5 min. A monitor on it helps catch merges
that break the happy path before a customer-hitting tag, but it's noisy
during active dev. If you add it, set the interval to 30 min and route
alerts to a separate "staging" contact so they don't page with prod alerts.

Skip entirely until customer volume means a staging break is costing signal
real teams would notice.

---

## Resend bounce / complaint webhook

Live as of v3.3.3. `POST /api/webhooks/resend` receives Resend events,
verifies the Svix signature, and writes hard-bounced / complained addresses
into the `email_suppressions` table. The transporter wrapper in
`server/src/services/emailService.js` consults that table before every send
so we don't keep hammering a dead address and torch Resend's rate-limit
bucket on our whole account.

### Resend dashboard setup (one-time, Austin)

1. Open <https://resend.com/webhooks> → **Add Endpoint**.
2. **Endpoint URL:** `https://shenmay.ai/api/webhooks/resend`
3. **Events to send:** check `email.bounced` and `email.complained`
   (leave the rest off until we decide we want analytics rows).
4. Save. Copy the generated signing secret (starts with `whsec_`).
5. SSH to Hetzner and drop the secret into `.env`:
   ```bash
   ssh nomii@204.168.232.24 'cd ~/shenmay-ai && printf "\nRESEND_WEBHOOK_SECRET=whsec_...\n" >> .env && docker compose up -d backend'
   ```
6. Back in Resend, click **Send test event** → the "Events" tab should
   show `200 OK` within a second. Confirm nothing landed in
   `email_suppressions` (test events don't count as real bounces).

While `RESEND_WEBHOOK_SECRET` is unset the handler runs in dev-mode
bypass: requests are accepted without signature verification. Fine for
staging; make sure prod has it set before pointing a real Resend webhook
at it.

### What gets suppressed, what doesn't

- `email.bounced` with `bounce.type === 'hard'` (or `'Permanent'`) →
  inserted with `reason = 'bounce'`.
- `email.complained` → inserted with `reason = 'complaint'`. One spam
  complaint is enough to stop sending; recovery is manual via
  `DELETE FROM email_suppressions WHERE email = '...'`.
- Soft bounces (`bounce.type === 'soft'`) are acknowledged but **not**
  suppressed — they often recover and blanket-blocking them would mask
  transient outages.
- `email.delivered` / `sent` / `opened` / `clicked` are acked as 200 so
  Resend doesn't retry, but not stored. Wire them up later if we want
  engagement metrics.

### Future: UptimeRobot heartbeat

Free-tier UptimeRobot doesn't have heartbeat monitoring (alert on
*silence*). When we outgrow the free tier, or stand up Uptime Kuma, add
an inverse monitor so a prolonged gap in Resend event traffic — which
would suggest webhook delivery is broken — pages instead of silently
rotting. Not urgent; Resend dashboard already surfaces delivery failures.

---

## Fallback: self-hosted ping from pontenprox

If UptimeRobot ever has a problem (billing, account, etc.), `pontenprox` can
act as a stopgap monitor since it's always running (it hosts staging +
Lateris). The systemd timer below does a `curl` against the Hetzner health
endpoint every 5 minutes and logs failures; pair it with `mail` or a simple
webhook if you want alerts.

**Not set up yet** — only set up if UptimeRobot is down or unavailable.

Template:

```bash
# /root/shenmay-uptime/check-hetzner.sh
#!/usr/bin/env bash
set -euo pipefail
URL="https://shenmay.ai/api/health"
LOG=/var/log/shenmay-uptime.log
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! curl -fsS --max-time 10 "$URL" | grep -q '"status":"ok"'; then
  echo "$TS DOWN" >> "$LOG"
  exit 1
fi
echo "$TS OK" >> "$LOG"
```

```ini
# /etc/systemd/system/shenmay-uptime.service
[Unit]
Description=Shenmay Hetzner health check
[Service]
Type=oneshot
ExecStart=/root/shenmay-uptime/check-hetzner.sh
```

```ini
# /etc/systemd/system/shenmay-uptime.timer
[Unit]
Description=Run shenmay-uptime every 5 minutes
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now shenmay-uptime.timer`.

---

## Future: richer observability

Out of scope for solo-dev launch. Worth considering once customer count > ~10:

- **Synthetic customer flow:** reuse the existing `e2e-saas` Playwright suite
  on a scheduled run against prod (GitHub Actions cron) — catches product
  regressions, not just infra. The nightly `e2e-repeatability.yml` cron is
  the staging-facing version; a 2-hourly prod-facing subset would be next.
- **Prometheus + Grafana:** the self-hosted option. Overkill for one Hetzner
  CPX22 but standard once there are multiple tenants with different SLAs. The
  `http_5xx_total` counter on `/api/health` is the natural first scrape target
  for a proper error-*rate* alert (vs. the leave-zero tripwire above).
- **Backend error tracking (done, T10):** request-correlation IDs (`X-Request-Id`
  on every response; structured pino logs carry the id), a response-finish
  `http_5xx_total` counter on `/api/health`, and DSN-gated Sentry in the error +
  process-crash handlers. Sentry is **off unless `SENTRY_DSN` is set** — SaaS
  sets its own DSN; self-hosted installs send nothing by default. To diagnose a
  specific failure, grep the backend logs for the request id from the customer's
  `X-Request-Id` response header.

None of these are needed today. The three UptimeRobot monitors above close
the "customer tells me first" gap.
