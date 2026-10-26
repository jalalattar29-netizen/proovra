-- A MERGED SCIM GROUP KEEPS ANSWERING FOR ITS SURVIVOR
-- (members re-audit N-4, 2026-10-26).
--
-- When the Organization's same-externalId SCIM groups were merged (one live
-- group per Organization and external id), every duplicate a sibling
-- workspace's directory had created was ARCHIVED and its workspace reach
-- carried as a projection of the surviving (canonical) group. But that
-- workspace's directory app still addresses the group by the id it was given
-- — the archived one — and a PATCH on an archived group answers 404. Every
-- membership change was refused, removals included: people taken out of the
-- group in the identity provider kept the role it had given them in that
-- workspace (stale access), and nothing told the operator.
--
-- This records, on each such archived duplicate, the survivor it was merged
-- into (scim_groups.merged_into_group_id, nullable, a RESTRICT self reference).
-- The SCIM service follows it: a read or PATCH of the archived id is applied
-- to the survivor, a removal also undoes what the archived group itself had
-- granted, and a DELETE of the archived id ends the survivor's reach into the
-- archived group's own workspace only.
--
-- WHICH ROWS. An ARCHIVED group with an external id whose Organization holds
-- an ACTIVE group of the same external id configured from ANOTHER workspace,
-- and whose own workspace that survivor still reaches through an ACTIVE
-- projection — the exact shape the merge left. A group archived by its own
-- directory (SCIM DELETE) is not one: a group deleted before the merge left
-- an ARCHIVED projection, and one deleted after it has no survivor projecting
-- into its workspace on its behalf. Those stay unmerged (a PATCH of a deleted
-- group is still 404, as it should be).
--
-- Nothing is deleted. Idempotent: the column and constraint are guarded, and
-- the backfill touches only rows whose merged_into_group_id is still NULL.

ALTER TABLE "scim_groups" ADD COLUMN IF NOT EXISTS "merged_into_group_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_groups_merged_into_group_id_fkey') THEN
    ALTER TABLE "scim_groups"
      ADD CONSTRAINT "scim_groups_merged_into_group_id_fkey"
      FOREIGN KEY ("merged_into_group_id") REFERENCES "scim_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "scim_groups_merged_into_group_id_idx" ON "scim_groups" ("merged_into_group_id");

UPDATE "scim_groups" d
   SET "merged_into_group_id" = c."id",
       "updated_at" = NOW()
  FROM "scim_groups" c
 WHERE d."status" = 'ARCHIVED'
   AND d."merged_into_group_id" IS NULL
   AND d."external_id" IS NOT NULL
   AND c."status" = 'ACTIVE'
   AND c."organization_id" = d."organization_id"
   AND c."external_id" = d."external_id"
   AND c."id" <> d."id"
   AND c."team_id" <> d."team_id"
   AND EXISTS (
     SELECT 1 FROM "scim_group_workspace_projections" p
      WHERE p."scim_group_id" = c."id"
        AND p."workspace_id" = d."team_id"
        AND p."status" = 'ACTIVE'
   );
