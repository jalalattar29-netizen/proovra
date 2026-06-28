# Phase 2B Live Precheck Results

Generated from the read-only Phase 2B live audit snapshots already captured in:

- `D:\digital-witness\tmp_phase2b_audit.json`
- `D:\digital-witness\tmp_phase2b_prechecks.json`

Snapshot metadata:

- Generated at UTC: `2026-06-27T17:51:13.198Z`
- Target: `ep-long-hat-ag5kk101-pooler.c-2.eu-central-1.aws.neon.tech:5432/neondb`
- Audit summary:
  - `CRITICAL = 0`
  - `HIGH = 142`
  - `LOW = 79`
  - Deduped HIGH objects = `135`

## Category Summary

| Category | Meaning | Count | Precheck result |
| --- | --- | ---: | --- |
| `A` | timestamp repair | 9 | 8 tables empty; `evidence_search_documents.updated_at` had `647` rows, `0` NULLs, min `2026-06-15 23:54:54.07`, max `2026-06-27 16:20:32.448` |
| `B` | text/varchar alignment | 29 | all inspected columns had `0` over-limit rows |
| `C` | integer widening | 7 | all affected tables currently had `0` rows |
| `D` | enum alignment | 13 | live enum/text values confirmed; 5 findings are audit false positives from enum `@@map` handling |
| `E` | required-nullability hardening | 64 | every affected column had `0` NULL rows |
| `F` | JSON semantic repair | 2 | no non-null live samples were found for the drifted values |
| `G` | UUID / identifier alignment | 11 | all text→UUID candidates were UUID-valid; remaining UUID↔string drifts required direction review |

## Timestamp Repairs

Affected columns:

- `evidence_saved_views.updated_at`
- `evidence_legal_holds.updated_at`
- `evidence_extracted_texts.updated_at`
- `discussion_threads.updated_at`
- `trusted_devices.updated_at`
- `evidence_workflow_instances.updated_at`
- `evidence_workflow_step_instances.updated_at`
- `evidence_workflow_visibility_decisions.updated_at`
- `evidence_search_documents.updated_at`

Live result:

- 8/9 affected tables had `0` rows, so type conversion is semantically inert there.
- `evidence_search_documents.updated_at` had live rows but `0` NULLs, and values were recent operational timestamps consistent with UTC-naive application writes.
- Permanent resolution: DB migration to `TIMESTAMPTZ(6)` using UTC semantics.

## Integer Widening

Affected columns:

- `external_review_invitation_deliveries.attempt` (`smallint -> integer`)
- `redaction_versions.version_ordinal` (`smallint -> integer`)
- `redaction_policy_versions.version_ordinal` (`smallint -> integer`)
- `video_timeline_events.start_ms` (`integer -> bigint`)
- `video_timeline_events.end_ms` (`integer -> bigint`)
- `video_frames.timestamp_ms` (`integer -> bigint`)
- `video_frames.byte_size` (`integer -> bigint`)

Live result:

- All affected tables currently had `0` rows.
- Permanent resolution: safe widening DB migration.

## String Alignment

Affected columns had `0` over-limit rows in live prechecks, including populated search-document fields:

- `evidence_search_documents.title` max length `87` vs schema `VARCHAR(200)`
- `evidence_search_documents.subtitle` max length `36` vs schema `VARCHAR(200)`
- `evidence_search_documents.summary` max length `87` vs schema `VARCHAR(400)`

Permanent resolution:

- DB migration for every true `text -> varchar(N)` drift where the live maximum proved safe.
- Exception: `evidence_exchange_package_builds.package_id` moved out of the string batch and into UUID alignment after code + migration review showed the canonical package identifier is a UUID.

## Nullability Hardening

All 64 `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` findings were prechecked and every one returned `NULL count = 0`.

Important semantic review:

- `redaction_approvals.approved_at_utc`
- `access_review_campaigns.starts_at_utc`
- `access_review_campaigns.ends_at_utc`

