-- =============================================================================
-- 2026-11-18 — PRO-A2-02 / B5B-F-302 (WS-ORG RG-06): who created an
-- Organization identity link.
--
-- An Organization identity administrator could bind an IdP subject they
-- control to a pre-existing SELF-SERVE member through the manual mapping route
-- and then sign in AS that account. The manual route now refuses a self-serve
-- account (the owner's own consent flow is the only way to link one), and
-- every mapped sign-in / IdP step-up re-checks the link's provenance. That
-- needs the provenance on the row:
--
--   link_source  SCIM | OIDC_JIT | SAML_JIT | OWNER_CONSENT | ADMIN_MANUAL
--                NULL = written before this column existed (legacy). A legacy
--                link on a self-serve account is honoured only with owner-
--                consent evidence (the consent flow's membership grant);
--                remediate-admin-manual-identity-links lists the rest (dry run).
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no default, no index, no
-- backfill: no row is rewritten and an older image never reads it (an older
-- image writing a row leaves it NULL = legacy, which the new image treats
-- exactly like every pre-existing row). Rollback: leave the column.
-- =============================================================================

ALTER TABLE "external_identity_mappings"
  ADD COLUMN "link_source" VARCHAR(24);
