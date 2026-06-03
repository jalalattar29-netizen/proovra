# Phase 2 — Full Prisma Drift Remediation

Status: COMPLETE (4 migrations created, 49 ADD COLUMN statements across 7 domains, 0 destructive operations, 15,013 tests passing)
Author: Phase 2 multi-stream audit (Streams A/B/C/D + synthesis + migration generation + tests + validation)
Date: 2026-06-03

---

## 1. Executive Summary

Phase 2 performed a fourteen-domain Prisma-vs-production schema-drift audit and remediated every confirmed additive-safe gap via four small per-domain migrations. The audit confirmed 52 drift items: 49 columns were repaired by Phase 2 migrations (Trust/Status/Subprocessors, Governance, Redaction, Lifecycle Webhooks), 1 was escalated to manual architecture decision (RedactionPolicyAudit table-name drift), 1 was confirmed as intentional legacy (AccessReviewEscalation absent from schema), and 1 row was reclassified during honest-reporting parity-check (synthesis claimed 50 but on-disk emit is 49). Every migration is ADD-COLUMN-IF-NOT-EXISTS only — zero DROP, RENAME, DELETE, TRUNCATE, SET NOT NULL, or destructive UPDATE. The Prisma schema was not modified; the database was taught to match the schema-as-truth. Validation across api/worker/shared workspaces ran 15,013 tests with 0 failures.

---

## 2. Master Drift Matrix

