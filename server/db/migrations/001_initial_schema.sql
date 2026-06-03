-- ============================================================
-- SHENMAY AI — Initial Database Schema
-- Migration 001: Core tables for multi-tenant agent platform
-- Industry-agnostic: supports any vertical (retirement, healthcare, etc.)
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TENANTS — Companies using Shenmay AI platform
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    slug            VARCHAR(100) NOT NULL UNIQUE,

    -- Vertical / Industry Configuration
    vertical        VARCHAR(100) NOT NULL DEFAULT 'general',
    vertical_config JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Branding
    agent_name      VARCHAR(100) NOT NULL DEFAULT 'AI Assistant',
    logo_url        TEXT,
    primary_color   VARCHAR(7) DEFAULT '#1E3A5F',
    secondary_color VARCHAR(7) DEFAULT '#4A90D9',

    -- Compliance & Configuration
    compliance_config JSONB NOT NULL DEFAULT '{
        "disclaimers": ["This is informational guidance only. Please consult a qualified professional for specific advice."],
        "restricted_topics": [],
        "escalation_triggers": []
    }'::jsonb,

    -- Base Soul Template
    base_soul_template JSONB NOT NULL DEFAULT '{
        "tone": "warm & reassuring",
        "complexity_level": 3,
        "pace": "moderate",
        "emotional_awareness": "high",
        "language": "plain English"
    }'::jsonb,

    -- Onboarding Configuration
    onboarding_config JSONB NOT NULL DEFAULT '{
        "categories": [],
        "optional_categories": [],
        "interview_style": "freeform"
    }'::jsonb,

    -- LLM Configuration
    llm_provider    VARCHAR(50) NOT NULL DEFAULT 'claude',
    llm_model       VARCHAR(100) DEFAULT 'claude-sonnet-4-20250514',

    -- Metadata
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ADVISORS — Human specialists at tenant firms
-- ============================================================
CREATE TABLE IF NOT EXISTS advisors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    role            VARCHAR(50) NOT NULL DEFAULT 'advisor'
                    CHECK (role IN ('advisor', 'senior_advisor', 'admin', 'specialist', 'support')),

    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(tenant_id, email)
);

-- ============================================================
-- CUSTOMERS — End-users of the AI agent
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    assigned_advisor_id UUID REFERENCES advisors(id) ON DELETE SET NULL,

    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(20),
    date_of_birth   DATE,
    location        VARCHAR(255),

    onboarding_status VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (onboarding_status IN ('pending', 'in_progress', 'complete')),
    onboarding_categories_completed JSONB DEFAULT '[]'::jsonb,

    soul_file       JSONB NOT NULL DEFAULT '{}'::jsonb,
    memory_file     JSONB NOT NULL DEFAULT '{}'::jsonb,

    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_interaction_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_customers_advisor ON customers(assigned_advisor_id);
CREATE INDEX IF NOT EXISTS idx_customers_onboarding ON customers(tenant_id, onboarding_status);

-- ============================================================
-- CUSTOMER_DATA — Flexible structured data per customer
-- Stores ANY type of domain data depending on vertical
-- (financial accounts, insurance policies, medical records, etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_data (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    data_category   VARCHAR(100) NOT NULL,
    data_type       VARCHAR(100) NOT NULL,
    label           VARCHAR(255) NOT NULL,
    institution     VARCHAR(255),

    value_primary   DECIMAL(15, 2),
    value_monthly   DECIMAL(10, 2),

    details         JSONB DEFAULT '{}'::jsonb,

    source          VARCHAR(20) NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual', 'csv_import', 'api_sync', 'advisor_entry', 'integration')),

    last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_data_customer ON customer_data(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_data_category ON customer_data(customer_id, data_category);

-- ============================================================
-- CONVERSATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

    session_type    VARCHAR(20) NOT NULL DEFAULT 'chat'
                    CHECK (session_type IN ('onboarding', 'chat', 'review', 'escalation')),
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'ended', 'escalated')),

    summary         TEXT,
    topics_covered  JSONB DEFAULT '[]'::jsonb,
    sentiment       VARCHAR(20),

    advisor_reviewed    BOOLEAN NOT NULL DEFAULT false,
    advisor_notes       TEXT,
    reviewed_at         TIMESTAMPTZ,
    reviewed_by         UUID REFERENCES advisors(id),

    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_customer ON conversations(customer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(customer_id, status);

-- ============================================================
-- MESSAGES
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,

    role            VARCHAR(20) NOT NULL
                    CHECK (role IN ('customer', 'agent', 'system')),
    content         TEXT NOT NULL,
    metadata        JSONB DEFAULT '{}'::jsonb,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages(conversation_id, created_at);

-- ============================================================
-- FLAGS
-- ============================================================
CREATE TABLE IF NOT EXISTS flags (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,

    flag_type       VARCHAR(30) NOT NULL
                    CHECK (flag_type IN (
                        'escalation', 'confusion', 'risk_alert',
                        'exploitation_concern', 'compliance',
                        'advisor_requested', 'high_emotion',
                        'custom'
                    )),
    severity        VARCHAR(10) NOT NULL DEFAULT 'medium'
                    CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    description     TEXT NOT NULL,

    status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
    assigned_advisor_id UUID REFERENCES advisors(id),
    resolution_notes    TEXT,
    resolved_at         TIMESTAMPTZ,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flags_customer ON flags(customer_id);
CREATE INDEX IF NOT EXISTS idx_flags_status ON flags(status);
CREATE INDEX IF NOT EXISTS idx_flags_advisor ON flags(assigned_advisor_id, status);

-- ============================================================
-- ADVISOR-CUSTOMER ASSIGNMENTS (many-to-many)
-- ============================================================
CREATE TABLE IF NOT EXISTS advisor_customers (
    advisor_id      UUID NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (advisor_id, customer_id)
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_tenants_updated_at
    BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_advisors_updated_at
    BEFORE UPDATE ON advisors FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_customers_updated_at
    BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_customer_data_updated_at
    BEFORE UPDATE ON customer_data FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER trg_flags_updated_at
    BEFORE UPDATE ON flags FOR EACH ROW EXECUTE FUNCTION update_updated_at();
