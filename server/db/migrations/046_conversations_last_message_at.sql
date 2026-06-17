-- ============================================================
-- 046 — denormalize conversations.last_message_at (audit M10 / task T13)
-- ============================================================
--
-- The conversations list (the most-visited portal screen) sorted the tenant's
-- entire filtered set with a correlated per-row subquery:
--
--     ORDER BY COALESCE(
--       (SELECT created_at FROM messages WHERE conversation_id = c.id
--        ORDER BY created_at DESC LIMIT 1),
--       c.created_at) DESC
--
-- The sort-key subplan ran for every filtered row (before LIMIT), so the screen
-- degraded linearly with a tenant's conversation volume on a 2-vCPU box.
--
-- Fix: store the last message time on the conversation row and sort on it.
--   1. Add the column (nullable → instant, no table rewrite).
--   2. Backfill from messages (fallback to the conversation's own created_at).
--   3. DEFAULT NOW() so new conversations are populated without app changes.
--   4. A trigger keeps it current on EVERY message insert — covers all 6 insert
--      sites (and any future one) atomically with the insert, so it can't drift.
--   5. A descending index supports the new ORDER BY c.last_message_at DESC.
--
-- All statements are idempotent (IF NOT EXISTS / CREATE OR REPLACE / null-guarded
-- backfill) and transaction-safe, so the auto-migrate-on-boot re-run is a no-op.
-- CREATE OR REPLACE TRIGGER requires PG 14+ (prod/staging/CI are 16.9).

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;

UPDATE conversations c
   SET last_message_at = COALESCE(
     (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id),
     c.created_at
   )
 WHERE last_message_at IS NULL;

ALTER TABLE conversations ALTER COLUMN last_message_at SET DEFAULT NOW();

-- Keep last_message_at current on message insert. GREATEST guards against an
-- out-of-order insert (e.g. a backfilled older message) moving the value back.
CREATE OR REPLACE FUNCTION bump_conversation_last_message_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
     SET last_message_at = GREATEST(COALESCE(last_message_at, NEW.created_at), NEW.created_at)
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_messages_bump_last_message_at
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION bump_conversation_last_message_at();

CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at
  ON conversations (last_message_at DESC);
