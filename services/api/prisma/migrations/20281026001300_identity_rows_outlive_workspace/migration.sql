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
DECLARE
  tbl TEXT;
  fk TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['scim_provisioning_tokens', 'external_identity_mappings',
                             'sso_callback_attempts', 'sso_connections'] LOOP
    fk := tbl || '_team_id_fkey';
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk AND confdeltype <> 'r') THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', tbl, fk);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = fk) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
        tbl, fk);
    END IF;
  END LOOP;
END $$;
