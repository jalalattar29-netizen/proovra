-- Review remediation (2026-11-27). Additive, metadata-only: nullable or
-- defaulted columns, no index, no backfill. Older images neither read nor
-- write them. Rollback: leave the columns.
--
-- review_escalations.requires_independent_review — whether THIS escalation
-- requires an independent second decision. NULL = recorded before the change
-- (read with the legacy rule: a person-raised, non-sweep escalation forces);
-- new escalations always store true or false explicitly.
ALTER TABLE "review_escalations" ADD COLUMN "requires_independent_review" BOOLEAN;
ALTER TABLE "review_escalations" ADD COLUMN "independence_note" VARCHAR(400);

-- Explicit workspace Review policies (all default off = the ordinary Team
-- journey). Enterprise contracts keep their own placement term.
ALTER TABLE "workspace_governance_policies" ADD COLUMN "review_requires_independent_approval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspace_governance_policies" ADD COLUMN "review_requires_team_placement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspace_governance_policies" ADD COLUMN "review_requires_complete_coding" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "workspace_governance_policies" ADD COLUMN "review_requires_complete_coding_since" TIMESTAMPTZ(6);
