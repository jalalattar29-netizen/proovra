# Production Schema Reconciliation Plan

**Status:** Phase 1 baseline only  
**Date:** 2026-06-27  
**Canonical target:** `services/api/prisma/schema.prisma`

## Executive Summary

This document is the Phase 1 reconciliation baseline for bringing the production
database into clean alignment with the current canonical Prisma schema.

What is confirmed from local evidence:

- The repo already contains strong evidence of real production drift in Evidence
  Lifecycle, Collaboration, Search, Trust, Redaction, Media Intelligence, and
  delegated-admin surfaces.
- The repo also contains a large historical compatibility artifact
  (`services/api/scripts/audit-output/prisma-compatibility-report.json`) with
  104 rows. Most of those rows are **not** current runtime blockers. They are a
  mix of parser artifacts, false positives against newer schema, intentional
  DB-only internals, and true legacy residue.
- The safest repair path is still the same:
  1. run the live production audit,
  2. apply additive canonical catch-up only,
  3. validate,
  4. clean legacy residue afterward.

What is blocked in this environment:

- The required live audit command was attempted exactly as requested:

```bash
node services/api/scripts/full-production-schema-audit.mjs
```

- Result:

```text
ERROR: DATABASE_URL is not set. Export it before running this audit.
```

Because the live production connection is unavailable here, this baseline uses
the best local evidence available:

- `services/api/prisma/schema.prisma`
- `docs/operations/live-schema-compatibility-repair.md`
- `docs/operations/production-schema-repair.md`
- `docs/operations/migration-repair-plan.md`
- `docs/operations/production-sentry-batch-schema-drift-fix.md`
- `docs/operations/audit-closure-ledger.md`
- existing repair migrations, especially:
  - `20261006000000_phase_o_final_production_column_repair`
  - `20261007000000_phase_o_live_schema_compatibility_repair`
  - `20261008000000_phase_o_workflow_join_table_final_repair`
  - `20270802000000_phase_sentry_batch_schema_drift_repair`

## Production Assumptions

- Production has no real end users yet, so we can be more assertive than a
  mature deployment.
- Even so, reconciliation should remain enterprise-safe:
  additive first, destructive later, and only after proof.
- `schema.prisma` is canonical unless there is strong evidence that the DB name
  is the intended permanent canonical form.
- We do **not** want permanent dual-column schemas.

## Hard Safety Rules

- Do not execute SQL in Phase 1.
- Do not modify `schema.prisma` in Phase 1.
- Do not create migration files in Phase 1.
- Do not drop columns, constraints, or foreign keys in Phase 1.
- Do not perform destructive enum changes.
- Phase 2 is catch-up only.
- Phase 3 is cleanup only.
- Every Phase 2 column add should prefer `ADD COLUMN IF NOT EXISTS`.
- Every rename-shaped repair should add the canonical column first, backfill only
  where target is null, and keep the legacy source until Phase 3.

## Category Legend

- `A` Missing DB column required by current schema
- `B` Legacy DB column with a clear canonical replacement
- `C` Naming drift where DB has the old name and schema has the canonical name
- `D` Type mismatch that can be safely fixed later
- `E` Dangerous change requiring separate manual review
- `F` Legacy residue safe to delete after code-reference proof
- `G` Disabled/future/DB-only feature: keep documented, do not reconcile now
- `H` False positive or audit-tool mismatch

## Normalized Inventory Counts

This baseline classifies **52 normalized drift items**:

- `A`: 17
- `C`: 12
- `E`: 2
- `F`: 5
- `G`: 1
- `H`: 15

Planning counts:

- Phase 2 candidate items: **29**
- Phase 3 cleanup candidate items: **17**
- Manual-review items: **2**

## Canonical Naming Decisions

- Canonical database naming stays **snake_case**.
- When current schema maps to `reviewed_at`, `superseded_at`, `accepted_at`,
  `reverted_at`, `render_started_at`, or `version_id`, those names are
  canonical. Old `*_utc` or alternate legacy names are Phase 2 backfill
  sources, then Phase 3 cleanup targets.
- For workflow/search/trust tables with old camelCase physical columns, the
  canonical target is the current schema's snake_case form.
