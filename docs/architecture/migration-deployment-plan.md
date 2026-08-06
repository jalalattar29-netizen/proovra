# Migration Deployment Plan — PHASE 12 POINT 6

**Nothing in this plan has been applied to production.** The agent inventoried,
classified, rehearsed and validated the migration set; the owner executes it.
The step-by-step command sequence lives in
[`docs/operations/point6-migration-runbook.md`](../operations/point6-migration-runbook.md).

The machine-readable authority is
[`docs/architecture/migration-inventory-p6.json`](./migration-inventory-p6.json)
(one record per migration directory, regenerated from disk by
`pnpm --filter proovra-api db:migration-inventory:write`). The authored
dispositions it merges are in `migration-inventory-p6.curation.json`. This
document is the human-readable projection of the same data and must not
disagree with it — `services/api/test/phase-12-point6-migration-closure.test.ts`
fails if a pending migration is missing from this file.

Supersedes the 2026-07-27 plan of the same name, and supersedes the MIGRATION
half of `schema-migration-classification.json` (its MODEL half is still
authoritative).

---

## 1. Inventory summary

| | count |
|---|---|
| migration directories on disk | **221** |
| classified | **221** (UnclassifiedMigrations = 0) |
| BASELINE | 1 |
| HISTORICAL_PRESERVE | 184 |
| EXPAND | 15 |
| REPAIR | 3 |
| BACKFILL | 12 |
| CONTRACT_DROP | 6 |
| CUTOVER (SQL) | 0 — cutover is a *runtime* step, not a migration |

Conservation, machine-checked on every run:

```text
FilesystemMigrations (221)
= ClassifiedMigrations (221)
= AppliedInProduction (0) + PendingInProduction (0) + ProductionSnapshotUnknown (221)
```

`ProductionSnapshotUnknown = 221` because **no production database was
contacted**. `P6_PRODUCTION_READONLY_DATABASE_URL` is not configured in this
environment, and the collector deliberately refuses to fall back to
`DATABASE_URL`, `DIRECT_URL` or `SHADOW_DATABASE_URL`. See §7.

---

## 2. Release A — prerequisites and Expand/Repair · `SAFE_TO_APPLY_NOW`

18 migrations. **No destructive statement. No pre-existing row is mutated.**
Every one is backward-compatible with the currently deployed build.

| migration | class | safe before code deploy |
|---|---|---|
| `20270920000000_account_closure_requests` | EXPAND | yes |
| `20270920100000_org_invite_workspace_assignments` | EXPAND | yes |
| `20270920200000_membership_grant_provenance` | EXPAND | yes |
| `20270921000000_organization_closure_requests` | EXPAND | yes |
| `20270922000000_workspace_closure_requests` | EXPAND | yes |
| `20270925000000_user_identity_mode` | EXPAND | yes |
| `20271001000000_org_security_policy_phase10` | EXPAND | yes |
| `20271002000000_managed_identity_ownership` | EXPAND | yes |
| `20271004000000_authenticated_session_org_context` | EXPAND | yes |
| `20271006000000_org_security_policy_lifecycle` | EXPAND | yes |
| `20271101000000_audit_tenant_columns` | EXPAND | yes |
| `20271102000000_uuid_id_default_repair` | REPAIR | yes |
| `20271106000000_legal_hold_canonical` | EXPAND | yes |
| `20271111000000_step_up_session_organization_binding` | EXPAND | yes |
| `20271112000000_point4_write_unblock_repair` | REPAIR | yes — **fixes a LIVE production write failure** |
| `20271113000000_point5_report_generation_authority` | EXPAND | yes |
| `20271114000000_point5_media_intelligence_kind_catalog` | REPAIR | yes |
| `20271119000000_search_document_embedding_after_extension` | EXPAND | yes — idempotent; a no-op wherever the objects already exist |
| `email_password_auth` | EXPAND | yes — proven byte-identical no-op twin |

