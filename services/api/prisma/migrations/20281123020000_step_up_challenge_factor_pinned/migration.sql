-- =============================================================================
-- 2026-11-21 — MATRIX-M054 (owner decision B): a workspace step-up that was
-- started with an EXPLICITLY selected factor is answered by that factor only.
--
-- `startStepUpChallenge` always records the factor a challenge was minted
-- against (`factor_id`, NEW-058), whether the caller named it or the server
-- picked the account's newest verified authenticator. The check path could not
-- tell the two apart, so it answered every challenge with any ACTIVE verified
-- authenticator of the account (M054 / DEC-19), including one the caller had
-- deliberately pinned to a single app.
--
-- `factor_pinned` is TRUE only when the start request named a `factorId` and
-- that factor resolved; the TOTP check then accepts that factor's code alone.
-- NULL (every existing row, every row an older image writes, and every
-- challenge started without a factorId) keeps the approved multi-factor
-- behaviour. Sign-in, the account step-up and the self-check never select a
-- factor and do not read this column.
--
-- EXPAND / SAFE_TO_APPLY_NOW. One nullable column, no default, no backfill,
-- no NOT NULL, no index, no table rewrite. An older image never reads or
-- writes it. Rollback: leave the column (NULL is the old behaviour).
-- =============================================================================

ALTER TABLE "step_up_challenges"
  ADD COLUMN "factor_pinned" BOOLEAN;