- Search internals such as `tsv` / `embedding` that are intentionally not
  represented in Prisma should remain DB-only until an explicit design decision
  says otherwise.

## Full Drift Inventory

### Evidence Lifecycle

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EL-1 | `evidence_saved_views` | `owner_user_id`, `team_id`, `description`, `filters_json`, `sort_key`, `scope`, `is_default`, `created_at` | Canonical snake_case columns must exist | `live-schema-compatibility-repair.md` reports missing canonical columns; guarded legacy sources exist for `teamId`, `filtersJson`, `ownerUserId` | Original G2 table creation drift; additive catch-up already drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | C | Keep schema canonical; add missing snake_case columns only; use camelCase only as temporary backfill source | Yes | Yes | Yes | High |
| EL-2 | `evidence_legal_holds` | `created_at` | Schema expects canonical timestamp column | Live compatibility repair doc reports missing | Introduced in `20260517100000_add_governance_phase9`; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | A | Add missing canonical column if still absent in fresh live audit | No | Yes | No | Medium |
| EL-3 | `upload_sessions` | `stalled_at_utc`, `abandoned_at_utc`, `completed_at_utc` | Schema expects lifecycle timestamps | Live compatibility repair doc reports missing | Phase 30 table at risk from `CREATE TABLE IF NOT EXISTS`; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | A | Add missing canonical columns if still absent | No | Yes | No | High |
| EL-4 | `evidence_workflow_instances` | wide snake_case canonical set including `team_id`, `template_id`, `template_slug`, `template_version`, `pre_hold_status`, `intake_mode`, `actor_role`, `case_id`, `claim_ref`, `matter_ref`, `evidence_request_id`, `intake_session_id`, `external_contact_hash`, `created_by_user_id`, `assigned_reviewer_user_id`, `title`, `submitted_at_utc`, `approved_at_utc`, `closed_at_utc`, `created_at` | Current schema is canonical snake_case | Live compatibility repair doc reports snake_case missing and camelCase legacy sources present | Original workflow-engine introduction `20260530100000_add_workflow_engine_phase22`; wide catch-up drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | C | Add canonical snake_case columns; backfill from matching camelCase legacy columns; remove legacy camelCase only in Phase 3 | Yes | Yes | Yes | High |
| EL-5 | `evidence_workflow_step_instances` | wide snake_case canonical set including `workflow_instance_id`, `step_key`, `order_index`, `accepted_kinds_json`, `identity_requirement`, `location_requirement`, `mapped_evidence_id`, `completed_by_user_id`, `completed_at_utc`, `waiver_reason`, `private_reviewer_note`, `created_at` | Current schema is canonical snake_case | Live compatibility repair doc reports same naming drift pattern | Same Phase 22 introduction; catch-up drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | C | Add canonical snake_case columns; guarded backfill from camelCase; cleanup later | Yes | Yes | Yes | High |
| EL-6 | `evidence_workflow_visibility_decisions` | wide snake_case canonical set including `workflow_instance_id`, `evidence_id`, `field_key`, `visible_in_app`, `visible_to_contributor`, `visible_in_public_verify`, `visible_in_report`, `visible_in_verification_package`, `requires_redaction`, `created_at` | Current schema is canonical snake_case | Live compatibility repair doc reports same naming drift pattern | Same Phase 22 introduction; catch-up drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Evidence Lifecycle | C | Add canonical snake_case columns; guarded backfill from camelCase; cleanup later | Yes | Yes | Yes | High |
| EL-7 | `evidence_workflow_instance_evidence` | `id`, `step_instance_id`, PK / join-table shape | Schema expects canonical join-table shape; table also shows naming drift | Live compatibility repair doc explicitly marks this as manual-review-required | Final repair drafted separately in `20261008000000_phase_o_workflow_join_table_final_repair`; operator review still required | Evidence Lifecycle | E | Do not auto-fix blindly; inspect live rows, decide PK/backfill strategy, then ship a dedicated migration | Likely | No | No | Critical |
| EL-8 | `evidence_exchange_packages` | `updated_at` | Schema expects canonical update timestamp | Sentry-batch repair doc reports production missing column | Catch-up already authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Evidence Lifecycle | A | Verify live DB; if still absent, include additive column in Phase 2A catch-up | No | Yes | No | Medium |

