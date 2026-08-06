-- ============================================================================
-- PHASE 12B CLUSTER 8 — Legal-Hold BACKFILL. FORWARD-ONLY. IDEMPOTENT.
--
-- Copies every row of `case_legal_holds` and `legal_holds` into the canonical
-- `evidence_legal_holds` table. It issues INSERTs only: no UPDATE of a legacy
-- row, no DELETE anywhere, and no legacy table is dropped (that is
-- 20271108000000_legal_hold_legacy_removal, which must run only after this
-- migration is applied AND verified).
--
-- PREREQUISITE — run the readiness report first:
--     DATABASE_URL=... node services/api/scripts/legal-hold-convergence-report.mjs
-- It exits 2 when a BLOCKING cross-workspace conflict exists. Resolve those
-- before applying this migration; this migration refuses to merge them.
--
-- ---------------------------------------------------------------------------
-- IDEMPOTENCY KEY
--
--   (source_store, source_row_id)
--
-- deterministic, derived entirely from the legacy row's own primary key, and
-- backed by the unique index created in 20271106000000_legal_hold_canonical.
-- Every INSERT is guarded by NOT EXISTS on that key, so re-running this
-- migration is a no-op and can never duplicate a hold.
--
-- ---------------------------------------------------------------------------
-- THE TEN CASES
--
--  1. EVIDENCE-ONLY HOLD
--     `legal_holds` kind='EVIDENCE' → scope='EVIDENCE', evidence_id set.
--     Pre-existing `evidence_legal_holds` rows are already scope='EVIDENCE'
--     and are NOT touched.
--
--  2. CASE HOLD PROTECTING ALL LINKED EVIDENCE
--     `case_legal_holds` and `legal_holds` kind='CASE' → scope='CASE' with
--     case_id set. No per-evidence rows are fabricated: reach is resolved at
--     evaluation time through `case_evidence_links`, so evidence linked to
--     the case AFTER the backfill is protected too. Fabricating one row per
--     linked evidence would have frozen the reach at migration time.
--
--  3. GENERIC LIFECYCLE HOLD
--     `legal_holds` kind IN ('WORKSPACE','ORGANIZATION') → scope='WORKSPACE'
--     with no target columns; organization_id carries the org binding.
--
--  4. ACTIVE / RELEASED / EXPIRED STATES
--     All three round-trip. EXPIRED exists on LegalHoldStatus as of
--     20271106000000 (it could not be USED there — Postgres forbids using an
--     enum label in the transaction that adds it — which is exactly why the
--     backfill is a separate migration). Any unrecognised legacy state is
--     mapped to ACTIVE: the MOST PROTECTIVE reading, never RELEASED.
--
--  5. SIMULTANEOUS HOLDS FROM BOTH STORES ON ONE TARGET
--     Both are copied. They differ in (source_store, source_row_id), so both
--     survive and both remain individually releasable.
--
--  6. CONFLICTING RELEASE STATES — MOST PROTECTIVE WINS
--     No reconciliation is attempted, because none is needed: each row keeps
--     its own state, and the effective-hold evaluator blocks while ANY row
--     is ACTIVE. A target therefore stays held whenever any source says
--     ACTIVE, which is the required semantics. A "merge" that collapsed the
--     rows into one state would have had to pick a loser — and picking the
--     RELEASED one would make evidence destructible.
--
--  7. MISSING TARGET (ORPHAN)
--     Preserved, never dropped: inserted with historical=true and its target
--     columns NULL (the scope/target CHECK exempts historical rows). Because
--     an unresolvable target cannot be proven NOT to cover a record, the
--     effective-hold evaluator FAILS CLOSED on an ACTIVE historical row and
--     blocks every record in that workspace until an operator resolves it.
--     The readiness report surfaces the count as UNRESOLVED_ACTIVE_HOLD — a
--     non-zero value is an operational alarm, and it is the deliberate
--     trade: a frozen workspace is recoverable, destroyed evidence is not.
--
--  8. CROSS-WORKSPACE MISMATCH
--     REFUSED. A legacy hold whose target belongs to a different tenant than
--     the hold's own team_id is NOT copied, NOT merged, and NOT rewritten to
--     either tenant. It stays in its legacy table and is reported by the
--     readiness script under CROSS_WORKSPACE_*. Merging across tenants would
--     be a tenant-isolation breach.
--
--  9. DUPLICATE SEMANTIC HOLD
--     Deduplication is for BLOCKING only, and is inherent: N active holds on
--     one target block exactly as one does. BOTH provenance records are kept
--     — (team_id, scope, target, placed_at_utc) collisions are reported by
--     the readiness script under DUPLICATE_SEMANTIC and are not collapsed,
--     because collapsing them would erase who placed which hold and when.
--
-- 10. RELEASE REQUIRING APPROVAL
--     Converted ACTIVE rows inherit the workspace's current
--     `require_legal_hold_release_approval` policy: the flag is captured ON
--     the row (release_approval_required) with release_approval_state
--     'PENDING', so a later policy relaxation cannot retroactively unlock a
--     hold. Already-released rows are recorded as NOT_REQUIRED — the release
--     already happened and must not be retro-gated.
--
-- ---------------------------------------------------------------------------
-- ROW-COUNT EQUIVALENCE
--
--   canonical_after = canonical_before
--                   + (case_legal_holds convertible)
--                   + (legal_holds convertible)
--
-- where "convertible" excludes (a) rows already converted in a previous run,
-- (b) cross-workspace refusals, and (c) rows whose placing user no longer
-- exists. (c) cannot be inserted because placed_by_user_id is a NOT NULL FK
-- to users, and inventing an actor would falsify custody attribution. Those
-- rows are LEFT IN PLACE in their legacy table — nothing is dropped, the
-- evaluator still reads the legacy tables, and the residual is visible as the
-- difference between each store's `total` and the matching
-- `convergedFrom*Store` count in the readiness report. The legacy-removal
-- migration must not run while that residual is non-zero.
--
-- SEMANTIC EQUIVALENCE
--
--   The readiness report's `protectedEvidenceCount` — the number of evidence
--   rows reachable by ANY active hold in ANY store — must be identical before
--   and after this migration, and identical after a second (no-op) run. It
--   can never decrease. Its query deliberately unions all three stores, so it
--   measures protection, not bookkeeping.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. case_legal_holds → canonical (scope = CASE)
-- ----------------------------------------------------------------------------

