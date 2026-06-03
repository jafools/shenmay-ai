-- ============================================================
-- SHENMAY AI — Migration 003: Platform Admins
-- Adds a separate table for Shenmay AI platform-level superadmins.
-- These users are completely separate from tenant users.
-- They can create/manage tenants but cannot access tenant data.
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_admins_email ON platform_admins(email);

CREATE OR REPLACE TRIGGER trg_platform_admins_updated_at
    BEFORE UPDATE ON platform_admins FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- TENANT INVITATIONS — Track first-admin account creation links
-- When a tenant is provisioned, a token is generated for the
-- first admin to set their password and activate their account.
-- ============================================================
CREATE TABLE IF NOT EXISTS tenant_invitations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    advisor_id      UUID NOT NULL REFERENCES advisors(id) ON DELETE CASCADE,
    token           VARCHAR(128) NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
    accepted_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token ON tenant_invitations(token);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant ON tenant_invitations(tenant_id);