### Search / Graph / Indexing

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SG-1 | `evidence_search_documents` | canonical snake_case set including `team_id`, `document_type`, `source_id`, `searchable_text`, `searchable_metadata_json`, `searchable_tags_json`, `visibility_scope_json`, `governance_scope_json`, `review_state`, `workflow_state`, `export_state`, `retention_state`, `legal_hold_state`, `contributor_scoped`, `reviewer_restricted`, `evidence_id`, `workflow_instance_id`, `workflow_step_instance_id`, `case_id`, `claim_ref`, `matter_ref`, `source_updated_at_utc`, `indexed_at_utc`, `created_at` | Current schema is canonical snake_case | Live compatibility repair doc reports missing canonical columns with camelCase legacy sources | Search discovery introduced in `20260531100000_add_search_discovery_phase24`; catch-up drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Search / Graph / Indexing | C | Add canonical snake_case columns; backfill from camelCase where present; remove old names only after validation | Yes | Yes | Yes | High |
| SG-2 | `evidence_search_documents` | `tsv`, `embedding` | Prisma intentionally does not model these search/vector internals | Historical compatibility artifact marks them as unused by Prisma | `20260620100000_phase24_31_consolidated_drift_patches` added internals; current schema omits them intentionally | Search / Graph / Indexing | G | Keep DB-only for now; do not reconcile into Prisma and do not drop until search/indexing design says so | No | No | No | Medium |

### Media Intelligence

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MI-1 | `evidence_intelligence_jobs` | `scheduled_at_utc`, `started_at_utc`, `completed_at_utc` | Schema expects lifecycle timestamps | Live compatibility repair doc reports missing | `20260524100000_add_intelligence_phase15`; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Media Intelligence | A | Add missing canonical timestamps if still absent in live audit | No | Yes | No | High |
| MI-2 | `evidence_extracted_texts` | `provider_version`, `confidence`, `duration_ms`, `extracted_at_utc` | Schema expects canonical columns | Live compatibility repair doc reports missing | Same Phase 15 introduction; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Media Intelligence | A | Add missing canonical columns if still absent | No | Yes | No | High |
| MI-3 | `evidence_entities` | `confidence` | Schema expects confidence column | Live compatibility repair doc reports missing | Same Phase 15 introduction; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Media Intelligence | A | Add missing canonical column if still absent | No | Yes | No | Medium |
| MI-4 | `evidence_semantic_chunks` | `chunk_text`, `embedding_provider`, `embedding_model`, `embedding_dimensions` | Schema expects canonical semantic chunk metadata | Live compatibility repair doc reports missing | Same Phase 15 introduction; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Media Intelligence | A | Add missing canonical columns if still absent | No | Yes | No | High |
| MI-5 | `evidence_similarities` | `advisory_summary` | Schema expects canonical advisory field | Live compatibility repair doc reports missing | Same Phase 15 introduction; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Media Intelligence | A | Add missing canonical column if still absent | No | Yes | No | Medium |
| MI-6 | `media_intelligence_records` | `reviewed_at` / `superseded_at` canonical vs legacy `reviewed_at_utc` / `superseded_at_utc` | Current schema uses non-UTC-suffixed canonical names on this model | Historical compatibility artifact still points at old `*_utc` names | Intelligence platform landed in `20261215000000_phase_3b_intelligence_platform` | Media Intelligence | C | Keep `reviewed_at` / `superseded_at` canonical; if live DB still only has old names, add canonical columns and backfill; drop old names only in Phase 3 | Yes | Yes | Yes | Medium |
| MI-7 | `reviewer_corrections` | `accepted_at`, `reverted_at`, `superseded_at` canonical vs legacy `accepted_at_utc`, `reverted_at_utc`, `superseded_at_utc` | Current schema uses non-UTC-suffixed canonical names on this model | Historical compatibility artifact still points at old `*_utc` names | `20261215000000_phase_3b_intelligence_platform` and `20261216000000_phase_3b_enterprise_closure` | Media Intelligence | C | Keep current schema canonical; add/backfill canonical columns only if live DB still has legacy names | Yes | Yes | Yes | Medium |
| MI-8 | `provider_budgets` | `archived_at` | Schema expects archival timestamp | Sentry-batch repair doc reports production missing column | Additive fix already authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Media Intelligence | A | Verify live DB; if still absent, include additive catch-up | No | Yes | No | Medium |