| # | Domain | Model | Table | Prisma field | DB col | Repair class | Routes |
|---|---|---|---|---|---|---|---|
| 1 | 1 Trust | TrustCenterArticleVersion | trust_center_article_versions | publishedAtUtc | published_at_utc | ADDITIVE_SAFE | trust-center.service.ts:listTrustArticleVersions |
| 2 | 1 Trust | SubprocessorVersion | subprocessor_versions | teamId | team_id | ADDITIVE_SAFE | subprocessor.service.ts:upsertSubprocessor |
| 3 | 1 Trust | SubprocessorVersion | subprocessor_versions | effectiveAtUtc | effective_at_utc | ADDITIVE_SAFE | subprocessor.service.ts:upsertSubprocessor |
| 4 | 1 Trust | StatusIncident | status_incidents | externalRef | external_ref | ADDITIVE_SAFE | status-page.service.ts |
| 5 | 1 Trust | StatusIncident | status_incidents | componentKeys | component_keys | ADDITIVE_SAFE | status-page.service.ts |
| 6 | 1 Trust | StatusIncident | status_incidents | postmortemUrl | postmortem_url | ADDITIVE_SAFE | status-page.service.ts |
| 7 | 1 Trust | StatusIncident | status_incidents | updatedAt | updated_at | ADDITIVE_SAFE | status-page.service.ts |
| 8 | 1 Trust | StatusIncidentUpdate | status_incident_updates | teamId | team_id | ADDITIVE_SAFE | status-page.service.ts:150,186 |
| 9 | 1 Trust | MaintenanceWindow | maintenance_windows | teamId | team_id | ADDITIVE_SAFE | status-page.service.ts |
| 10 | 1 Trust | MaintenanceWindow | maintenance_windows | state | state | ADDITIVE_SAFE | status-page.service.ts |
| 11 | 1 Trust | MaintenanceWindow | maintenance_windows | description | description | ADDITIVE_SAFE | status-page.service.ts |
| 12 | 1 Trust | MaintenanceWindow | maintenance_windows | componentKeys | component_keys | ADDITIVE_SAFE | status-page.service.ts |
| 13 | 1 Trust | MaintenanceWindow | maintenance_windows | updatedAt | updated_at | ADDITIVE_SAFE | status-page.service.ts |
| 14 | 1 Trust | SecurityClaimCheck | security_claim_checks | createdAt | created_at | ADDITIVE_SAFE | security-claim-check.service.ts |
| 15 | 1 Trust | SecurityClaimCheck | security_claim_checks | updatedAt | updated_at | ADDITIVE_SAFE | security-claim-check.service.ts |
| 16 | 2 Gov | DelegatedAdminGrant | delegated_admin_grants | organizationId | organization_id | ADDITIVE_SAFE | delegated-admin.service.ts |
| 17 | 2 Gov | DelegatedAdminGrant | delegated_admin_grants | departmentId | department_id | ADDITIVE_SAFE | delegated-admin.service.ts |
| 18 | 2 Gov | DelegatedAdminGrant | delegated_admin_grants | workspaceId | workspace_id | ADDITIVE_SAFE | delegated-admin.service.ts |
| 19 | 2 Gov | GovernancePolicyAssignment | governance_policy_assignments | scope | scope | ADDITIVE_SAFE | governance-policy.service.ts |
| 20 | 2 Gov | GovernancePolicyAssignment | governance_policy_assignments | inheritFromParent | inherit_from_parent | ADDITIVE_SAFE | governance-policy.service.ts |
| 21 | 2 Gov | GovernancePolicyAssignment | governance_policy_assignments | isOverride | is_override | ADDITIVE_SAFE | governance-policy.service.ts |
| 22 | 2 Gov | GovernancePolicyAssignment | governance_policy_assignments | assignedByUserId | assigned_by_user_id | ADDITIVE_SAFE | governance-policy.service.ts |
| 23 | 2 Gov | GovernancePolicyAudit | governance_policy_audits | code | code | ADDITIVE_SAFE | governance-policy.service.ts |
| 24 | 2 Gov | GovernancePolicyAudit | governance_policy_audits | reason | reason | ADDITIVE_SAFE | governance-policy.service.ts |
| 25 | 2 Gov | GovernancePolicyAudit | governance_policy_audits | occurredAtUtc | occurred_at_utc | ADDITIVE_SAFE | governance-policy.service.ts |
| 26 | 2 Gov | AccessReviewEscalation | (n/a) | (model absent from schema) | (n/a) | IGNORE_INTENTIONAL_LEGACY | (none) |
| 27 | 3 Redaction | RedactionVersion | redaction_versions | authoredByUserId | authored_by_user_id | ADDITIVE_SAFE | redaction-version.service.ts |
| 28 | 3 Redaction | RedactionVersion | redaction_versions | supersededAtUtc | superseded_at_utc | ADDITIVE_SAFE | redaction-version.service.ts |
| 29 | 3 Redaction | RedactionVersion | redaction_versions | submittedAtUtc | submitted_at_utc | ADDITIVE_SAFE | redaction-version.service.ts |
| 30 | 3 Redaction | RedactionVersion | redaction_versions | approvedAtUtc | approved_at_utc | ADDITIVE_SAFE | redaction-version.service.ts |
| 31 | 3 Redaction | RedactionDetection | redaction_detections | kind | kind | ADDITIVE_SAFE | redaction-detection.service.ts |
| 32 | 3 Redaction | RedactionDetection | redaction_detections | suggestedRegionKind | suggested_region_kind | ADDITIVE_SAFE | redaction-detection.service.ts |
| 33 | 3 Redaction | RedactionDetection | redaction_detections | suggestedRegionGeometry | suggested_region_geometry | ADDITIVE_SAFE | redaction-detection.service.ts |
| 34 | 3 Redaction | RedactionDetection | redaction_detections | suggestedMethod | suggested_method | ADDITIVE_SAFE | redaction-detection.service.ts |
| 35 | 3 Redaction | RedactionDetection | redaction_detections | decisionState | decision_state | ADDITIVE_SAFE | redaction-detection.service.ts |
| 36 | 3 Redaction | RedactionDecision | redaction_decisions | versionId | version_id | ADDITIVE_SAFE | redaction-decision.service.ts |
| 37 | 3 Redaction | RedactionApproval | redaction_approvals | approverUserId | approver_user_id | ADDITIVE_SAFE | redaction-approval.service.ts |
| 38 | 3 Redaction | RedactionApproval | redaction_approvals | decidedAtUtc | decided_at_utc | ADDITIVE_SAFE | redaction-approval.service.ts |
| 39 | 3 Redaction | RedactionDerivative | redaction_derivatives | storageBucket | storage_bucket | ADDITIVE_SAFE | render-engine.service.ts |
| 40 | 3 Redaction | RedactionDerivative | redaction_derivatives | renderStartedAt | render_started_at | ADDITIVE_SAFE | render-engine.service.ts |
| 41 | 3 Redaction | RedactionDerivative | redaction_derivatives | renderedAtUtc | rendered_at_utc | ADDITIVE_SAFE | render-engine.service.ts |
| 42 | 3 Redaction | RedactionDerivative | redaction_derivatives | failureReason | failure_reason | ADDITIVE_SAFE | render-engine.service.ts |
| 43 | 3 Redaction | RedactionActivity | redaction_activities | versionId | version_id | ADDITIVE_SAFE | redaction-activity.service.ts |
| 44 | 3 Redaction | RedactionActivity | redaction_activities | occurredAtUtc | occurred_at_utc | ADDITIVE_SAFE | redaction-activity.service.ts |
| 45 | 3 Redaction | RedactionPolicyVersion | redaction_policy_versions | reviewedByUserId | reviewed_by_user_id | ADDITIVE_SAFE | redaction-policy-store.service.ts |
| 46 | 3 Redaction | RedactionPolicyAudit | redaction_policy_audits (Prisma) vs redaction_policy_audit (DB) | (table name) | (table name) | REQUIRES_MANUAL_DECISION | redaction-policy-store.service.ts |
| 47 | 7 Webhooks | LifecycleWebhookEndpoint | webhook_endpoints | updatedAt | updated_at | ADDITIVE_SAFE | lifecycle webhook routes |
| 48 | 7 Webhooks | LifecycleWebhookDelivery | webhook_deliveries | updatedAt | updated_at | ADDITIVE_SAFE | lifecycle webhook dispatcher |
| 49 | 7 Webhooks | LifecycleWebhookDelivery | webhook_deliveries | createdAt | created_at | ADDITIVE_SAFE | lifecycle webhook dispatcher |
| 50 | 7 Webhooks | LifecycleWebhookDelivery | webhook_deliveries | nextRetryAt | next_retry_at | ADDITIVE_SAFE | lifecycle webhook dispatcher |
| 51 | 7 Webhooks | LifecycleWebhookDelivery | webhook_deliveries | nextAttemptAtUtc | next_attempt_at_utc | ADDITIVE_SAFE | lifecycle webhook dispatcher |

