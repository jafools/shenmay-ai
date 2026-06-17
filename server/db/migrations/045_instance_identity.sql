-- ============================================================
-- 045 — instance_identity (stable self-hosted license id)
-- ============================================================
--
-- Before this, a self-hosted instance derived the id it sends to the license
-- master as:
--
--     sha256(LICENSE_KEY + APP_URL + process.pid).slice(0,16)
--
-- Both APP_URL and process.pid are unstable:
--   * process.pid changes on every restart — the Dockerfile CMD is `migrate &&
--     server` (a shell), so node is NOT PID 1 and gets a fresh pid each boot.
--   * APP_URL changes the moment an operator points the install at their real
--     domain (near-universal when going live).
--
-- The master binds a key to the first instance_id it sees and rejects any
-- mismatch ("License key is already bound … Contact support to transfer"). So a
-- routine restart or a domain change hard-locked paying customers in a crash-loop
-- (the env-key path calls process.exit(1) under `restart: unless-stopped`).
-- See audit finding M4 / task T9 (docs/AUDIT-2026-06-10.md).
--
-- The fix: persist ONE random per-install identifier here, generated once on
-- first boot and reused across restarts and domain changes. Properties:
--   * Stable for the life of the install (no restart / domain-change churn).
--   * Unique per install — a key copied to a *fresh* install gets a new DB → a
--     new id → the master still rejects the second instance (anti-copy preserved;
--     a deliberate transfer is the admin-only unbind endpoint).
--   * A full DB-volume migration carries the id along, so a genuine server move
--     by backup/restore keeps working without an unbind.
--
-- Single row, pinned by a fixed PK (id = 1). The CHECK lives inline in CREATE
-- TABLE so `CREATE TABLE IF NOT EXISTS` stays fully idempotent on the
-- auto-migrate-on-boot re-run (PG ≤ 16 has no ADD CONSTRAINT IF NOT EXISTS).
-- The id value itself is written by the app (crypto-random) via an
-- INSERT … ON CONFLICT DO NOTHING get-or-create — never seeded here.
CREATE TABLE IF NOT EXISTS instance_identity (
  id           SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instance_id  TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
