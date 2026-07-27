-- =============================================================================
-- P2 DOMAIN REMEDIATION (2026-07-21) — organization invitations can express
-- explicit workspace assignments, and record who accepted them.
--
--   organization_invites.workspace_assignments  JSONB, nullable
--     [{ "teamId": "<uuid>", "role": "OWNER"|"ADMIN"|"MEMBER"|"VIEWER" }]
--     NULL / [] = governance-only invite (OrganizationMembership only —
--     the previous behavior, unchanged for all existing rows).
--
--   organization_invites.accepted_by_user_id    UUID, nullable
--     The user who consumed the invite (audit completeness; historical
--     rows remain NULL).
--
-- Purely additive; rollback = drop both columns, zero data loss.
-- =============================================================================

ALTER TABLE "organization_invites"
  ADD COLUMN "workspace_assignments" JSONB,
  ADD COLUMN "accepted_by_user_id" UUID;