### Redaction

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RD-1 | `redaction_projects` | `closed_at_utc` | Schema expects canonical close timestamp | Sentry-batch repair doc reports production missing column | Fix already authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Redaction | A | Verify live DB; if absent, additive catch-up only | No | Yes | No | Medium |
| RD-2 | `redaction_policy_assignments` | canonical `version_id` with legacy `policy_version_id` source | Current schema maps `policyVersionId` to `version_id` | Sentry-batch repair doc identifies old `policy_version_id` as legacy source | Repair authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Redaction | C | Keep `version_id` canonical; add/backfill from `policy_version_id`; drop legacy source later | Yes | Yes | Yes | High |
| RD-3 | `redaction_policy_assignments` | canonical `revoked_at` vs legacy `revoked_at_utc` artifact | Current schema maps `revokedAtUtc` to `revoked_at` | Historical compatibility artifact still points to `revoked_at_utc` | Phase 3A Elite history in `20261201000000_phase_3a_elite_closure_policy_video` | Redaction | C | Keep `revoked_at` canonical; if live DB still has `revoked_at_utc`, do additive catch-up then cleanup later | Yes | Yes | Yes | Medium |
| RD-4 | `redaction_derivatives` | canonical `render_started_at` vs legacy `render_started_at_utc` artifact | Current schema maps `renderStartedAt` to `render_started_at` | Historical compatibility artifact still points to `render_started_at_utc` | Redaction platform history in `20261101000000_phase_3a_redaction_platform` | Redaction | C | Keep `render_started_at` canonical; if live DB still has old UTC-suffixed name, add canonical column and backfill | Yes | Yes | Yes | Medium |
| RD-5 | `redaction_policy_versions` | `published_at_utc` | Current schema still expects this column | Historical compatibility artifact incorrectly marked it unused | Phase 3A Elite history in `20261201000000_phase_3a_elite_closure_policy_video` | Redaction | H | Do not reconcile; treat as stale compatibility-artifact false positive | No | No | No | Low |
| RD-6 | `redaction_versions` | `rejected_at_utc` | Current schema still expects this column | Historical compatibility artifact incorrectly marked it unused | Redaction platform history in `20261101000000_phase_3a_redaction_platform` | Redaction | H | Do not reconcile; treat as stale compatibility-artifact false positive | No | No | No | Low |

### Governance / Retention / Destruction

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GV-1 | `governance_notifications` | `channels`, `recipient_user_ids` | Current schema still expects these columns | Historical compatibility artifact marked them unused, but current schema still references them | `20260613100000_phase27_5_governance_operationalization` | Governance / Retention / Destruction | H | No schema repair required; treat as stale compatibility-artifact false positive | No | No | No | Low |
| GV-2 | `governance_export_snapshots` | `active_hold_ids`, `governance_incident_ids` | Current schema still expects these columns | Historical compatibility artifact marked them unused, but current schema still references them | Same governance operationalization migration | Governance / Retention / Destruction | H | No schema repair required; keep as-is | No | No | No | Low |
| GV-3 | `destruction_certificates` | legacy `certificate_pdf_uri` | Current schema uses `certificate_uri` instead | Historical compatibility artifact reports old DB-only column name | `20261231000000_phase_4b_final_closure` | Governance / Retention / Destruction | F | Prove no code reads the old column, then delete in Phase 3 only | No | No | Yes | Medium |
| GV-4 | `destruction_reviews` | `capture_method` | Current schema still expects this column | Historical compatibility artifact marked it unused | `20260925000000_phase0_schema_catchup` | Governance / Retention / Destruction | H | No schema repair required; treat as stale compatibility-artifact false positive | No | No | No | Low |

