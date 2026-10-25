-- COLLABORATION TEAM VOCABULARY IS ENFORCED BY THE DATABASE
-- (members audit DOM-08, 2026-10-26).
--
-- The Collaboration Team tables carry their role and status as free text
-- (VARCHAR(20)); the vocabulary lived only in @proovra/shared
-- (collaboration-team.ts), so a hand-written UPDATE or a writer bug could
-- store a status no reader understands — a member who is neither ACTIVE nor
-- SUSPENDED nor REMOVED is silently nobody.
--
-- Each column gets a CHECK over exactly the shared vocabulary:
--
--   collaboration_teams.status                 ACTIVE | ARCHIVED
--   collaboration_team_members.status          ACTIVE | SUSPENDED | REMOVED
--   collaboration_team_members.role            LEAD | ADMIN | MEMBER | VIEWER | EXTERNAL
--   collaboration_team_invites.status          PENDING | ACCEPTED | REVOKED | EXPIRED
--   collaboration_team_invites.role            LEAD | ADMIN | MEMBER | VIEWER | EXTERNAL
--   collaboration_team_invites.delivery_status PENDING | SENT | DELIVERED | FAILED | BOUNCED
--   collaboration_team_assignments.status      OPEN | IN_PROGRESS | COMPLETED | REASSIGNED | CANCELLED
--
-- NOT VALID: the constraint binds every NEW write at once, and is not checked
-- against existing rows here, so applying it cannot fail on legacy data and
-- takes no long lock. The readiness query counts any existing violator; when
-- it reads 0 an operator may run ALTER TABLE … VALIDATE CONSTRAINT (a later,
-- separate step — never run against production by this release).
--
-- The `collaboration_team_*.team_id` column NAME is unchanged (it points at
-- collaboration_teams, not teams); renaming it needs a migration window and is
-- documented, not done (docs/architecture/members-and-access-model.md).
--
-- EXPAND only; every statement guarded, idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_teams_status_vocab') THEN
    ALTER TABLE "collaboration_teams"
      ADD CONSTRAINT "collaboration_teams_status_vocab"
      CHECK ("status" IN ('ACTIVE', 'ARCHIVED')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_members_status_vocab') THEN
    ALTER TABLE "collaboration_team_members"
      ADD CONSTRAINT "collaboration_team_members_status_vocab"
      CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'REMOVED')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_members_role_vocab') THEN
    ALTER TABLE "collaboration_team_members"
      ADD CONSTRAINT "collaboration_team_members_role_vocab"
      CHECK ("role" IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_invites_status_vocab') THEN
    ALTER TABLE "collaboration_team_invites"
      ADD CONSTRAINT "collaboration_team_invites_status_vocab"
      CHECK ("status" IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_invites_role_vocab') THEN
    ALTER TABLE "collaboration_team_invites"
      ADD CONSTRAINT "collaboration_team_invites_role_vocab"
      CHECK ("role" IN ('LEAD', 'ADMIN', 'MEMBER', 'VIEWER', 'EXTERNAL')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_invites_delivery_vocab') THEN
    ALTER TABLE "collaboration_team_invites"
      ADD CONSTRAINT "collaboration_team_invites_delivery_vocab"
      CHECK ("delivery_status" IN ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'BOUNCED')) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaboration_team_assignments_status_vocab') THEN
    ALTER TABLE "collaboration_team_assignments"
      ADD CONSTRAINT "collaboration_team_assignments_status_vocab"
      CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'REASSIGNED', 'CANCELLED')) NOT VALID;
  END IF;
END $$;