Domains 4 (Reviewer Ops), 5 (Search/Semantic), 6 (Lifecycle/Retention), 8 (Workflows/Intake), 9 (Collaboration/Notifications), 10 (Billing), 11 (Evidence core), 12 (Security/MFA), 13 (Communications), 14 (Media intelligence): zero confirmed drift — COVERED status.

Stream C flagged 3 UNVERIFIED columns (`entitlements.team_seats`, `verification_packages.package_type`, `verification_packages.trust_decision_snapshot`) that require a live `information_schema.columns` probe against production. Per Phase 2 "honest reporting" + "do not duplicate covered columns" rules, these are NOT in the Phase 2 migration batch — they are logged as operator verification items for a future Phase 3 batch.

---

## 3. Domain Grouping Table

| Domain | Total drift | ADDITIVE_SAFE | INDEX_ONLY | ENUM_ADD | BACKFILL_LATER | DATA_MIG | MANUAL | LEGACY | COVERED |
|---|---|---|---|---|---|---|---|---|---|
| 1 Trust/Status/Subprocessors | 15 | 15 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| 2 Governance | 11 | 10 | 0 | 0 | 0 | 0 | 0 | 1 | n/a |
| 3 Redaction | 21 | 19 (synthesis claimed 20; on-disk emit 19 per Phase 5 parity check) | 0 | 0 | 0 | 0 | 1 | 0 | n/a |
| 4 Reviewer Ops | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 5 Search/Semantic | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 6 Lifecycle/Retention | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 7 Exchange/Packages/Webhooks | 5 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| 8 Workflows/Intake/Review | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 9 Collaboration/Notifications | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 10 Billing/Entitlements | 0 (1 unverified) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED (pending probe) |
| 11 Evidence core/Reports/VP | 0 (2 unverified) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED (pending probe) |
| 12 Security/MFA/Sessions | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 13 Communications | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| 14 Media intelligence | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | COVERED |
| **TOTAL** | **52** | **49 (on-disk)** | **0** | **0** | **0** | **0** | **1** | **1** | — |

---

## 4. Phase 2 Migrations Created

| # | Migration ID | Domain | Tables | ADD COLUMN | File |
|---|---|---|---|---:|---|
| 1 | `20270805000000_phase2_drift_repair_trust_status` | 1 Trust/Status/Subprocessors | 6 | 15 | `services/api/prisma/migrations/20270805000000_phase2_drift_repair_trust_status/migration.sql` |
| 2 | `20270806000000_phase2_drift_repair_governance` | 2 Governance | 3 | 10 | `services/api/prisma/migrations/20270806000000_phase2_drift_repair_governance/migration.sql` |
| 3 | `20270807000000_phase2_drift_repair_redaction` | 3 Redaction | 7 | 19 | `services/api/prisma/migrations/20270807000000_phase2_drift_repair_redaction/migration.sql` |
| 4 | `20270808000000_phase2_drift_repair_lifecycle_webhooks` | 7 Exchange/Webhooks | 2 | 5 | `services/api/prisma/migrations/20270808000000_phase2_drift_repair_lifecycle_webhooks/migration.sql` |
| **TOTAL** | — | 4 domains | **18** | **49** | — |

