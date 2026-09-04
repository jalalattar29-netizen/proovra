-- Customer ID for External Intake.
--
-- The identifier an organization uses for its OWN customer, supplied when it
-- creates an intake link. PROOVRA neither issues nor validates it.
--
-- `workflow_intake_links.customer_id` is AUTHORITATIVE — it is where the
-- organization stated it. `evidence.intake_customer_id` is a SNAPSHOT taken
-- when the submission became a record, so that provenance stays historical and
-- so that search can filter an indexed column instead of joining through
-- session -> link on every query.
--
-- Both are nullable and nothing is backfilled: every row that predates this
-- migration keeps a true NULL. No integrity, hash, signature, custody or
-- verification semantics are touched.

ALTER TABLE "workflow_intake_links"
  ADD COLUMN IF NOT EXISTS "customer_id" VARCHAR(120);

ALTER TABLE "evidence"
  ADD COLUMN IF NOT EXISTS "intake_customer_id" VARCHAR(120);

-- Tenant-scoped by construction: every customer-id lookup is bounded by the
-- workspace, so the index is too and can never serve a cross-workspace probe.
CREATE INDEX IF NOT EXISTS "workflow_intake_links_team_id_customer_id_idx"
  ON "workflow_intake_links" ("team_id", "customer_id");

CREATE INDEX IF NOT EXISTS "evidence_team_id_intake_customer_id_idx"
  ON "evidence" ("team_id", "intake_customer_id");
