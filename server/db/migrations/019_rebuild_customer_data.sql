-- =============================================================================
-- Migration 019 — Rebuild customer_data to generic schema
-- =============================================================================
--
-- The original customer_data table was designed for financial services
-- (value_primary, value_monthly, institution, data_category, data_type).
-- The Data API (dataApi.js) and portal customer data UI use a generic schema
-- that works across all industries.
--
-- This migration:
--   1. Adds `name TEXT` to customers (used by Data API to store a full/display name)
--   2. Renames the old customer_data table to customer_data_legacy (preserves data)
--   3. Creates new customer_data with the generic schema
--   4. Migrates existing legacy data into the new schema
--   5. Updates lookup indexes
--
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS throughout).
-- =============================================================================

-- ── 1. Add name column to customers ──────────────────────────────────────────
--    Nullable — existing customers keep first_name/last_name.
--    Data API customers populate this field directly.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS name TEXT DEFAULT NULL;

-- Back-fill name from first_name + last_name for existing customers
UPDATE customers
  SET name = TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))
  WHERE name IS NULL AND (first_name IS NOT NULL OR last_name IS NOT NULL);


-- ── 2. Rename old table (preserves existing financial data) ──────────────────
-- Guarded so this migration is genuinely re-runnable (the header above promises
-- "Safe to re-run", and the backend boots with `migrate && server` on every
-- start). A bare RENAME throws "relation customer_data_legacy already exists"
-- on a second run, which crashes the migrate step and boot-loops the container.
-- Rename only when the source still exists AND the target does not; otherwise
-- the rename already happened on a prior run and we leave the rebuilt tables be.
DO $$
BEGIN
  IF to_regclass('public.customer_data') IS NOT NULL
     AND to_regclass('public.customer_data_legacy') IS NULL
  THEN
    EXECUTE 'ALTER TABLE customer_data RENAME TO customer_data_legacy';
  END IF;
END $$;


-- ── 3. Create new generic customer_data table ─────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_data (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    -- Generic fields — work for any industry
    category        VARCHAR(100)  NOT NULL,          -- e.g. "portfolio", "goals", "profile"
    label           VARCHAR(255)  NOT NULL,           -- e.g. "Account Balance", "Risk Tolerance"
    value           TEXT          DEFAULT NULL,       -- primary value as text
    secondary_value TEXT          DEFAULT NULL,       -- e.g. monthly value, secondary metric
    value_type      VARCHAR(50)   DEFAULT NULL,       -- e.g. "currency", "date", "text", "percent"
    metadata        JSONB         DEFAULT NULL,       -- any extra structured data

    source          VARCHAR(30)   NOT NULL DEFAULT 'portal'
                    CHECK (source IN ('portal', 'api', 'csv_import', 'sync')),

    recorded_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- Upsert key: one value per (customer, category, label) combination
    UNIQUE (customer_id, category, label)
);

CREATE INDEX IF NOT EXISTS idx_customer_data_customer  ON customer_data(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_data_category  ON customer_data(customer_id, category);


-- ── 4. Migrate existing legacy data ──────────────────────────────────────────
--    Maps the old financial-specific columns to the new generic schema.
--    Rows with value_primary are treated as currency values.
--    Rows with only details (notes) are stored as text.

INSERT INTO customer_data
    (customer_id, category, label, value, secondary_value, value_type, source, recorded_at, created_at)
SELECT
    customer_id,
    data_category                                       AS category,
    COALESCE(label, data_type)                          AS label,
    CASE WHEN value_primary IS NOT NULL THEN value_primary::TEXT ELSE NULL END AS value,
    CASE WHEN value_monthly IS NOT NULL THEN value_monthly::TEXT ELSE NULL END AS secondary_value,
    CASE WHEN value_primary IS NOT NULL THEN 'currency' ELSE 'text' END        AS value_type,
    CASE
        WHEN source = 'csv_import'  THEN 'csv_import'
        WHEN source = 'api_sync'    THEN 'sync'
        ELSE 'portal'
    END                                                 AS source,
    COALESCE(last_synced_at, created_at)                AS recorded_at,
    created_at
FROM customer_data_legacy
ON CONFLICT (customer_id, category, label) DO NOTHING;


-- ── 5. Rebuild trigger on new table ──────────────────────────────────────────
-- (update_updated_at function already exists from migration 001)
-- customer_data no longer has updated_at so no trigger needed.
-- recorded_at is set to NOW() on INSERT; updates use ON CONFLICT DO UPDATE.


-- Done.
-- To verify:
--   SELECT COUNT(*) FROM customer_data;
--   SELECT COUNT(*) FROM customer_data_legacy;
