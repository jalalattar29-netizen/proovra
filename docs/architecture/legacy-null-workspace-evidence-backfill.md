# Legacy `evidence.team_id IS NULL` — population, and the operator-gated backfill design

**Status:** DESIGN ONLY. No migration authored, nothing applied, no Production mutation.
**Raised by:** P2-1, `docs/admin/audits/FINAL_COMMERCIAL_OUTPUT_VERIFY_EXPERIENCE_AUDIT.md`
**Closed in code by:** the `WORKSPACE_UNRESOLVED` outcome + action withdrawal (2026-09-10). The
product no longer offers an action it cannot honour. This document covers the *remaining* work,
which is data repair and is deliberately not part of that change.

---

## 1. Why the rows exist

`Evidence.team_id` is nullable. Before Phase HOME-DATA-OWNERSHIP, a personal capture wrote
`team_id = NULL` and carried its ownership solely in `owner_user_id`. Every read path that must
include those rows does so through one predicate — `evidenceScopeFor` in
`packages/shared-runtime/src/workspace-scope.ts`, whose owner-scoped arm is exactly:

```
OR: [ { teamId: <workspace> }, { AND: [ { ownerUserId: <owner> }, { teamId: null } ] } ]
```

So the rows are visible, listable, openable and downloadable. What they cannot do is carry a
`ReportGenerationRequest`: that row has a non-null `team_id`, and
`createReportGenerationRequest` refuses to mint one it cannot scope
(`reason: "evidence_workspace_unresolved"`). A request that cannot be scoped must not exist —
that refusal is correct and is not what this document proposes changing.

## 2. New rows cannot join the population

`createEvidence` (`services/api/src/services/evidence.service.ts`) resolves `effectiveTeamId`
before the insert — bootstrapping the owner's personal Team when the caller supplies none — and
writes it unconditionally:

```
// Phase HOME-DATA-OWNERSHIP — always the REAL resolved team id
// (personal Team row for personal captures, team workspace id for
// team captures). Never null.
teamId: effectiveTeamId,
```

The A1 migration additionally added a CHECK constraint rejecting
`team_id IS NOT NULL AND organization_id IS NULL`, so the pair is written together or not at all.

**The population is therefore closed.** It can shrink and it cannot grow.

## 3. The exact population query

Read-only. Safe to run against a read replica or a production snapshot.

```sql
-- Count, and the owners affected.
SELECT count(*) AS rows,
       count(DISTINCT owner_user_id) AS owners
  FROM evidence
 WHERE team_id IS NULL
   AND deleted_at IS NULL;

-- The rows that would actually benefit: finalized, no report yet, and an owner
-- who still has a personal workspace to bind them to.
SELECT e.id,
       e.owner_user_id,
       e.status,
       e.created_at,
       t.id AS candidate_team_id
  FROM evidence e
  JOIN teams t
    ON t.owner_user_id = e.owner_user_id
   AND t.is_personal = true
 WHERE e.team_id IS NULL
   AND e.deleted_at IS NULL
   AND e.status IN ('SIGNED', 'REPORTED')
   AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.evidence_id = e.id)
 ORDER BY e.created_at;

-- The rows a backfill must NOT touch: no personal workspace to bind to.
SELECT count(*)
  FROM evidence e
 WHERE e.team_id IS NULL
   AND e.deleted_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM teams t
          WHERE t.owner_user_id = e.owner_user_id
            AND t.is_personal = true);
```

## 4. Why this is not a migration

A `UPDATE evidence SET team_id = (...) WHERE team_id IS NULL` in a Prisma migration would be
wrong three times over:

1. **It changes tenancy.** `team_id` is the tenant predicate every scope resolution and every
   authorization check reads. Writing it is a governance act, not a schema change, and it must be
   audited per row rather than applied silently by `prisma migrate deploy`.
2. **It cannot fail closed.** An owner with no personal Team row — a managed identity whose
   personal space was removed by Organization policy, or a deleted user — has no correct value.
   A migration has no way to leave those rows alone and report them; a script does.
3. **`organization_id` travels with it.** The A1 CHECK constraint means the backfill must resolve
   the personal Team's organization too, and get it right for every row, or the statement aborts
   mid-way and takes the rest of the release with it.

## 5. The design, when it is scheduled

Shape it on `scripts/reconcile-ots-never-attempted.ts`, which is the existing precedent for an
operator-gated historical repair: a dry-run default, an explicit `--apply`, a bounded batch, a
per-row audit event, and a header stating it has not been run against Production.

- **Dry run by default.** Prints the counts in §3 and the first N candidate rows. No writes.
- **`--apply` plus an operator id.** Every row written emits a platform audit event
  (`evidence.workspace.backfilled`) carrying the old value (null), the new `team_id`, the resolved
  `organization_id`, and the operator. A tenancy write with no audit row is not acceptable.
- **Bounded batches, resumable.** `--limit`, ordered by `created_at`, idempotent: a row that
  already has a `team_id` is skipped, so a re-run after an interruption is safe.
- **Skips, reported not guessed.** A row whose owner has no personal Team is counted and listed,
  never assigned to a workspace the owner does not hold.
- **Writes `team_id` and `organization_id` together**, in one statement per row, so the CHECK
  constraint is satisfied at every commit point.
- **Touches nothing else.** No status change, no report request, no custody event, no storage
  write. Generation stays the customer's action, on the record's own page, afterwards.

## 6. Until then

The product is truthful without the backfill: the affected records list, open and download
normally, and their Generate control is withdrawn with the sentence
`WORKSPACE_UNRESOLVED` carries. Nothing dead-ends and nothing lies.