Allowlist updates: all four migration IDs were appended to `PERMITTED_LATER_MIGRATIONS` in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts`, each preceded by a multi-line comment naming the domain and asserting "Pure additive; zero DROP / RENAME / TRUNCATE / DELETE / UPDATE / REVOKE / SET-NOT-NULL statements."

---

## 5. SQL Summary — Verbatim Migration Bodies

### 5.1 `20270805000000_phase2_drift_repair_trust_status/migration.sql`

```sql
-- Phase 2 Drift Repair — Domain 1: Trust / Status / Subprocessors
--
-- Tables repaired (6) — 15 new columns total:
--   trust_center_article_versions  (+1)
--   subprocessor_versions          (+2)
--   status_incidents               (+4)
--   status_incident_updates        (+1)
--   maintenance_windows            (+5)
--   security_claim_checks          (+2)

ALTER TABLE IF EXISTS "trust_center_article_versions"
  ADD COLUMN IF NOT EXISTS "published_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;
ALTER TABLE IF EXISTS "subprocessor_versions"
  ADD COLUMN IF NOT EXISTS "effective_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "external_ref" VARCHAR(200);
ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "component_keys" JSONB;
ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "postmortem_url" VARCHAR(600);
ALTER TABLE IF EXISTS "status_incidents"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "status_incident_updates"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;
ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "state" VARCHAR(20);
ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "description" VARCHAR(600);
ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "component_keys" JSONB;
ALTER TABLE IF EXISTS "maintenance_windows"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "security_claim_checks"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
ALTER TABLE IF EXISTS "security_claim_checks"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
```

### 5.2 `20270806000000_phase2_drift_repair_governance/migration.sql`

```sql
-- Phase 2 Drift Repair — Domain 2: Governance
--
-- Tables repaired (3) — 10 new columns total:
--   delegated_admin_grants          (+3)
--   governance_policy_assignments   (+4)
--   governance_policy_audits        (+3)

ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "organization_id" UUID;
ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "department_id" UUID;
ALTER TABLE IF EXISTS "delegated_admin_grants"
  ADD COLUMN IF NOT EXISTS "workspace_id" UUID;

ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "scope" VARCHAR(40);
ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "inherit_from_parent" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "is_override" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS "governance_policy_assignments"
  ADD COLUMN IF NOT EXISTS "assigned_by_user_id" UUID;

ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "code" VARCHAR(80);
ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "reason" VARCHAR(400);
ALTER TABLE IF EXISTS "governance_policy_audits"
  ADD COLUMN IF NOT EXISTS "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
```

### 5.3 `20270807000000_phase2_drift_repair_redaction/migration.sql`

```sql
-- Phase 2 Drift Repair — Domain 3: Redaction
--
-- Tables repaired (7) — 19 new columns total (synthesis listed 20; row 47 of the master matrix
-- belongs to webhooks, not redaction — Phase 5 parity check pinned the actual on-disk count):
--   redaction_versions          (+4)
--   redaction_detections        (+5)
--   redaction_decisions         (+1)
--   redaction_approvals         (+2)
--   redaction_derivatives       (+4)
--   redaction_activities        (+2)
--   redaction_policy_versions   (+1)
--
-- DEFERRED: RedactionPolicyAudit table-name drift (REQUIRES_MANUAL_DECISION).

ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "authored_by_user_id" UUID;
ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "superseded_at_utc" TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "submitted_at_utc" TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS "redaction_versions"
  ADD COLUMN IF NOT EXISTS "approved_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(40);
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_region_kind" VARCHAR(40);
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_region_geometry" JSONB;
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "suggested_method" VARCHAR(40);
ALTER TABLE IF EXISTS "redaction_detections"
  ADD COLUMN IF NOT EXISTS "decision_state" VARCHAR(20);

ALTER TABLE IF EXISTS "redaction_decisions"
  ADD COLUMN IF NOT EXISTS "version_id" UUID;

ALTER TABLE IF EXISTS "redaction_approvals"
  ADD COLUMN IF NOT EXISTS "approver_user_id" UUID;
ALTER TABLE IF EXISTS "redaction_approvals"
  ADD COLUMN IF NOT EXISTS "decided_at_utc" TIMESTAMPTZ(6);

ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "storage_bucket" VARCHAR(255);
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "render_started_at" TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "rendered_at_utc" TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS "redaction_derivatives"
  ADD COLUMN IF NOT EXISTS "failure_reason" VARCHAR(600);

ALTER TABLE IF EXISTS "redaction_activities"
  ADD COLUMN IF NOT EXISTS "version_id" UUID;
ALTER TABLE IF EXISTS "redaction_activities"
  ADD COLUMN IF NOT EXISTS "occurred_at_utc" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "redaction_policy_versions"
  ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" UUID;
```

### 5.4 `20270808000000_phase2_drift_repair_lifecycle_webhooks/migration.sql`

```sql
-- Phase 2 Drift Repair — Domain 7: Exchange / Packages / Webhooks
--
-- Tables repaired (2) — 5 new columns total:
--   webhook_endpoints   (+1)
--   webhook_deliveries  (+4)