### Collaboration / Workflow

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CW-1 | `discussion_threads` | `assigned_at_utc`, `resolved_by_user_id`, `resolved_at_utc`, `reopened_by_user_id`, `reopen_count`, `escalated_by_user_id`, `created_at` | Schema expects canonical columns | Live compatibility repair doc reports missing | Phase 16 collaboration table introduced with `CREATE TABLE IF NOT EXISTS`; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Collaboration / Workflow | A | Add missing canonical columns if still absent in fresh live audit | No | Yes | No | High |
| CW-2 | `discussion_messages` | `contributor_intake_session_id`, `contributor_label`, `edited_at_utc`, `deleted_at_utc`, `deleted_by_user_id`, `created_at` | Schema expects canonical columns | Live compatibility repair doc reports missing | Same Phase 16 collaboration history; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Collaboration / Workflow | A | Add missing canonical columns if still absent | No | Yes | No | High |
| CW-3 | `discussion_participants` | `added_by_user_id`, `added_at_utc`, `revoked_by_user_id` | Schema expects canonical columns | Live compatibility repair doc reports missing | Same Phase 16 collaboration history; repaired in `20261007000000_phase_o_live_schema_compatibility_repair` | Collaboration / Workflow | A | Add missing canonical columns if still absent | No | Yes | No | High |
| CW-4 | `discussion_mentions` | `thread_id`, `mentioned_user_id`, `notified_at_utc`, `created_at`, plus `team_id` history | Schema expects these columns; production runtime previously failed on `team_id` | Live compatibility repair doc says these columns should already have been added by `20261006000000_phase_o_final_production_column_repair`, but fresh live proof is still required | Phase O-Final repair exists; unresolved only if live audit still reports missing | Collaboration / Workflow | E | Manual verification first: re-run live audit, inspect `information_schema`, then decide if a follow-up migration is actually needed | Possible | No | No | Critical |
| CW-5 | `review_escalations` | `createdAtUtc` / `created_at_utc` artifact row | Current schema still references the intended timestamp shape | Historical compatibility artifact is stale relative to current schema | `20260925000000_phase0_schema_catchup` | Collaboration / Workflow | H | No schema repair required; do not create duplicate timestamps | No | No | No | Low |

### Organizations / Workspaces / Teams

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ORG-1 | `delegated_admin_grants` | canonical `granted_to_user_id`, `scope_target_id`, `created_at`, `updated_at` with legacy `grantee_user_id` source | Current schema maps canonical grant target to `granted_to_user_id` | Sentry-batch repair doc reports missing canonical columns and legacy `grantee_user_id` source in production | `20261220000000_phase_4a_trust_and_governance` plus `20270802000000_phase_sentry_batch_schema_drift_repair` | Organizations / Workspaces / Teams | C | Keep canonical grant columns; add/backfill from legacy `grantee_user_id`; cleanup legacy name later | Yes | Yes | Yes | High |
| ORG-2 | `organization_security_policies` | `allowed_email_domains`, `restricted_ip_ranges` | Current schema still expects these columns | Historical compatibility artifact marked them unused, but current schema still references them | `20260526100000_add_identity_phase17` | Organizations / Workspaces / Teams | H | No schema repair required; stale artifact only | No | No | No | Low |
| ORG-3 | `sso_connections`, `scim_provisioning_tokens` | `allowed_email_domains`, `scopes`, `ip_allowlist` | Current schema still expects these columns | Historical compatibility artifact marked them unused | `20260603100000_phase26_identity_governance` | Organizations / Workspaces / Teams | H | No schema repair required; stale artifact only | No | No | No | Low |
| ORG-4 | `cross_org_review_grants`, `external_reviewer_role_assignments`, `evidence` | `created_by_user_id`, `allowed_domains`, `department_id` | Current schema still expects these columns | Historical compatibility artifact marked them unused | `20261220000000_phase_4a_trust_and_governance`, `20270101000000_phase_r3_model_catchup`, `20261225000000_phase_4a_enterprise_closure` | Organizations / Workspaces / Teams | H | No schema repair required; stale artifact only | No | No | No | Low |

