-- PHASE 13 (NEW-058) — ACCOUNT-BOUND STEP-UP: verified contact factors.
--
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- The enterprise step-up gate took its destination from the REQUEST BODY.
-- `StartBody` accepted `phone` and the service passed it to the messaging
-- provider verbatim: there was no lookup against the user, no stored handset,
-- no binding of any kind. The gate therefore proved possession of a phone the
-- CALLER CHOSE, not possession of the account's second factor — so a stolen
-- session could supply the attacker's own number and approve its own
-- challenge, and every step-up-gated mutation (evidence publication and
-- withdrawal, reviewer approve/reject, escalation resolve, bulk reviewer
-- operations, destruction approve and execute, governance policy update,
-- department membership grant and revoke) inherited that.
--
-- THE SHAPE OF THE FIX
-- ---------------------------------------------------------------------------
-- The destination becomes an ENROLLED, VERIFIED, REVOCABLE factor owned by the
-- user, resolved server-side. It lives in `mfa_factors` — the authority TOTP
-- already occupies — rather than in a second table, because two identity
-- authorities can disagree about who holds what and this one is asked
-- "may this account elevate?" at the most sensitive moment in the product.
--
-- FORWARD-ONLY, AND NOTHING IS BACKFILLED
-- ---------------------------------------------------------------------------
-- No historical recipient number is promoted to a verified factor. A number
-- that was once typed into a request body was never proven to belong to the
-- account, and inventing enrolments from that history would reproduce the
-- defect with a database row as its alibi. Every existing user is therefore
-- UNENROLLED, and every step-up-dependent mutation fails closed for them with
-- a stable enrollment-required denial until they enrol.

-- ---------------------------------------------------------------------------
-- 1. Contact channels join the factor-kind vocabulary.
-- ---------------------------------------------------------------------------
ALTER TYPE "MfaFactorKind" ADD VALUE IF NOT EXISTS 'SMS';
ALTER TYPE "MfaFactorKind" ADD VALUE IF NOT EXISTS 'WHATSAPP';

-- ---------------------------------------------------------------------------
-- 2. The TOTP secret becomes optional AT THE COLUMN and stays mandatory AT THE
--    CONTRACT. A contact factor has no shared secret; a TOTP factor without
--    one is still refused, by the CHECK in step 4.
-- ---------------------------------------------------------------------------
ALTER TABLE "mfa_factors" ALTER COLUMN "secret_ciphertext" DROP NOT NULL;
ALTER TABLE "mfa_factors" ALTER COLUMN "secret_iv"         DROP NOT NULL;
ALTER TABLE "mfa_factors" ALTER COLUMN "secret_auth_tag"   DROP NOT NULL;
ALTER TABLE "mfa_factors" ALTER COLUMN "secret_kek_id"     DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The enrolled destination, sealed with the same envelope scheme as the
--    TOTP secret. `destination_hash` is the deterministic lookup key so
--    "already enrolled?" is answerable without the plaintext;
--    `destination_mask` is the only value any surface may render.
-- ---------------------------------------------------------------------------
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_ciphertext" BYTEA;
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_iv"         BYTEA;
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_auth_tag"   BYTEA;
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_kek_id"     VARCHAR(64);
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_hash"       VARCHAR(64);
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "destination_mask"       VARCHAR(32);
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "verified_at_utc"        TIMESTAMPTZ(6);
ALTER TABLE "mfa_factors" ADD COLUMN IF NOT EXISTS "generation"             INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 4. The invariant the nullability in step 2 widened, restored exactly.
--
--    A TOTP row carries all four secret columns and no destination columns.
--    A contact row carries all four destination columns plus its hash and mask
--    and no secret columns. There is no third shape.
-- ---------------------------------------------------------------------------
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_kind_payload_chk";
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_kind_payload_chk" CHECK (
  (
    "kind" = 'TOTP'
    AND "secret_ciphertext" IS NOT NULL
    AND "secret_iv" IS NOT NULL
    AND "secret_auth_tag" IS NOT NULL
    AND "secret_kek_id" IS NOT NULL
    AND "destination_ciphertext" IS NULL
    AND "destination_hash" IS NULL
  )
  OR (
    -- Compared AS TEXT, deliberately.
    --
    -- 'SMS' and 'WHATSAPP' are added to the enum by this same migration, and
    -- PostgreSQL refuses to USE a new enum label in the transaction that added
    -- it (SQLSTATE 55P04, "unsafe use of new value"). Whether this file runs
    -- statement-by-statement or as one transaction is an executor detail — the
    -- guarded index preconditions below are enough to change that answer — so
    -- the constraint must not depend on it. Casting the COLUMN to text
    -- compares against plain string literals and never references the new
    -- labels, which makes this migration correct under either mode. The
    -- predicate is otherwise identical: `kind` is an enum, so its text form is
    -- exactly the label.
    "kind"::text IN ('SMS', 'WHATSAPP')
    AND "destination_ciphertext" IS NOT NULL
    AND "destination_iv" IS NOT NULL
    AND "destination_auth_tag" IS NOT NULL
    AND "destination_kek_id" IS NOT NULL
    AND "destination_hash" IS NOT NULL
    AND "destination_mask" IS NOT NULL
    AND "secret_ciphertext" IS NULL
  )
);

