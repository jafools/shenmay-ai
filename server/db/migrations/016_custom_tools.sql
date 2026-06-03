-- ============================================================
-- Migration 016 — Custom Tool Builder
--
-- Allows non-technical tenants to define their own tools via a
-- form in the Shenmay dashboard — no code required.
--
-- Each row defines one tool available to that tenant's AI agent.
-- A generic handler runs the appropriate behaviour based on tool_type.
--
-- tool_type values:
--   lookup    — fetches records from customer_data by category
--   calculate — computes aggregates (totals, averages) from customer_data
--   report    — triggers the generate_report universal tool
--   escalate  — triggers the request_specialist universal tool
--   connect   — makes an outbound webhook call to the tenant's own system
--
-- config JSONB — tool-type-specific settings:
--   lookup:    { data_category: "investments" }
--   calculate: { data_category: "expenses", metric: "total|average|count" }
--   report:    { report_type: "summary|detailed|custom", template_hint: "..." }
--   escalate:  { urgency: "low|medium|high", department: "..." }
--   connect:   { webhook_url: "https://...", method: "POST", headers: {...} }
-- ============================================================

CREATE TABLE IF NOT EXISTS custom_tools (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Tool identity
  name             TEXT        NOT NULL,          -- machine name  e.g. "check_portfolio"
  display_name     TEXT        NOT NULL,          -- human name    e.g. "Check Portfolio"
  tool_type        TEXT        NOT NULL           -- lookup | calculate | report | escalate | connect
                               CHECK (tool_type IN ('lookup', 'calculate', 'report', 'escalate', 'connect')),

  -- How Claude knows when to use this tool (becomes the Anthropic tool description)
  trigger_description TEXT     NOT NULL,          -- e.g. "Use when the client asks about their portfolio value"

  -- Tool-type-specific configuration
  config           JSONB       NOT NULL DEFAULT '{}',

  -- Lifecycle
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Each tenant's tool names must be unique (name also used as tool identifier for Claude)
  UNIQUE (tenant_id, name)
);

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION update_custom_tools_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_custom_tools_updated_at
  BEFORE UPDATE ON custom_tools
  FOR EACH ROW
  EXECUTE FUNCTION update_custom_tools_updated_at();

-- Index for fast tenant lookup
CREATE INDEX IF NOT EXISTS idx_custom_tools_tenant_id
  ON custom_tools (tenant_id)
  WHERE is_active = true;

-- ============================================================
-- Example seed (commented out — apply manually if needed)
-- ============================================================
-- INSERT INTO custom_tools (tenant_id, name, display_name, tool_type, trigger_description, config)
-- SELECT
--   id,
--   'check_retirement_readiness',
--   'Check Retirement Readiness',
--   'calculate',
--   'Use when the client asks how ready they are for retirement or how close they are to their retirement goal.',
--   '{"data_category": "retirement_accounts", "metric": "total"}'::jsonb
-- FROM tenants WHERE slug = 'covenant-trust';