### Security / Auth / MFA / Sessions

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC-1 | `trusted_devices` | `created_at` | Schema expects canonical timestamp | Live compatibility repair doc reports missing | Phase O live compatibility repair drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Security / Auth / MFA / Sessions | A | Add missing canonical column if still absent | No | Yes | No | Medium |
| SEC-2 | `trusted_devices` | `avatar_url` | Current schema still expects this column | Historical compatibility artifact marked it unused | `20260925000000_phase0_schema_catchup` | Security / Auth / MFA / Sessions | H | No schema repair required; stale artifact only | No | No | No | Low |
| SEC-3 | `mfa_recovery_requests` | `mfa_enforcement_fail_mode` | Current schema still expects this column | Historical compatibility artifact marked it unused | `20260726000000_r8_1_5_recovery_email_preflight` | Security / Auth / MFA / Sessions | H | No schema repair required; stale artifact only | No | No | No | Low |
| SEC-4 | `subprocessors` | `category`, `country`, `description` | Current schema expects canonical trust metadata | Sentry-batch repair doc reports production missing columns | Catch-up already authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Security / Auth / MFA / Sessions | A | Verify live DB; if still absent, additive catch-up only | No | Yes | No | Medium |
| SEC-5 | `subprocessors` | `change_summary` | Current schema still expects this column | Historical compatibility artifact marked it unused | `20270103000000_phase_r7_trust_schema_fix` | Security / Auth / MFA / Sessions | H | No schema repair required; stale artifact only | No | No | No | Low |

### Billing / Entitlements / Payments

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BIL-1 | `entitlement_grants` | legacy `notes` | Current schema no longer expects this column | Historical compatibility artifact reports old DB-only column | `20261230000000_phase_4b_packaging_and_lifecycle` | Billing / Entitlements / Payments | F | Prove no runtime/code reference remains, then delete in Phase 3 only | No | No | Yes | Medium |

### Trust Center / Audit / Operational

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TR-1 | `operational_incident_events` | `incident_id`, `event_type`, `safe_message`, `metadata_json`, `created_at` with camelCase legacy sources | Current schema is canonical snake_case | Live compatibility repair doc reports missing snake_case columns and guarded camelCase legacy backfill sources | Repair drafted in `20261007000000_phase_o_live_schema_compatibility_repair` | Trust Center / Audit / Operational | C | Add canonical snake_case columns; backfill from `incidentId`, `eventType`, `safeMessage`, `metadataJson`; remove camelCase later | Yes | Yes | Yes | High |
| TR-2 | `status_components` | `updated_at` | Schema expects canonical update timestamp | Sentry-batch repair doc reports production missing column | Repair authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Trust Center / Audit / Operational | A | Verify live DB; if absent, additive catch-up only | No | Yes | No | Medium |
| TR-3 | `chain_transfers` | `updated_at` | Schema expects canonical update timestamp | Sentry-batch repair doc reports production missing column | Repair authored in `20270802000000_phase_sentry_batch_schema_drift_repair` | Trust Center / Audit / Operational | A | Verify live DB; if absent, additive catch-up only | No | Yes | No | Medium |
| TR-4 | `automation_webhook_deliveries` | `consecutive_failure_count` | Current schema still expects this column | Historical compatibility artifact marked it unused | `20260803000000_phase_e3_3_async_delivery_runtime` | Trust Center / Audit / Operational | H | No schema repair required; stale artifact only | No | No | No | Low |

### Other / Legacy Residue