Prerequisites: a restorable backup/checkpoint; `CREATE EXTENSION IF NOT EXISTS
vector`; PostgreSQL ≥ 13 for `gen_random_uuid()` — the uuid repair RAISEs rather
than skipping if it is unavailable.

**PHASE 12 POINT 8 — pgvector is now a hard Release-A prerequisite, not a
"before the embedding chain is exercised" one.**
`20271119000000_search_document_embedding_after_extension` RAISEs if the
extension is absent. That is deliberate. The migration it repairs,
`20260620100000_phase24_31_consolidated_drift_patches`, creates
`evidence_search_documents.embedding` and its IVFFLAT index inside
`IF has_pgvector … ELSE RAISE NOTICE 'skipped'`, and `CREATE EXTENSION vector`
is not issued until `20270701000000_phase15_semantic_search` — a year later in
lexical order. On every database built from this chain the guard is false when
evaluated, both objects are silently skipped, and the datamodel goes on
declaring a column that does not exist. It was found by applying the release
artifact to an empty PostgreSQL 16 + pgvector and running
`db:raw-schema-verify`, and it survived a year of CI because the
reproducibility job ran on `postgres:16-alpine`, where the extension install
fails silently and every extension-conditional check is vacuous. Silence is
what hid it, so the repair fails loudly instead.

Stop conditions: any `FAILED` row in `_prisma_migrations`; the uuid repair
raising `incompatible id default`; `20271005000000`'s consistency probe raising
on conflicting duplicate policies (that one is Release B).

### Why `20271112000000_point4_write_unblock_repair` is in Release A

Three `create()` paths fail outright on any database carrying the full
migration history — `crossOrgReviewGrant`, `delegatedAdminGrant` and
`redactionPolicyAssignment` — because a catch-up migration added a second
physical column beside each `@map`-ed original, three of them `NOT NULL` with
no default, and Prisma never sends them. The original fix was a column DROP,
which cannot ship in the first wave. Point 6 split it: Release A relaxes the
`NOT NULL` (non-destructive, unblocks the writes immediately), Release D drops
the columns.

---

## 3. Release B — Backfill and readiness · `WAIT_FOR_BACKFILL_READINESS`

12 migrations. Each mutates rows; none drops anything.

| migration | readiness command | blocking categories |
|---|---|---|
| `20270920000000_workspace_kind_discriminator` | `db:check-org-consistency` | `workspace_kind`/`org_kind` NULL |
| `20270920250000_membership_grant_legacy_backfill` | `check-org-consistency.mjs --membership-grants` | membership with no grant row |
| `20270920300000_enterprise_contract_state` | `db:check-org-consistency` | `contract_state` NULL |
| `20270923000000_notification_schedule_timezone_inherit` | `not-null-readiness.mjs` | unresolved schedule timezone |
| `20271003000000_managed_identity_ownership_backfill` | `check-org-consistency.mjs --managed-identity` | zero-owner, multi-owner |
| `20271005000000_org_security_policy_org_scoped` | `db:check-org-consistency` | conflicting duplicate policies |
| `20271103000000_case_evidence_link_canonical` | `backfill-case-evidence-links.mjs --check` | see Case–Evidence set below |
| `20271104000000_case_evidence_link_integrity` | `backfill-case-evidence-links.mjs --check` | orphan link → Case / → Evidence |
| `20271107000000_legal_hold_backfill` | `legal-hold-convergence-report.mjs` | see Legal-Hold set below |
| `20271109000000_workspace_governance_policy_version` | `not-null-readiness.mjs` | `version IS NULL` |
| `20271110000000_exchange_download_authorization_semantics` | `not-null-readiness.mjs` | rows asserting a confirmed download from an authorisation timestamp |
| `20271115000000_point5_atomic_sweep_claims` | `point5-vector-readiness.mjs --sweep-claims` | duplicate RUNNING run / non-terminal execution / active review / in-flight transition |