INSERT INTO "evidence_legal_holds" (
  "team_id", "scope", "evidence_id", "case_id", "organization_id",
  "title", "reason", "status",
  "placed_by_user_id", "placed_at_utc",
  "released_by_user_id", "released_at_utc", "release_note",
  "expires_at_utc",
  "release_approval_required", "release_approval_state",
  "policy_version_attribution", "version",
  "source_store", "source_row_id", "historical",
  "created_at", "updated_at"
)
SELECT
  h."team_id",
  'CASE'::"LegalHoldScope",
  NULL,
  -- ORPHAN: target case gone → NULL target + historical=true (case 7).
  CASE WHEN c."id" IS NULL THEN NULL ELSE h."case_id" END,
  t."organization_id",
  left(h."title", 180),
  left(coalesce(h."reason", ''), 4000),
  h."status"::text::"LegalHoldStatus",
  h."placed_by_user_id",
  h."placed_at_utc",
  h."released_by_user_id",
  h."released_at_utc",
  h."release_note",
  NULL,
  -- Case 10 — capture the approval gate on ACTIVE rows only.
  (h."status"::text = 'ACTIVE' AND coalesce(p."require_legal_hold_release_approval", false)),
  CASE
    WHEN h."status"::text = 'ACTIVE' AND coalesce(p."require_legal_hold_release_approval", false)
      THEN 'PENDING'::"LegalHoldReleaseApprovalState"
    ELSE 'NOT_REQUIRED'::"LegalHoldReleaseApprovalState"
  END,
  'backfill:case_legal_holds',
  1,
  'CASE_LEGAL_HOLD'::"LegalHoldSourceStore",
  h."id",
  (c."id" IS NULL),
  now(),
  now()