| ID | Table | Column/object | Schema expectation | Current DB / audit finding | Migration history | Domain | Cat | Permanent action | Backfill | P2 | P3 | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OT-1 | multiple tables | 40 bogus `ON` pseudo-columns from the historical compatibility artifact | These are not real Prisma scalar fields and should not be treated as DB drift | `prisma-compatibility-report.json` contains 40 `MIGRATION_ADDS_UNUSED_COLUMN` rows where `column = ON` | Historical parser/audit artifact only | Other / Legacy residue | H | Treat as parser artifact only; do not author any migration from these rows | No | No | No | Low |
| OT-2 | `evidence` | `device_time_utc`, `timezone_offset_min` | Current schema no longer expects these columns | Historical compatibility artifact reports old DB-only columns | Legacy init history `20260131235343_init` | Other / Legacy residue | F | Prove no code references remain, then delete in Phase 3 only | No | No | Yes | Low |
| OT-3 | `custody_events` | `actor_type`, `actor_id` | Current schema no longer expects these columns | Historical compatibility artifact reports old DB-only columns | Legacy init history `20260131235343_init` | Other / Legacy residue | F | Prove no code references remain, then delete in Phase 3 only | No | No | Yes | Low |
| OT-4 | `reports` | `report_sha256` | Current schema no longer expects this column | Historical compatibility artifact reports old DB-only column | Legacy init history `20260131235343_init` | Other / Legacy residue | F | Prove no code references remain, then delete in Phase 3 only | No | No | Yes | Low |
| OT-5 | `reports` | `created_at` | Current schema still expects timestamp shape on report records | Historical compatibility artifact marked it unused, but current schema still carries report timestamps | Legacy init history `20260131235343_init` | Other / Legacy residue | H | No schema repair required; stale artifact only | No | No | No | Low |

## Domain-by-Domain Classification Summary

- **Evidence Lifecycle:** highest-risk domain because it contains both live
  runtime blockers and the only join-table item that still needs operator
  judgment (`EL-7`).
- **Search / Graph / Indexing:** one real naming-drift repair (`SG-1`) and one
  intentional DB-only internal shape (`SG-2`).
- **Media Intelligence:** mostly safe additive catch-up; all rows are good
  Phase 2 candidates except legacy-name cleanup that belongs in Phase 3.
- **Redaction:** safe additive repairs exist, but keep canonical names aligned
  to the current schema instead of reviving old `_utc` or `policy_version_id`
  forms.
- **Governance / Retention / Destruction:** mostly false positives plus one real
  cleanup-only residue (`GV-3`).
- **Collaboration / Workflow:** live blocker family; do not defer `discussion_*`
  repairs behind lower-risk domains.
- **Organizations / Workspaces / Teams:** only one real catch-up row currently
  evidenced (`ORG-1`); the rest are stale artifact rows.
- **Security / Auth / MFA / Sessions:** one live timestamp catch-up plus
  `subprocessors` from the Sentry batch; the rest are stale artifact rows.
- **Billing / Entitlements / Payments:** only one cleanup-only residue is
  evidenced locally; live audit still must confirm no hidden table-shape drift
  remains in early billing migrations.
- **Trust Center / Audit / Operational:** one high-risk naming-drift repair and
  two straightforward additive timestamp catches.
- **Other / Legacy residue:** historical cleanup surface only; do not let it
  distract from runtime catch-up.

## Phase Plan

### Phase 1 — Reconciliation Baseline

This document.

Deliverables:

- classify drift
- decide canonical names
- separate Phase 2 catch-up from Phase 3 cleanup
- identify dangerous/manual-review items

### Phase 2 — Canonical Schema Catch-up

Scope: **29 items**

Include only:

- every `A` row
- every `C` row
- nothing from `F`
- nothing from `H`
- nothing from `G`
- nothing from `E` until manually approved

Recommended deployment slices:

1. **Phase 2A — live-blocker core**
   - `evidence_saved_views`
   - `upload_sessions`
   - `discussion_threads`
   - `discussion_messages`
   - `discussion_participants`
   - `trusted_devices.created_at`
   - `operational_incident_events`

2. **Phase 2B — workflow/search canonical naming**
   - `evidence_workflow_instances`
   - `evidence_workflow_step_instances`
   - `evidence_workflow_visibility_decisions`
   - `evidence_search_documents`

3. **Phase 2C — intelligence/redaction/trust additive catch-up**
   - `evidence_intelligence_jobs`
   - `evidence_extracted_texts`
   - `evidence_entities`
   - `evidence_semantic_chunks`
   - `evidence_similarities`
   - `provider_budgets`
   - `redaction_projects.closed_at_utc`
   - `redaction_policy_assignments.version_id`
   - `redaction_policy_assignments.revoked_at`
   - `redaction_derivatives.render_started_at`
   - `status_components.updated_at`
   - `chain_transfers.updated_at`
   - `subprocessors.category`
   - `subprocessors.country`
   - `subprocessors.description`
   - `delegated_admin_grants`
   - naming decisions for `media_intelligence_records`
   - naming decisions for `reviewer_corrections`