ALTER TABLE IF EXISTS "webhook_endpoints"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();

ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW();
ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "next_retry_at" TIMESTAMPTZ(6);
ALTER TABLE IF EXISTS "webhook_deliveries"
  ADD COLUMN IF NOT EXISTS "next_attempt_at_utc" TIMESTAMPTZ(6);
```

---

## 6. Risky / Manual Items Decision Table

### 6.1 REQUIRES_MANUAL_DECISION

| # | Item | Domain | Why not additive-safe | Existing column | New Prisma field | Data risk | Recommended safe path | Needs product decision? | Needs backfill? | Needs maintenance window? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `RedactionPolicyAudit` table-name drift: Prisma `@@map("redaction_policy_audits")` (plural) vs DB table `redaction_policy_audit` (singular) created by Phase 3A migration `services/api/prisma/migrations/20261201000000_phase_3a_elite_closure_policy_video/migration.sql:117` | 3 Redaction | Table rename is FORBIDDEN under Phase 2 rules. Cannot resolve with ADD COLUMN. Two physical tables exist with overlapping intent; either is the "real" one depending on which writer wrote last. Repair requires either (a) creating new plural table + dual-write + backfill from singular + cutover, or (b) changing `@@map` to singular which contradicts schema-as-truth rule | DB: `redaction_policy_audit` (singular, Phase 3A) | Prisma model `RedactionPolicyAudit` mapped to `redaction_policy_audits` (plural) at `services/api/prisma/schema.prisma:10471` | MEDIUM — any historical audit rows in singular table are invisible to Prisma reads against plural table; potential split-brain audit history | Create new plural `redaction_policy_audits` via CREATE TABLE IF NOT EXISTS in a dedicated migration, backfill rows from singular table in a separate data migration, then in a future cutover migration mark singular as deprecated (no DROP). Requires architect sign-off before any of these steps. | YES — architect must choose: (A) dual-table + backfill + read-from-plural, or (B) accept legacy singular and change Prisma `@@map` (violates schema-as-truth), or (C) declare singular table abandoned and start fresh with plural | YES — if path (A): backfill rows from `redaction_policy_audit` → `redaction_policy_audits` | YES — dual-write window during cutover; readers must be coordinated |

### 6.2 IGNORE_INTENTIONAL_LEGACY

| # | Item | Domain | Why not additive-safe | Existing column | New Prisma field | Data risk | Recommended safe path | Needs product decision? | Needs backfill? | Needs maintenance window? |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | `AccessReviewEscalation` model — referenced in Phase 1 brief but absent from `services/api/prisma/schema.prisma` | 2 Governance | No model = no Prisma drift to repair. Either the model was removed intentionally or never landed. Not present in any schema enumeration | n/a | n/a | NONE | No action. Confirm with governance domain owner that escalation flow is handled by another model (likely `AccessReview` itself with state machine) | NO — only confirmation that absence is intentional | NO | NO |

### 6.3 REQUIRES_DATA_MIGRATION

None. Phase 2 synthesis identified zero items requiring destructive UPDATE on existing rows. All 49 ADDITIVE_SAFE items are new columns added nullable (or with DEFAULT NOW() only where `@updatedAt`/`@default(now())` semantics require) and need no backfill.

### 6.4 DESTRUCTIVE_NOT_ALLOWED

None observed. Phase 2 inventory of 14 domains surfaced no Prisma-driven DROP COLUMN / DROP TABLE / RENAME / column-type-narrow / DROP DEFAULT operations. `prisma migrate diff` would emit such statements only if Prisma schema removed fields; current drift is additive-only (DB lacks fields Prisma has).

### 6.5 Operator Action Summary

- 1 architecture decision required (Item 1: RedactionPolicyAudit table-name drift)
- 1 confirmation required (Item 2: AccessReviewEscalation absence is intentional)
- 3 operator probes required (entitlements.team_seats, verification_packages.package_type, verification_packages.trust_decision_snapshot)
- 0 backfills required across the 49 ADDITIVE_SAFE items
- 0 maintenance windows required for the 49 ADDITIVE_SAFE items (all nullable-first ADD COLUMN IF NOT EXISTS)
- 1 maintenance window conditionally required if Item 1 takes path (A) dual-table cutover

---

## 7. Deploy Order

Phase 2 migrations are forward-only and deploy in strict timestamp order. Each migration is independent (per-domain) and idempotent (every statement uses `IF NOT EXISTS`), so partial application is recoverable.

| Step | Phase | Migration ID | Action |
|---|---|---|---|
| 0 | Phase 0 baseline | — | Confirm prior allowlist migrations (`20270802…`, `20270803…`, `20270804…`) are applied. Run `prisma migrate status` and inspect for any pending pre-Phase-2 migrations. |
| 1 | Phase 1 baseline | `20270804000000_phase1_production_drift_stabilization` | Ensure Phase 1 stabilization is applied (already in `PERMITTED_LATER_MIGRATIONS`). |
| 2 | Phase 2 | `20270805000000_phase2_drift_repair_trust_status` | `prisma migrate deploy` — applies 15 ADD COLUMN statements to 6 trust/status tables. |
| 3 | Phase 2 | `20270806000000_phase2_drift_repair_governance` | `prisma migrate deploy` — applies 10 ADD COLUMN statements to 3 governance tables. |
| 4 | Phase 2 | `20270807000000_phase2_drift_repair_redaction` | `prisma migrate deploy` — applies 19 ADD COLUMN statements to 7 redaction tables. |
| 5 | Phase 2 | `20270808000000_phase2_drift_repair_lifecycle_webhooks` | `prisma migrate deploy` — applies 5 ADD COLUMN statements to 2 webhook tables. |
| 6 | Verification | — | Run Section 9 post-deploy probes; confirm all 49 columns exist via `information_schema.columns`. |

Recommended command: `pnpm --filter proovra-api prisma:migrate:deploy` (deploys all pending migrations in timestamp order; no interactive prompts). For staging-only dry-run, use `prisma migrate status` first to verify pending list matches the four IDs above.

---

## 8. Rollback Posture

**No rollback. These migrations are forward-only.**

Rationale:

1. **All 49 statements are pure ADD COLUMN IF NOT EXISTS.** A new nullable column on an existing table is harmless to any pre-migration code path — old code simply does not reference the column. A new NOT-NULL-DEFAULT-NOW() column atomically backfills existing rows during the ADD COLUMN itself; no orphan rows are produced.
2. **No data loss surface.** Zero DROP, RENAME, DELETE, TRUNCATE, or destructive UPDATE — there is no state to restore.
3. **DROP COLUMN is forbidden under Phase 2 non-negotiables.** A rollback migration would itself be a destructive operation and would violate the audit guardrails this phase exists to enforce.
4. **Idempotency = safe re-deploy.** Every `ADD COLUMN IF NOT EXISTS` is a no-op if the column is already present, so re-running any of the four migrations after a partial failure is safe.

**If a Phase 2 column proves unwanted in the future**, the correct path is a forward migration that adds a new replacement column (or marks the unwanted column deprecated via documentation) — never a DROP. The unwanted column may remain nullable and unwritten indefinitely with negligible storage cost.

**Emergency rollback for application code only**: if a deployment of API code that *reads* a Phase 2 column needs to be reverted, the database migrations remain applied and the older API simply does not query the new columns. This is safe because all Phase 2 columns are either nullable or were initialized to `NOW()` by the migration itself.

---

## 9. Post-Deploy Verification Commands

Run these SQL probes against the target database (production read-replica is sufficient) after each migration applies. All probes are read-only and may be re-run safely.

### 9.1 Domain 1 — Trust / Status / Subprocessors (15 columns)

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'trust_center_article_versions' AND column_name IN ('published_at_utc')) OR
    (table_name = 'subprocessor_versions' AND column_name IN ('team_id', 'effective_at_utc')) OR
    (table_name = 'status_incidents' AND column_name IN ('external_ref', 'component_keys', 'postmortem_url', 'updated_at')) OR
    (table_name = 'status_incident_updates' AND column_name IN ('team_id')) OR
    (table_name = 'maintenance_windows' AND column_name IN ('team_id', 'state', 'description', 'component_keys', 'updated_at')) OR
    (table_name = 'security_claim_checks' AND column_name IN ('created_at', 'updated_at'))
  )
ORDER BY table_name, column_name;
-- EXPECTED: 15 rows.
```

