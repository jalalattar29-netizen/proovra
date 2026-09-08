-- =============================================================================
-- RELEASE B — remove the plaintext workspace-invitation token.
--
-- The workspace-invite lifecycle hardening migration (Release A) added
-- `token_hash`, backfilled it from every stored token, made it NOT NULL and
-- UNIQUE, and made `token` nullable. From that deployment onward the API mints
-- invitations with `token = NULL` and resolves acceptance by hash only: there
-- is not one reader of the raw column left in the repository.
--
-- The column was deliberately RETAINED through Release A so that rolling the
-- SERVICE back would not strand live invitations. This is the other half of
-- that staged transition, and it is DESTRUCTIVE by design: a stored plaintext
-- token is a live workspace credential sitting in every backup, and the reason
-- to hold one no longer exists.
--
-- ORDER: apply this ONLY after the Release-A image is live everywhere. An
-- image that predates that release writes `token` NOT NULL and reads by it;
-- dropping the column under it would fail every invitation. There is no
-- ordering hazard in the other direction — the current image never touches it.
-- =============================================================================

-- READINESS GUARD.
--
-- `token_hash` is already NOT NULL, so this can only fire if someone has
-- reintroduced a nullable path — which is exactly the case where dropping the
-- plaintext would leave an invitation with no lookup key at all. Refusing here
-- is a failed migration; the alternative is a silently unusable invitation.
DO $$
DECLARE
  unhashed BIGINT;
BEGIN
  SELECT count(*) INTO unhashed FROM "team_invites" WHERE "token_hash" IS NULL;
  IF unhashed > 0 THEN
    RAISE EXCEPTION
      'workspace-invite raw-token drop refused: % invitation(s) have no token_hash and would lose their only lookup key',
      unhashed;
  END IF;
END $$;

-- The unique index goes with the column it indexed.
DROP INDEX IF EXISTS "team_invites_token_key";

ALTER TABLE "team_invites" DROP COLUMN IF EXISTS "token";