**Case–Evidence blocking set** (all must be 0 before Release D):
`missingLinks`, `conflictingLinks` (advisory), `orphanCasePointers`,
`crossWorkspaceLinks`, `duplicateLinks`, `orphanLinks`, plus "legacy pointer not
represented canonically" and "unexpected source residue" — the check reports
`dropReady: true` only when every blocking count is zero.

**Legal-Hold blocking set** (all must be 0 before Release D):
`crossWorkspace`, `orgBindingMismatch`, `unconvertedSourceRows`,
`duplicateSourceMapping`, `unresolvedActiveHolds`, `releaseStateMismatch`,
`invalidTarget`. `EVIDENCE_WITH_CASE_TAG` additionally gates
`20271118000000` only.

**`20271110000000` is the one migration that is NOT safe before code
deployment.** The previous build still writes `downloaded_at_utc` at
authorisation time, so between Release B and the Release-C cutover it can
re-conflate the two columns. The migration is idempotent — re-run it after
cutover to re-separate them.

**Release B must not contain a CONTRACT/DROP migration.** Enforced by the
inventory gate.

---

## 4. Release C — Runtime cutover · `WAIT_FOR_RUNTIME_CUTOVER`

No migrations. Deploy the API, worker and web build that reads and writes the
canonical schema:

* every case↔evidence association resolves through `CaseEvidenceLink`
  (`Evidence.caseId` has **zero** runtime readers and writers — the scalar is
  gone from `schema.prisma` and the resurrection guard in
  `services/api/test/phase-12b-case-evidence-authority.test.ts` keeps it gone);
* every legal-hold read and write goes through `evidence_legal_holds`
  (`prisma.evidenceLegalHold`); the legacy stores have zero Prisma delegates
  and zero raw-SQL readers outside
  `scripts/legal-hold-convergence-report.mjs`, which is the readiness tool and
  must keep reading them until Release D;
* the canonical placement command writes `case_id = NULL` for `scope = EVIDENCE`.

Startup order: **API first, then worker.** Both tolerate the expanded
pre-contract schema (proven — see §6). Queues drain against the same schema in
both directions, so no queue pause is required.

Health checks: the API's own startup validator must log
`runtime.schema_validation.healthy`.

Rollback: redeploy the previous build. Every Release-A/B migration is additive,
defaulted or idempotent, so the previous build keeps working; nothing needs to
be un-migrated.

---

## 5. Observation window · `WAIT_FOR_OBSERVATION_WINDOW`

Minimum evidence before Release D:

1. `backfill-case-evidence-links.mjs --check` → `dropReady: true`, every
   blocking count 0, on two runs at least 24h apart.
2. `legal-hold-convergence-report.mjs` → `BLOCKING total: 0`, and
   `protectedEvidenceCount` **not lower** than the pre-backfill run.
3. Zero application errors referencing `case_id` on `evidence`, or either
   legacy hold store.
4. `pnpm --filter proovra-api db:raw-schema-verify` → OK, 0 unregistered
   divergences.
5. `runtime.schema_validation.healthy` sustained across the window.

---

## 6. Release D — Contract/Drop · `CONTRACT_DROP_LATER`

6 migrations. **These files must not be present in the deployment artifact for
Release A, B or C** — every one of them RAISEs when its readiness is not zero,
and a raise inside `prisma migrate deploy` leaves a FAILED row that blocks all
subsequent migrations. Stage them into the artifact only for Release D.

| migration | removes | removal condition |
|---|---|---|
| `20270923500000_persona_profiles_removal_precondition` | nothing (guard only) | always runs; RAISEs if any FK or view still depends on `workspace_persona_profiles` |
| `20270924000000_drop_workspace_persona_profiles` | `workspace_persona_profiles` | zero runtime readers (feature deleted 2026-07-20) + the preceding guard passing |
| `20271105000000_evidence_case_id_removal` | `evidence.case_id` | 5 in-database counts at zero + both `case_evidence_links` FKs VALIDATED |
| `20271108000000_legal_hold_legacy_removal` | `case_legal_holds`, `legal_holds`, `CaseLegalHoldStatus` | 6 in-database counts at zero + canonical columns + idempotency index present |
| `20271117000000_point4_schema_authority_contract` | 5 duplicate columns, 3 superseded singular audit tables | zero divergent non-null duplicates, zero rows in the singular tables |
| `20271118000000_legal_hold_strict_scope_target` | nothing (tightens a CHECK) | `EVIDENCE_WITH_CASE_TAG = 0` |