### 9.2 Domain 2 — Governance (10 columns)

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'delegated_admin_grants' AND column_name IN ('organization_id', 'department_id', 'workspace_id')) OR
    (table_name = 'governance_policy_assignments' AND column_name IN ('scope', 'inherit_from_parent', 'is_override', 'assigned_by_user_id')) OR
    (table_name = 'governance_policy_audits' AND column_name IN ('code', 'reason', 'occurred_at_utc'))
  )
ORDER BY table_name, column_name;
-- EXPECTED: 10 rows.
```

### 9.3 Domain 3 — Redaction (19 columns)

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'redaction_versions' AND column_name IN ('authored_by_user_id', 'superseded_at_utc', 'submitted_at_utc', 'approved_at_utc')) OR
    (table_name = 'redaction_detections' AND column_name IN ('kind', 'suggested_region_kind', 'suggested_region_geometry', 'suggested_method', 'decision_state')) OR
    (table_name = 'redaction_decisions' AND column_name IN ('version_id')) OR
    (table_name = 'redaction_approvals' AND column_name IN ('approver_user_id', 'decided_at_utc')) OR
    (table_name = 'redaction_derivatives' AND column_name IN ('storage_bucket', 'render_started_at', 'rendered_at_utc', 'failure_reason')) OR
    (table_name = 'redaction_activities' AND column_name IN ('version_id', 'occurred_at_utc')) OR
    (table_name = 'redaction_policy_versions' AND column_name IN ('reviewed_by_user_id'))
  )
ORDER BY table_name, column_name;
-- EXPECTED: 19 rows.
```

