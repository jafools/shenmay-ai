-- ============================================================
-- Migration 043 — Stripe webhook idempotency ledger
--
-- Stripe delivers webhooks at-least-once: a network blip, a slow
-- 200, or a manual resend in the dashboard all cause the SAME event
-- to arrive again. Re-processing a `checkout.session.completed` for a
-- self-hosted purchase issues (and emails) a SECOND license key; for
-- a SaaS upgrade it re-runs the subscription write. event.id is
-- globally unique and stable across retries, so we record each id the
-- first time we see it and skip any repeat.
--
-- CREATE TABLE IF NOT EXISTS is idempotent on its own (no ADD
-- CONSTRAINT, so the PG<=16 idempotency caveat does not apply here),
-- and the backend re-runs every migration on boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS processed_stripe_events (
  -- Stripe's event id, e.g. "evt_1ABCxyz…". Globally unique per account
  -- and identical across redeliveries — the natural idempotency key.
  event_id      TEXT        PRIMARY KEY,

  -- Event type (e.g. "checkout.session.completed"). Stored for audit /
  -- debugging only; not used by the dedupe check.
  type          TEXT,

  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Housekeeping query support: prune rows older than a retention window
-- (Stripe never retries beyond ~3 days, so old ids are safe to drop).
CREATE INDEX IF NOT EXISTS processed_stripe_events_processed_at_idx
  ON processed_stripe_events (processed_at);