-- ---------------------------------------------------------------------------
-- 5a. BACKFILL — existing ACTIVE TOTP factors already have a verification
--     instant; it is called `enrolled_at`.
--
--     A TOTP factor only reaches ACTIVE by completing the enrolment
--     round-trip, so `enrolled_at` IS the moment it was proven and copying it
--     records a fact rather than inventing one. This is NOT the forbidden
--     backfill: no destination is promoted to "verified" here, because TOTP
--     rows have no destination. Contact factors get their `verified_at_utc`
--     only from an actual enrolment verification, and none exist yet.
--
--     `created_at` is the fallback for any row whose `enrolled_at` was never
--     stamped — an ACTIVE row must carry a verification instant, and the
--     earliest defensible one is when the row appeared.
-- ---------------------------------------------------------------------------
UPDATE "mfa_factors"
   SET "verified_at_utc" = COALESCE("enrolled_at", "created_at")
 WHERE "status" = 'ACTIVE'
   AND "verified_at_utc" IS NULL;

-- ---------------------------------------------------------------------------
-- 5b. An ACTIVE factor must have been PROVEN.
--
--    `status = ACTIVE` with a null `verified_at_utc` is the contradiction that
--    would let an unverified enrolment authorise an elevation. The database
--    refuses it rather than relying on every writer to remember.
-- ---------------------------------------------------------------------------
ALTER TABLE "mfa_factors" DROP CONSTRAINT IF EXISTS "mfa_factors_active_is_verified_chk";
ALTER TABLE "mfa_factors" ADD CONSTRAINT "mfa_factors_active_is_verified_chk" CHECK (
  "status" <> 'ACTIVE' OR "verified_at_utc" IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- 6. One enrolled destination per user per channel.
-- ---------------------------------------------------------------------------
--    PRECONDITION GUARD (Phase O-Final defense).
--
--    The two indexes below stand on columns this migration does NOT create:
--    `user_id`, `kind` and `status` are expected to already exist on
--    `mfa_factors`. `ADD COLUMN IF NOT EXISTS` above is idempotency, which is a
--    different concern entirely — it says nothing about whether the columns an
--    index READS are present. On a database whose shape has drifted, an
--    unguarded CREATE INDEX fails mid-migration with a bare
--    "column does not exist", which is the `discussion_mentions.team_id`
--    failure class. Assert the precondition first, and name what is missing.
--
--    Fail-closed by construction: no EXCEPTION handler, no fallback DDL, and
--    the RAISE aborts the transaction so no later statement runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mfa_factors') THEN
    RAISE EXCEPTION 'NEW-058 precondition failed: relation public.mfa_factors is missing; refusing to create mfa_factors_user_kind_destination_key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mfa_factors' AND column_name = 'user_id') THEN
    RAISE EXCEPTION 'NEW-058 precondition failed: column public.mfa_factors.user_id is missing; refusing to create mfa_factors_user_kind_destination_key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'mfa_factors' AND column_name = 'kind') THEN
    RAISE EXCEPTION 'NEW-058 precondition failed: column public.mfa_factors.kind is missing; refusing to create mfa_factors_user_kind_destination_key';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "mfa_factors_user_kind_destination_key"
  ON "mfa_factors" ("user_id", "kind", "destination_hash");

--    Guard for mfa_factors_user_id_kind_status_idx. Written tightly on purpose:
--    the messages name the relation and column that is missing, and nothing
--    else, so all three checks sit immediately above the statement they
--    protect rather than scrolling away from it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mfa_factors' AND column_name='user_id') THEN
    RAISE EXCEPTION 'NEW-058: missing public.mfa_factors.user_id';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mfa_factors' AND column_name='kind') THEN
    RAISE EXCEPTION 'NEW-058: missing public.mfa_factors.kind';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='mfa_factors' AND column_name='status') THEN
    RAISE EXCEPTION 'NEW-058: missing public.mfa_factors.status';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "mfa_factors_user_id_kind_status_idx"
  ON "mfa_factors" ("user_id", "kind", "status");

-- ---------------------------------------------------------------------------
-- 7. The challenge records WHICH factor authorised it, and at WHICH
--    generation. A challenge issued against generation 3 becomes unspendable
--    the moment the user re-enrols and the factor moves to 4.
--
--    Nullable for rows written before this migration. The consume path treats
--    a null factor as UNSPENDABLE — the pre-existing window fails closed, not
--    open, and closes entirely as those rows expire (max TTL 1h).
-- ---------------------------------------------------------------------------
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "factor_id"         UUID;
ALTER TABLE "step_up_challenges" ADD COLUMN IF NOT EXISTS "factor_generation" INTEGER;

--    Guarded on the same principle as the two above. `factor_id` IS added by
--    this migration, but only if that ALTER actually reached this database —
--    `ADD COLUMN IF NOT EXISTS` is a no-op on a table that already carries a
--    same-named column of a different shape, and the index must not be the
--    thing that discovers it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'step_up_challenges') THEN
    RAISE EXCEPTION 'NEW-058 precondition failed: relation public.step_up_challenges is missing; refusing to create step_up_challenges_factor_id_idx';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'step_up_challenges' AND column_name = 'factor_id') THEN
    RAISE EXCEPTION 'NEW-058 precondition failed: column public.step_up_challenges.factor_id is missing; refusing to create step_up_challenges_factor_id_idx';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "step_up_challenges_factor_id_idx"
  ON "step_up_challenges" ("factor_id");