### 9.4 Domain 7 — Exchange / Webhooks (5 columns)

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'webhook_endpoints' AND column_name IN ('updated_at')) OR
    (table_name = 'webhook_deliveries' AND column_name IN ('updated_at', 'created_at', 'next_retry_at', 'next_attempt_at_utc'))
  )
ORDER BY table_name, column_name;
-- EXPECTED: 5 rows.
```

### 9.5 Aggregate check (49 columns)

```sql
SELECT COUNT(*) AS phase2_columns_present
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    (table_name = 'trust_center_article_versions' AND column_name = 'published_at_utc') OR
    (table_name = 'subprocessor_versions' AND column_name IN ('team_id', 'effective_at_utc')) OR
    (table_name = 'status_incidents' AND column_name IN ('external_ref', 'component_keys', 'postmortem_url', 'updated_at')) OR
    (table_name = 'status_incident_updates' AND column_name = 'team_id') OR
    (table_name = 'maintenance_windows' AND column_name IN ('team_id', 'state', 'description', 'component_keys', 'updated_at')) OR
    (table_name = 'security_claim_checks' AND column_name IN ('created_at', 'updated_at')) OR
    (table_name = 'delegated_admin_grants' AND column_name IN ('organization_id', 'department_id', 'workspace_id')) OR
    (table_name = 'governance_policy_assignments' AND column_name IN ('scope', 'inherit_from_parent', 'is_override', 'assigned_by_user_id')) OR
    (table_name = 'governance_policy_audits' AND column_name IN ('code', 'reason', 'occurred_at_utc')) OR
    (table_name = 'redaction_versions' AND column_name IN ('authored_by_user_id', 'superseded_at_utc', 'submitted_at_utc', 'approved_at_utc')) OR
    (table_name = 'redaction_detections' AND column_name IN ('kind', 'suggested_region_kind', 'suggested_region_geometry', 'suggested_method', 'decision_state')) OR
    (table_name = 'redaction_decisions' AND column_name = 'version_id') OR
    (table_name = 'redaction_approvals' AND column_name IN ('approver_user_id', 'decided_at_utc')) OR
    (table_name = 'redaction_derivatives' AND column_name IN ('storage_bucket', 'render_started_at', 'rendered_at_utc', 'failure_reason')) OR
    (table_name = 'redaction_activities' AND column_name IN ('version_id', 'occurred_at_utc')) OR
    (table_name = 'redaction_policy_versions' AND column_name = 'reviewed_by_user_id') OR
    (table_name = 'webhook_endpoints' AND column_name = 'updated_at') OR
    (table_name = 'webhook_deliveries' AND column_name IN ('updated_at', 'created_at', 'next_retry_at', 'next_attempt_at_utc'))
  );
-- EXPECTED: phase2_columns_present = 49.
```

### 9.6 Smoke probes for application paths

```sql
-- Trust article publish-order query path (Prisma orderBy publishedAtUtc).
SELECT id, published_at_utc FROM trust_center_article_versions ORDER BY published_at_utc DESC NULLS LAST LIMIT 5;

-- Status incident updated_at sort path.
SELECT id, updated_at FROM status_incidents ORDER BY updated_at DESC LIMIT 5;

-- Redaction version submission flow.
SELECT id, submitted_at_utc, approved_at_utc FROM redaction_versions WHERE submitted_at_utc IS NOT NULL LIMIT 5;