These were explicitly checked because they are timing-sensitive governance fields. Since live NULL count was zero, Phase 2B can safely harden them with `SET NOT NULL` without inventing historical/legal timestamps.

Permanent resolution:

- DB `SET NOT NULL` with migration-time guards that raise if NULLs appear.

## Enum Alignment

Confirmed text-backed enum candidates:

- `reports.last_verified_source_snapshot`
  - values: `REPORT_GENERATED`, `PUBLIC_VERIFY_VIEWED`, `NULL`
- `verification_views.verification_status_snapshot`
  - values: `NULL` only
- `teams.billing_plan`
  - values: `FREE`, `TEAM`
- `teams.billing_status`
  - values: `INACTIVE`, `CANCELED`
- `demo_requests.lead_quality`
  - values: `LOW`, `MEDIUM`, `NULL`
- `demo_requests.lead_track`
  - values: `DISCOVERY`, `SALES`, `NULL`
- `demo_requests.recommended_action`
  - values: `reply_with_resources`, `offer_demo`, `NULL`

Confirmed audit false positives:

- `workflow_review_decisions.stage`
- `workflow_review_decisions.decision`
- `workflow_review_decisions.reason_code`
- `mfa_pending_challenges.purpose`
- `mfa_recovery_requests.status`

Reason:

- The live DB already uses the correctly mapped enum UDT names.
- The audit script was comparing `udt_name` to the Prisma enum symbol instead of the enum `@@map(...)` database name.

Permanent resolution:

- DB enum migration for the real text-backed enum drifts.
- Audit-script fix for enum `@@map` handling.
- Add missing enum value `CustodyEventType.CAPTURE_TRUST_EVENT` safely.

## UUID / Identifier Alignment

Live UUID safety checks:

- `reviewer_ops_reminders.id` invalid UUID count = `0`
- `reviewer_ops_reminders.workflow_id` invalid UUID count = `0`
- `reviewer_ops_reminders.escalation_id` invalid UUID count = `0`
- `reviewer_ops_reminders.reviewer_user_id` invalid UUID count = `0`
- `evidence_exchange_package_builds.id` invalid UUID count = `0`

Empty-table directional checks:

- `step_up_challenges.resource_id` total rows = `0`
- `external_review_invitation_deliveries.bulk_batch_id` total rows = `0`
- `duplicate_decisions.id` total rows = `0`
- `duplicate_decisions.team_id` total rows = `0`
- `duplicate_decisions.edge_id` total rows = `0`
- `duplicate_decisions.decided_by_user_id` total rows = `0`

Permanent resolution decisions:

- DB migration:
  - `reviewer_ops_reminders.id`
  - `reviewer_ops_reminders.workflow_id`
  - `reviewer_ops_reminders.escalation_id`
  - `reviewer_ops_reminders.reviewer_user_id`
  - `evidence_exchange_package_builds.id`
  - `evidence_exchange_package_builds.package_id`
  - `step_up_challenges.resource_id` (`uuid -> varchar(128)`, because the service accepts bounded resource strings, not UUID-only ids)
- Schema correction:
  - `external_review_invitation_deliveries.bulk_batch_id` (UUID is canonical)
  - `duplicate_decisions.id`
  - `duplicate_decisions.team_id`
  - `duplicate_decisions.edge_id`
  - `duplicate_decisions.decided_by_user_id`

## JSON Semantic Repairs

Affected columns:

- `workspace_governance_policies.metadata_redaction_default`
- `cross_org_review_grants.scope`

Semantic review:

- `metadata_redaction_default` is supposed to be a JSON redaction-policy override object.
- `cross_org_review_grants.scope` is supposed to be JSON and the live service writes `{ text: ... }`.

Permanent resolution:

- `workspace_governance_policies.metadata_redaction_default`
  - Convert only when the boolean drift is effectively unused; raise for unexpected non-null boolean data rather than invent meaning.
- `cross_org_review_grants.scope`
  - Convert legacy string scope to JSON via `{ "text": <legacy string> }`.