Adapter removal condition: `docs/architecture/compatibility-adapter-registry.json`
entries bound to `20271105000000_evidence_case_id_removal` and
`20271117000000_point4_schema_authority_contract` become inert once those
migrations are applied and may then be deleted.

Failure stop conditions: any RAISE aborts the release. The correct response is
to resolve the named rows and re-run — **never** `prisma migrate resolve` to
skip a contract migration, and never weaken a guard to make it pass.

---

## 7. Production state — the one open blocker

```text
AWAITING_OWNER_PRODUCTION_MIGRATION_SNAPSHOT
```

No production database was read. To close it:

```bash
P6_PRODUCTION_READONLY_DATABASE_URL="postgresql://<readonly-user>:<pw>@<host>/<db>?sslmode=require" node services/api/scripts/p6-production-migration-snapshot.mjs --out p6-production-snapshot.json
```

then

```bash
node services/api/scripts/migration-production-reconcile.mjs p6-production-snapshot.json --write
```

The reconciler dispositions all twelve required divergence classes and exits
non-zero unless `AppliedMigrationChecksumConflicts`,
`RenamedAppliedMigrationConflicts`, `ProductionOnlyMigrationUnknowns`,
`FailedOrIncompleteProductionMigrations` and `MigrationInventoryDuplicates` are
all zero. The whole collector → snapshot → reconcile path was executed against a
live PostgreSQL 16 in the rehearsal and returned all-zero with conservation
holding.

**Line-ending hazard, recorded because it is a real P3006 source:** Prisma
stores `sha256` over the *raw* `migration.sql` bytes (proven — 221/221 rows
matched the raw digest, 0 matched the LF-normalised one). This repository has no
`.gitattributes` and `core.autocrlf=true` locally, so a Windows checkout and a
Linux checkout produce different digests for identical SQL. Deploy from a
consistent (Linux/LF) checkout. The reconciler accepts either basis so it never
reports a phantom conflict.

---

## 8. Rehearsal evidence

**Empty PostgreSQL 16.14 + pgvector 0.8.6** — full chain from an empty
database: **221 applied / 0 failed / 0 rolled back**. Final schema is the
post-contract shape (`evidence.case_id`, `case_legal_holds`, `legal_holds`,
`workspace_persona_profiles`, the 5 duplicate columns and the 3 singular audit
tables all absent; 276 tables). `prisma validate` + `generate` clean;
`db:raw-schema-verify` → **864 registered objects verified, 0 unregistered
divergences, 0 objects proposed for removal**; second `migrate deploy` →
"No pending migrations" with a byte-identical `_prisma_migrations` fingerprint.

**pgvector** — with the extension: all 7 readiness checks pass. On a plain
`postgres:16` server without it: exit **20**, `vector_extension_missing`. Fails
closed.

**Production-like history rehearsal** — second disposable PostgreSQL 16:
185-migration historical baseline, then synthetic production-like fixtures
(canonical-only, legacy-only, agreeing, conflicting, orphan, cross-workspace,
duplicate, personal-workspace, active/released/historical holds, audit
V1/V2/V3, explicit UUIDs, step-up rows, exchange download history, Point-5
duplicate authority rows), then the exact release sequence:

* **Release A** — 18 applied, **zero row-count change** on every authority;
  relaxed scope/target CHECK installed; `gen_random_uuid()` defaults added with
  every pre-existing id byte-identical; audit tenant columns nullable with **5
  unresolved scopes preserved and 0 scopes guessed**.