FROM "case_legal_holds" h
LEFT JOIN "cases" c ON c."id" = h."case_id"
LEFT JOIN "teams" t ON t."id" = h."team_id"
LEFT JOIN "workspace_governance_policies" p ON p."team_id" = h."team_id"
WHERE
  -- Case 8 — REFUSE cross-workspace. Never merged, never rewritten.
  (c."id" IS NULL OR c."team_id" IS NOT DISTINCT FROM h."team_id")
  -- placed_by_user_id is a NOT NULL FK; an unresolvable actor is left in
  -- place rather than attributed to someone who did not place the hold.
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = h."placed_by_user_id")
  AND EXISTS (SELECT 1 FROM "teams" tt WHERE tt."id" = h."team_id")
  -- Idempotency (deterministic key).
  AND NOT EXISTS (
    SELECT 1 FROM "evidence_legal_holds" x
    WHERE x."source_store" = 'CASE_LEGAL_HOLD'::"LegalHoldSourceStore"
      AND x."source_row_id" = h."id"
  );

-- ----------------------------------------------------------------------------
-- 2. legal_holds → canonical (scope = EVIDENCE | CASE | WORKSPACE)
-- ----------------------------------------------------------------------------

INSERT INTO "evidence_legal_holds" (
  "team_id", "scope", "evidence_id", "case_id", "organization_id",
  "title", "reason", "status",
  "placed_by_user_id", "placed_at_utc",
  "released_by_user_id", "released_at_utc", "release_note",
  "expires_at_utc",
  "release_approval_required", "release_approval_state",
  "policy_version_attribution", "version",
  "source_store", "source_row_id", "historical",
  "created_at", "updated_at"
)
SELECT
  h."team_id",
  CASE
    WHEN h."kind" = 'EVIDENCE' THEN 'EVIDENCE'::"LegalHoldScope"
    WHEN h."kind" = 'CASE'     THEN 'CASE'::"LegalHoldScope"
    ELSE 'WORKSPACE'::"LegalHoldScope"
  END,
  CASE WHEN h."kind" = 'EVIDENCE' THEN e."id" ELSE NULL END,
  CASE WHEN h."kind" = 'CASE'     THEN c."id" ELSE NULL END,
  t."organization_id",
  left(h."name", 180),
  left(h."reason", 4000),
  -- Case 4 — states round-trip; anything unrecognised becomes ACTIVE
  -- (most protective), never RELEASED.
  CASE
    WHEN h."state" = 'RELEASED' THEN 'RELEASED'::"LegalHoldStatus"
    WHEN h."state" = 'EXPIRED'  THEN 'EXPIRED'::"LegalHoldStatus"
    ELSE 'ACTIVE'::"LegalHoldStatus"
  END,
  h."created_by_user_id",
  h."created_at",
  h."released_by_user_id",
  h."released_at_utc",
  NULL,
  h."expires_at_utc",
  (h."state" = 'ACTIVE' AND coalesce(p."require_legal_hold_release_approval", false)),
  CASE
    WHEN h."state" = 'ACTIVE' AND coalesce(p."require_legal_hold_release_approval", false)
      THEN 'PENDING'::"LegalHoldReleaseApprovalState"
    ELSE 'NOT_REQUIRED'::"LegalHoldReleaseApprovalState"
  END,
  'backfill:legal_holds',
  1,
  'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore",
  h."id",
  -- Case 7 — ORPHAN: a scoped hold whose target row is gone is preserved
  -- as HISTORICAL. WORKSPACE/ORGANIZATION holds have no row target and are
  -- therefore never historical.
  (
    (h."kind" = 'EVIDENCE' AND e."id" IS NULL)
    OR (h."kind" = 'CASE' AND c."id" IS NULL)
  ),
  now(),
  now()
FROM "legal_holds" h
LEFT JOIN "evidence" e
  ON h."kind" = 'EVIDENCE' AND e."id" = h."scope_target_id"
