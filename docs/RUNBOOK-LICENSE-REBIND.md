# Runbook — Self-Hosted License Instance Rebind

> **Audience:** Shenmay platform operators (support / on-call).
> **Scope:** the self-hosted license binding between an on-prem customer's
> instance and the cloud license master. Addresses audit finding **M4 / task
> **T9** (`docs/AUDIT-2026-06-10.md`).

## How binding works

Each self-hosted install computes a stable **instance id** and sends it to the
license master (`POST /api/license/validate`) on startup and every 24h. The
master **binds** a license key to the first instance id it sees and **rejects any
other id** for that key:

```
License key is already bound to a different instance. Contact support to transfer.
```

This is intentional anti-sharing: one paid key, one running instance. Transfers
are **admin-only** (not self-serve).

### Where the instance id comes from (post-T9)

`server/src/services/licenseService.js → getInstanceId()`, in precedence order:

1. **`SHENMAY_INSTANCE_ID`** — an operator-set env pin. Absolute; overrides
   everything below. Set this when you want one id to follow the install across
   server moves, or for air-gapped/reproducible setups.
2. **Persisted random id** — generated once on first boot and stored in the
   install's own database (`instance_identity` table, migration 045). Stable
   across restarts **and** domain changes for the life of that database.

> **Pre-T9 behaviour (the bug):** the id was `sha256(LICENSE_KEY + APP_URL +
> process.pid)`. `process.pid` changes every restart (node isn't PID 1 under the
> `migrate && server` shell CMD) and `APP_URL` changes when an operator goes
> live — so a routine restart or domain change silently produced a *new* id, the
> master rejected it as "already bound", and the env-key path called
> `process.exit(1)` under `restart: unless-stopped` → **crash-loop**. T9 removes
> both unstable inputs.

## Symptom → cause → fix

**Symptom:** a self-hosted backend logs `License invalid: License key is already
bound to a different instance` and (on the env-key path) restart-loops, or the
dashboard shows the plan reverted to trial after a heartbeat.

**Likely cause (post-T9):**

| Cause | Notes |
|---|---|
| Genuine server move to a **fresh** database | New DB → new persisted id → master still holds the old bind. Expected; needs an admin unbind. |
| Customer restored onto a new host but did **not** carry the DB volume | Same as above — the persisted id lived in the old DB. |
| **One-time upgrade to the T9 release** | Every previously-bound key re-computes a new id on first validate after upgrade. See *Release migration* below. |

A simple restart, a domain change, or a backup/restore that **carries the DB
volume** should **no longer** rebind post-T9. If one of those triggers a lock,
treat it as a regression.

### Fix — unbind (clears the bind; next instance re-binds)

Find the license id (`GET /api/platform/licenses` or the platform admin list),
then, authenticated as a platform admin:

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  https://shenmay.ai/api/platform/licenses/<LICENSE_ID>/unbind
```

The next time the customer's instance validates (on restart, or within 24h via
the heartbeat) it re-binds the key to its current id. Ask the customer to restart
for an immediate rebind.

### Fix — transfer to a known id (binds to a specific instance)

If you already know the target instance's id (e.g. the customer set
`SHENMAY_INSTANCE_ID`), bind directly instead of clearing:

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $PLATFORM_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"instance_id":"<TARGET_INSTANCE_ID>"}' \
  https://shenmay.ai/api/platform/licenses/<LICENSE_ID>/unbind
```

### Fix — direct on the master DB (break-glass)

If the API is unavailable:

```bash
ssh nomii@204.168.232.24 \
  "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai \
   -c \"UPDATE licenses SET instance_id = NULL, last_ping_at = NULL WHERE id = <LICENSE_ID>;\""
```

## Recommending the `SHENMAY_INSTANCE_ID` pin

For customers who change hosts or domains often, have them pin a stable id so a
move never rebinds (after a one-time unbind to clear the old id):

```env
# In the customer's .env, alongside SHENMAY_LICENSE_KEY:
SHENMAY_INSTANCE_ID=acme-prod-01     # any stable, opaque string they control
```

The pin is already wired through `docker-compose.selfhosted.yml`. After setting
it, unbind the key once so the master accepts the new pinned id on the next
validate.

## Release migration — first deploy of the T9 release

The id formula changed, so **every currently-bound license re-computes a
different id on its first validate after upgrading**. Before/at the release that
ships T9, unbind all bound keys once so each re-binds cleanly:

```bash
# Inspect first — how many keys are bound?
ssh nomii@204.168.232.24 \
  "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai \
   -c \"SELECT id, issued_to_email, instance_id FROM licenses WHERE instance_id IS NOT NULL;\""

# Clear them in one statement (each re-binds on the customer's next validate):
ssh nomii@204.168.232.24 \
  "docker exec -i shenmay-db psql -U shenmay -d shenmay_ai \
   -c \"UPDATE licenses SET instance_id = NULL, last_ping_at = NULL WHERE instance_id IS NOT NULL;\""
```

This cannot be auto-migrated: the master can't know in advance which new id each
install will generate. The unbind is idempotent and safe to run at any time —
worst case a customer's instance simply re-binds to itself on the next heartbeat.