### Phase 3 — Legacy Cleanup

Scope: **17 items**

Allowed only after:

- Phase 2 passes the live audit
- runtime P2021/P2022 issues are gone
- code-reference proof confirms legacy columns are unused

Cleanup classes:

- old camelCase workflow/search/trust source columns after successful backfill
- old `policy_version_id`, `grantee_user_id`, and old `*_utc` variants where a
  new canonical column now exists
- `destruction_certificates.certificate_pdf_uri`
- `entitlement_grants.notes`
- `evidence.device_time_utc`
- `evidence.timezone_offset_min`
- `custody_events.actor_type`
- `custody_events.actor_id`
- `reports.report_sha256`

### Phase 4 — Validation + Baseline Lock

- rerun `node services/api/scripts/full-production-schema-audit.mjs`
- confirm `prisma migrate status` is clean
- run API typecheck / tests / build
- rerun a fresh Evidence Lifecycle end-to-end smoke
- refresh the drift guard / ratchet so new migrations cannot recreate this
  pattern

## What Must Not Be Fixed Now

- `EL-7` `evidence_workflow_instance_evidence` without direct row inspection
- `CW-4` `discussion_mentions` without a fresh live audit proving the columns
  still are missing after `20261006000000_phase_o_final_production_column_repair`
- `SG-2` DB-only search internals (`tsv`, `embedding`)
- any `H` false-positive row
- any `F` cleanup-only row before Phase 2 validation
- any early-migration risk that is not backed by a current live audit finding

## Dangerous / Manual-Review Items

- `EL-7` `evidence_workflow_instance_evidence`
  - Why dangerous: PK/backfill decisions on a populated join table are
    inherently data-shaping.
- `CW-4` `discussion_mentions`
  - Why dangerous: repo evidence says the columns should already exist if the
    earlier repair fully applied; adding duplicates blindly would be sloppy and
    could hide the real deployment state.

## Validation Plan

Before Phase 2 authoring:

1. Obtain a read-only production `DATABASE_URL`.
2. Run:

```bash
node services/api/scripts/full-production-schema-audit.mjs
```

3. Save both human-readable output and JSON output.
4. Confirm which of the 29 Phase 2 candidate items are still truly open.

After each Phase 2 migration slice:

1. rerun the live audit
2. confirm no new critical findings were introduced
3. confirm `prisma migrate status` stays clean
4. run API test/build validation
5. confirm previously affected endpoints no longer degrade on missing-column
   paths

Before Phase 3 cleanup:

1. grep code for legacy column references
2. confirm target canonical columns are populated
3. confirm no code path still depends on legacy names
4. only then author cleanup migration(s)

## Rollback Strategy

- Phase 2 migrations should remain additive and idempotent, so rollback should
  usually mean **revert application deploy**, not drop newly added columns.
- If a Phase 2 deployment exposes unexpected behavior, pause, re-run the live
  audit, and compare the DB shape to the exact migration slice that landed.
- Phase 3 cleanup should be gated behind database snapshot availability because
  cleanup is the first phase that may remove old residue.

## Final Recommendation

Yes, the full drift can be repaired safely.

The correct first move is **not** to author a broad migration from local
artifacts alone. The correct next move is:

```text
TASK: Phase 2A preflight — obtain a read-only production DATABASE_URL, run
node services/api/scripts/full-production-schema-audit.mjs (text + JSON), and
freeze the exact Phase 2A catch-up scope from the 29 candidate items above
before writing any SQL.
```

Once that live audit exists, the safest first implementation slice is the
live-blocker core:

- `evidence_saved_views`
- `upload_sessions`
- `discussion_threads`
- `discussion_messages`
- `discussion_participants`
- `trusted_devices.created_at`
- `operational_incident_events`

That slice is the best first repair because it removes the highest-probability
runtime blockers without mixing in cleanup work.
