-- PHASE 10 §policy-lifecycle (2026-07-23) — the ORGANIZATION owns the security
-- policy lifecycle. Moves the PK off `team_id` to a synthetic `id`, makes
-- `team_id` NULLABLE compatibility metadata, and REPLACES the dangerous
-- Team→policy ON DELETE CASCADE with ON DELETE SET NULL so deleting/archiving a
-- Workspace can never delete or re-parent the org policy. NOT APPLIED.

ALTER TABLE "organization_security_policies"
  ADD COLUMN IF NOT EXISTS "id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Swap the primary key: team_id → id.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_security_policies_pkey') THEN
    ALTER TABLE "organization_security_policies" DROP CONSTRAINT "organization_security_policies_pkey";
  END IF;
END
$$;
ALTER TABLE "organization_security_policies"
  ADD CONSTRAINT "organization_security_policies_pkey" PRIMARY KEY ("id");

-- team_id becomes nullable compatibility metadata.
ALTER TABLE "organization_security_policies"
  ALTER COLUMN "team_id" DROP NOT NULL;

-- Replace the Team cascade with SET NULL (Workspace deletion must NOT delete
-- the org policy). Re-create the FK deterministically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organization_security_policies_team_id_fkey') THEN
    ALTER TABLE "organization_security_policies" DROP CONSTRAINT "organization_security_policies_team_id_fkey";
  END IF;
  ALTER TABLE "organization_security_policies"
    ADD CONSTRAINT "organization_security_policies_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
END
$$;
