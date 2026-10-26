-- ORGANIZATION IDENTITY ROWS DO NOT CASCADE WITH A WORKSPACE
-- (members re-audit D-12, 2026-10-26).
--
-- SSO and SCIM belong to the Organization; team_id on these rows is only the
-- workspace each was configured from (for a credential, the Organization's
-- default provisioning workspace). Their team_id foreign keys still read
-- ON DELETE CASCADE, so a raw or operator delete of that one workspace — no
-- product path deletes a workspace — would have erased the Organization's
-- SCIM credentials, every external identity link (and with it every
-- directory-managed person's sign-in binding), its SSO connections and their
-- sign-in history:
--
--   scim_provisioning_tokens_team_id_fkey
--   external_identity_mappings_team_id_fkey
--   sso_callback_attempts_team_id_fkey
--   sso_connections_team_id_fkey
--
-- Each is re-created with the same column, ON UPDATE CASCADE and ON DELETE
-- RESTRICT (the rule the Organization SCIM groups already carry). No row,
-- column or index is touched. Idempotent: guarded on the delete rule in
-- force.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'scim_provisioning_tokens_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "scim_provisioning_tokens" DROP CONSTRAINT "scim_provisioning_tokens_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scim_provisioning_tokens_team_id_fkey') THEN
    ALTER TABLE "scim_provisioning_tokens"
      ADD CONSTRAINT "scim_provisioning_tokens_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'external_identity_mappings_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "external_identity_mappings" DROP CONSTRAINT "external_identity_mappings_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'external_identity_mappings_team_id_fkey') THEN
    ALTER TABLE "external_identity_mappings"
      ADD CONSTRAINT "external_identity_mappings_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sso_callback_attempts_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "sso_callback_attempts" DROP CONSTRAINT "sso_callback_attempts_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_callback_attempts_team_id_fkey') THEN
    ALTER TABLE "sso_callback_attempts"
      ADD CONSTRAINT "sso_callback_attempts_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'sso_connections_team_id_fkey' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "sso_connections" DROP CONSTRAINT "sso_connections_team_id_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_connections_team_id_fkey') THEN
    ALTER TABLE "sso_connections"
      ADD CONSTRAINT "sso_connections_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
