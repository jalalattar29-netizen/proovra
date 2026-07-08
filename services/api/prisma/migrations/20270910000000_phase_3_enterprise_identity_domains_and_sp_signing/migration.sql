-- Phase 3 — Enterprise Identity: SAML SP AuthnRequest signing material +
-- DNS-verified organization domain ownership.
--
-- This migration is PURELY ADDITIVE. It adds nullable columns to
-- sso_connections and creates one new table (organization_domains). No
-- existing column, constraint, or row is modified or dropped.

-- ---------------------------------------------------------------------------
-- sso_connections: SP signing material + verified-domain enforcement flag.
-- ---------------------------------------------------------------------------
-- Per-connection SP signing private key (PEM). When set AND
-- saml_sign_requests = true, the SP signs AuthnRequests with this key rather
-- than the platform-wide SAML_SP_PRIVATE_KEY env. NULL for every existing row.
ALTER TABLE "sso_connections" ADD COLUMN "saml_sp_private_key" TEXT;

-- Per-connection SP X.509 certificate (base64, no PEM header/footer) advertised
-- in SP metadata + embedded in the signed AuthnRequest KeyInfo.
ALTER TABLE "sso_connections" ADD COLUMN "saml_sp_certificate" VARCHAR(8192);

-- When true, SSO logins through this connection are additionally restricted to
-- VERIFIED OrganizationDomain rows (layered on top of allowed_email_domains).
-- Default false preserves existing behaviour for every connection.
ALTER TABLE "sso_connections"
  ADD COLUMN "restrict_to_verified_domains" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- organization_domains: DNS-verified domain ownership.
-- ---------------------------------------------------------------------------
CREATE TABLE "organization_domains" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "domain" VARCHAR(253) NOT NULL,
    "verification_token" VARCHAR(128) NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id")
);

-- A domain is claimed at most once per org.
CREATE UNIQUE INDEX "organization_domains_org_domain_uniq"
  ON "organization_domains" ("organization_id", "domain");

CREATE INDEX "organization_domains_domain_idx"
  ON "organization_domains" ("domain");

CREATE INDEX "organization_domains_org_verified_idx"
  ON "organization_domains" ("organization_id", "verified_at");

-- Org deletion cascades its domain rows (mirrors other org-owned tables).
ALTER TABLE "organization_domains"
  ADD CONSTRAINT "organization_domains_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