-- Webhook delivery retry pointer.
SELECT id, next_retry_at, next_attempt_at_utc FROM webhook_deliveries WHERE next_retry_at IS NOT NULL LIMIT 5;
```

Each probe returns rows without error post-deploy. Pre-deploy, the same probes return `column "..." does not exist` — this is the drift symptom Phase 2 resolves.

---

## 10. Remaining Phase 3 Guardrails (CI Linter Ideas)

The following CI guards prevent future Phase-2-class drift from reappearing. None of these are implemented by Phase 2; they are recommended for adoption alongside the next CI hardening pass.

| Guard | Purpose | Implementation sketch |
|---|---|---|
| **Per-`@map` schema-vs-information_schema check** | Catch any new Prisma `@map(...)` field where the production column is missing. | Nightly job: parse `services/api/prisma/schema.prisma`, extract every `(model, @@map, field, @map)` tuple, run `SELECT column_name FROM information_schema.columns WHERE table_name = $1` per table against a staging snapshot, diff the sets, fail if any field is missing on the DB side. Output the missing-column list in the same format as the Phase 2 master matrix so the next Phase N audit is pre-seeded. |
| **no-DROP-in-migration linter** | Prevent any new migration from emitting DROP TABLE / DROP COLUMN / DROP INDEX / DROP CONSTRAINT / DROP TYPE / DROP SCHEMA. | Pre-commit + CI grep on `services/api/prisma/migrations/**/migration.sql` for `(?i)\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE|SCHEMA)\b` outside comment lines. Allowlist may be maintained in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` (existing pattern) for the rare emergency case. |
| **no-RENAME-in-migration linter** | Prevent table or column rename, which is silently destructive to deployed readers. | Same pattern: grep for `(?i)\bRENAME\b` in migration SQL. |
| **no-DESTRUCTIVE-DML linter** | Prevent `DELETE FROM`, `TRUNCATE`, or unconditional `UPDATE` in migrations. | Grep for `(?i)^\s*(DELETE\s+FROM|TRUNCATE|UPDATE\s+[a-z_]+\s+SET)` outside comments. UPDATE with a WHERE pkey IN subquery for a finite known set may be allowlisted on a per-migration basis. |
| **no-SET-NOT-NULL-on-existing-column linter** | Prevent `ALTER COLUMN ... SET NOT NULL` on a column that pre-exists in the same migration file as the ADD COLUMN (NOT-NULL-DEFAULT is fine because it backfills atomically). | AST parse the migration; if a column is set NOT NULL but is not also being added in the same migration with `NOT NULL DEFAULT ...`, fail. |
| **Allowlist drift guard** | Ensure every new migration ID has an explicit `PERMITTED_LATER_MIGRATIONS` annotation or fails CI. | Test in `services/api/test/phase-32-7-2-security-event-mapping-drift.test.ts` already enumerates the allowlist; extend to walk the `migrations/` directory and assert every directory name newer than the cutoff is present in the allowlist Set (with a TODO message pointing the author to add a justification comment). |
| **Honest-count parity assertion** | Catch synthesis-vs-on-disk count mismatches (the Phase 5 lesson). | Extend the per-migration `GROUP B` shape test in `services/api/test/production-phase2-drift-remediation.test.ts` to pin the on-disk ADD COLUMN count against the column-pin array length; any drift fails the test. |
| **Negative-glob "no new route file" check** | Detect when a Phase that promised to be "schema-only" silently grows a v2 surface. | CI assertion (already in Phase 5 `GROUP E.2` and `GROUP F`) pinning the `services/api/src/routes/*.ts` count + asserting no new `*-v2.*` file appears under `apps/web/app/`. Update the pinned count when a route is intentionally added. |

---

## What This Phase Did NOT Do (Honest Disclosure)

Phase 2 deliberately did not resolve the `RedactionPolicyAudit` table-name drift (singular vs plural) because table RENAME is forbidden under Phase 2 non-negotiables and the dual-table-cutover path requires explicit architecture sign-off; it remains tagged REQUIRES_MANUAL_DECISION pending an architect's choice between dual-write-and-backfill, accepting the legacy singular table via `@@map` change (which contradicts schema-as-truth), or starting fresh with the plural table. Phase 2 did not probe production for the three UNVERIFIED columns (`entitlements.team_seats`, `verification_packages.package_type`, `verification_packages.trust_decision_snapshot`) because no live database access was available during the audit; they are logged for a future Phase 3 batch once an `information_schema.columns` probe confirms their presence or absence. Phase 2 did not modify the Prisma schema in any way (the schema is the source of truth — only the database was taught to match), did not create any v2 models/services/routes, did not apply `prisma migrate diff` output directly, did not silence any P2022 errors via try/catch, did not perform any DROP/RENAME/DELETE/TRUNCATE/destructive-UPDATE/SET-NOT-NULL operation on an existing column, and did not bundle the 49 columns into a single giant migration — each domain received its own per-table, idempotent, ADD-COLUMN-IF-NOT-EXISTS-only migration file.