* **Release B** — links 6 → 9 (only resolvable pointers converted, **0 orphan
  links created**), conflicting association preserved as *two* links (nothing
  discarded), personal-workspace link written with `team_id NULL`, canonical
  holds 2 → 12, cross-workspace holds **refused** and left in place, unknown
  legacy state mapped to ACTIVE (never RELEASED), orphan preserved as
  `historical=true` and failing closed, exchange authorisation timestamps moved
  with **0 confirmed downloads fabricated**, all 4 Point-5 duplicate classes
  resolved forward with **nothing deleted** and 4 partial unique indexes built.
* **Resumability** — 2 converted hold rows deleted, backfill re-run: exactly
  those 2 restored plus 3 newly-resolvable ones, **0 duplicate mappings**.
* **Negative scenarios** — contract before backfill: refused (both);
  contract with unresolved conflicts: refused with the exact counts;
  strict-CHECK tightening with a tag still present: refused, tag preserved;
  after each refusal the before/after count fingerprint was **identical**
  (`ContractFailureDataLoss = 0`).
* **Release C** — the API's own startup validator on the pre-contract expanded
  schema: `runtime.schema_validation.healthy`, 111 targets checked, canonical
  reads working.
* **Release D** — all 6 applied after legitimate operator resolution; final
  shape post-contract; **audit hash chain byte-identical before and after**;
  every canonical row preserved (12 holds, 7 links, 9 evidence, 5 audit rows,
  2 device rows with unchanged ids).
* **Post-contract** — API validator `healthy` with identical canonical reads;
  worker boots and reads every canonical authority; second `migrate deploy` →
  no pending migrations, no state mutation.

### Defects the rehearsal found and fixed

1. **`20271106000000_legal_hold_canonical` would have broken legal-hold
   placement in production.** It measured the table and installed the STRICT
   `EVIDENCE ⇒ case_id IS NULL` CHECK whenever it happened to find zero tagged
   rows — but it runs *before* the cutover, and the deployed build passes
   `caseId` straight into an EVIDENCE-scoped create. Proven by counterfactual on
   a clean Release-A database: the shipped relaxed CHECK accepts that write; the
   strict form rejects it. The tightening moved to `20271118000000` (Release D).
2. **`20271103000000_case_evidence_link_canonical` manufactured orphan links.**
   Its backfill had no `JOIN cases`, so a legacy pointer at a deleted Case became
   a canonical link row pointing at nothing — and the very next migration, which
   adds the real foreign key, then refused *forever*. One dangling pointer
   blocked Release B outright in the rehearsal. Fixed with the join; the
   dangling pointer now surfaces as `orphan_case_pointer` in the Release-D guard.
3. **`20271117000000`'s divergence guard was permanently self-blocking.** It
   tested `duplicate IS DISTINCT FROM canonical`, which counts every healthy row
   (duplicate NULL, canonical populated) as divergence — including every row
   written after the Release-A repair. Now NULL-tolerant.
4. **`20271108000000` produced an unbounded error on a partially-removed
   database.** Each per-store probe is now conditional on that store existing.
5. **`20270924000000_drop_workspace_persona_profiles` had an unguarded
   `DROP ... CASCADE`.** Its bytes are frozen (tracked in git), so the guard was
   added as the preceding migration `20270923500000`, which refuses when any FK
   or view still depends on the table.
6. **`20271104000000_evidence_case_id_removal` mixed a BACKFILL, an FK
   expansion and a CONTRACT drop in one file**, forcing either late foreign keys
   or an early column drop. Split into `20271104000000_case_evidence_link_integrity`
   (Release B) and `20271105000000_evidence_case_id_removal` (Release D).

### Observations recorded, not "fixed"

* `case_legal_holds.case_id` carries `ON DELETE CASCADE`, so deleting a Case
  silently destroys its preservation controls, and an orphaned case-scoped hold
  is structurally impossible. The canonical model corrects this with
  `ON DELETE RESTRICT`.
* `case_legal_holds` has no FK on `placed_by_user_id`, so a hold whose placing
  user is gone IS representable; the backfill leaves it in place rather than
  attributing it to someone else, and it shows up as unconverted source rows.