LEFT JOIN "cases" c
  ON h."kind" = 'CASE' AND c."id" = h."scope_target_id"
LEFT JOIN "teams" t ON t."id" = h."team_id"
LEFT JOIN "workspace_governance_policies" p ON p."team_id" = h."team_id"
WHERE
  -- Case 8 — REFUSE cross-workspace on either target shape.
  (h."kind" <> 'EVIDENCE' OR e."id" IS NULL OR e."team_id" IS NOT DISTINCT FROM h."team_id")
  AND (h."kind" <> 'CASE' OR c."id" IS NULL OR c."team_id" IS NOT DISTINCT FROM h."team_id")
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = h."created_by_user_id")
  AND EXISTS (SELECT 1 FROM "teams" tt WHERE tt."id" = h."team_id")
  AND NOT EXISTS (
    SELECT 1 FROM "evidence_legal_holds" x
    WHERE x."source_store" = 'LIFECYCLE_LEGAL_HOLD'::"LegalHoldSourceStore"
      AND x."source_row_id" = h."id"
  );

-- ----------------------------------------------------------------------------
-- 3. Post-conditions. These RAISE rather than mutate: this migration must
--    fail loudly if it ever produced a shape the evaluator cannot honour.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  bad_scope_target int;
  bad_active_orphan int;
  bad_org_binding int;
  unresolved_active int;
BEGIN
  -- Every non-historical row must satisfy the scope/target contract.
  SELECT count(*) INTO bad_scope_target
  FROM "evidence_legal_holds"
  WHERE "historical" = false
    AND NOT (
      ("scope" = 'EVIDENCE'  AND "evidence_id" IS NOT NULL)
      OR ("scope" = 'CASE'      AND "case_id" IS NOT NULL AND "evidence_id" IS NULL)
      OR ("scope" = 'WORKSPACE' AND "evidence_id" IS NULL AND "case_id" IS NULL)
    );
  IF bad_scope_target > 0 THEN
    RAISE EXCEPTION 'legal-hold backfill produced % rows violating the scope/target contract', bad_scope_target;
  END IF;

  -- A historical row is the CHECK-exempt shape, so it must genuinely have no
  -- resolvable target — otherwise it would be exempt from the contract while
  -- still claiming a target.
  SELECT count(*) INTO bad_active_orphan
  FROM "evidence_legal_holds"
  WHERE "historical" = true AND ("evidence_id" IS NOT NULL OR "case_id" IS NOT NULL);
  IF bad_active_orphan > 0 THEN
    RAISE EXCEPTION 'legal-hold backfill produced % historical rows retaining a live target', bad_active_orphan;
  END IF;

  -- ORGANIZATION BINDING must agree with the owning workspace. A hold bound to
  -- another tenant's organization is a tenant-isolation defect; fail loudly
  -- rather than leave it to be discovered later.
  SELECT count(*) INTO bad_org_binding
  FROM "evidence_legal_holds" h
  JOIN "teams" t ON t."id" = h."team_id"
  WHERE h."organization_id" IS NOT NULL
    AND h."organization_id" IS DISTINCT FROM t."organization_id";
  IF bad_org_binding > 0 THEN
    RAISE EXCEPTION 'legal-hold backfill produced % row(s) whose organization_id disagrees with the owning workspace', bad_org_binding;
  END IF;

  SELECT count(*) INTO unresolved_active
  FROM "evidence_legal_holds"
  WHERE "historical" = true AND "status" = 'ACTIVE';
  IF unresolved_active > 0 THEN
    RAISE NOTICE 'legal-hold backfill: % ACTIVE orphaned hold(s) preserved as HISTORICAL. Each BLOCKS its entire workspace (fail closed) until an operator resolves it. See UNRESOLVED_ACTIVE_HOLD in legal-hold-convergence-report.mjs.', unresolved_active;
  END IF;

  RAISE NOTICE 'legal-hold backfill complete. Re-run scripts/legal-hold-convergence-report.mjs and confirm protectedEvidenceCount did not decrease.';
END
$$;
