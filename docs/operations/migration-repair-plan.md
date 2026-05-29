# Migration Repair Plan — Phase O

This document does NOT modify any migration. It records the operator review surface produced by `services/api/scripts/full-migration-audit.mjs`.

## CRITICAL findings

Every migration below carries at least one CRITICAL finding. Treat each as requiring operator review BEFORE any production action.

### `20260201013040_align_schema`
- `ALTER_TABLE_DROP_COLUMN` (line 16) — DROP COLUMN is destructive and cannot be safely re-applied.
- `ALTER_TABLE_DROP_COLUMN` (line 22) — DROP COLUMN is destructive and cannot be safely re-applied.
- `DROP_INDEX` (line 13) — DROP INDEX risks production-read regressions.

_Tables touched_: (none detected)

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260201033040_fix_evidence_file_sha256_index`
- `DROP_INDEX` (line 3) — DROP INDEX risks production-read regressions.

_Tables touched_: (none detected)

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260201120000_update_evidence_signingkey`
- `ALTER_TABLE_DROP_COLUMN` (line 8) — DROP COLUMN is destructive and cannot be safely re-applied.
- `DROP_INDEX` (line 2) — DROP INDEX risks production-read regressions.
- `DROP_INDEX` (line 5) — DROP INDEX risks production-read regressions.

_Tables touched_: `evidence`, `signing_keys`

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260201133000_fix_evidence_file_sha256_index_v2`
- `DROP_INDEX` (line 3) — DROP INDEX risks production-read regressions.

_Tables touched_: (none detected)

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260204190000_add_auth_billing`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 55) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 68) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 78) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 91) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 106) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 122) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 137) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `cases`, `entitlements`, `evidence`, `payments`, `subscriptions`, `team_members`, `teams`, `users`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260205090000_phase2_invites_claim`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 28) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 41) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `evidence`, `guest_identities`, `team_invites`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260205093000_evidence_parts`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `evidence_parts`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260205100000_b2b_org_locking`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 23) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `case_access`, `evidence`, `teams`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260215095541_email_password_auth`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 19) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `password_reset_tokens`, `users`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260324120000_add_team_activity`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 2) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `team_activities`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260404180000_admin_audit_log`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 5) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `admin_audit_logs`, `users`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260407_add_legal_acceptance_and_cookie_consent`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 25) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `cookie_consent_records`, `user_legal_acceptances`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260418_report_snapshot_fields`
- `ALTER_TABLE_RENAME` (line 14) — RENAME breaks idempotency and Prisma client expectations during rolling deploys.
- `INDEX_COLUMN_RISK` (line 51) — Index reports_content_structure_snapshot_idx ON reports(content_structure_snapshot) references column(s) {content_structure_snapshot} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 54) — Index reports_primary_content_kind_snapshot_idx ON reports(primary_content_kind_snapshot) references column(s) {primary_content_kind_snapshot} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 57) — Index reports_item_count_snapshot_idx ON reports(item_count_snapshot) references column(s) {item_count_snapshot} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 60) — Index reports_recorded_integrity_verified_at_utc_snapshot_idx ON reports(recorded_integrity_verified_at_utc_snapshot) references column(s) {recorded_integrity_verified_at_utc_snapshot} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 63) — Index reports_last_verified_at_utc_snapshot_idx ON reports(last_verified_at_utc_snapshot) references column(s) {last_verified_at_utc_snapshot} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 66) — Index reports_reviewer_summary_version_idx ON reports(reviewer_summary_version) references column(s) {reviewer_summary_version} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 69) — Index reports_verification_package_version_idx ON reports(verification_package_version) references column(s) {verification_package_version} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `reports`

**Recommended action:**
- Verify every index column exists in production before re-deploy. Wrap CREATE INDEX in a `DO $$ ... END $$` block with an `information_schema.columns` existence check (Phase O-Final pattern).

### `20260510160000_phase_a_b_forensic_hardening`
- `ALTER_TABLE_DROP_COLUMN` (line 9) — DROP COLUMN is destructive and cannot be safely re-applied.
- `DROP_INDEX` (line 10) — DROP INDEX risks production-read regressions.

_Tables touched_: `evidence`

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260510200000_phase_c_hardening`
- `ALTER_TABLE_DROP_COLUMN` (line 7) — DROP COLUMN is destructive and cannot be safely re-applied.
- `ALTER_TABLE_DROP_COLUMN` (line 8) — DROP COLUMN is destructive and cannot be safely re-applied.

_Tables touched_: `evidence`

**Recommended action:**
- Operator review required. Document the production state of every affected table before any further action.

### `20260521100000_add_review_operations_phase13`
- `INDEX_COLUMN_RISK` (line 96) — Index evidence_review_workflows_sla_status_due_at_idx ON evidence_review_workflows(sla_status,due_at) references column(s) {sla_status,due_at} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 98) — Index evidence_review_workflows_escalation_level_status_idx ON evidence_review_workflows(escalation_level,status) references column(s) {escalation_level,status} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `evidence_review_workflows`

**Recommended action:**
- Verify every index column exists in production before re-deploy. Wrap CREATE INDEX in a `DO $$ ... END $$` block with an `information_schema.columns` existence check (Phase O-Final pattern).

### `20260523100000_add_governance_platform_phase14`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 93) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 79) — Index evidence_retention_until_utc_idx ON evidence(retention_until_utc) references column(s) {retention_until_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `case_legal_holds`, `evidence`, `workspace_governance_policies`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260524100000_add_intelligence_phase15`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 75) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 101) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 128) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 148) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 169) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `evidence_entities`, `evidence_extracted_texts`, `evidence_intelligence_jobs`, `evidence_semantic_chunks`, `evidence_similarities`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260525100000_add_collaboration_phase16`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 80) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 117) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 142) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 162) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `discussion_mentions`, `discussion_messages`, `discussion_participants`, `discussion_threads`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260526100000_add_identity_phase17`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 184) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 222) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 260) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 282) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 326) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 140) — Index team_members_team_id_status_idx ON team_members(team_id,status) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 142) — Index team_members_access_expires_at_utc_idx ON team_members(access_expires_at_utc) references column(s) {access_expires_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 158) — Index workflow_intake_sessions_last_seen_at_utc_idx ON workflow_intake_sessions(last_seen_at_utc) references column(s) {last_seen_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 177) — Index api_credentials_expires_at_utc_idx ON api_credentials(expires_at_utc) references column(s) {expires_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 179) — Index api_credentials_disabled_at_utc_idx ON api_credentials(disabled_at_utc) references column(s) {disabled_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `access_reviews`, `external_identity_mappings`, `member_capability_grants`, `member_delegated_admin_scopes`, `organization_security_policies`, `team_members`, `workflow_intake_sessions`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260527100000_add_communications_phase18`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 90) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 158) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 188) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `communication_messages`, `communication_preferences`, `verification_attempts`, `workflow_intake_sessions`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260528100000_add_identity_security_phase19`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 63) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 95) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 134) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 164) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `organization_security_policies`, `revoked_sessions`, `risk_signals`, `step_up_challenges`, `trusted_devices`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260529100000_add_operational_incidents_phase21`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 53) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 107) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `operational_incident_events`, `operational_incidents`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260530100000_add_workflow_engine_phase22`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 33) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 89) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 111) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 149) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 28) — Index evidence_workflow_templates_team_status_idx ON evidence_workflow_templates(team_id,status) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `evidence_workflow_instance_evidence`, `evidence_workflow_instances`, `evidence_workflow_step_instances`, `evidence_workflow_templates`, `evidence_workflow_visibility_decisions`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260531100000_add_search_discovery_phase24`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 19) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 91) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 86) — Index evidence_search_documents_searchable_text_trgm_idx ON evidence_search_documents(to_tsvector,COALESCE) references column(s) {to_tsvector,COALESCE} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `evidence_search_documents`, `saved_search_views`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260601100000_add_reviewer_operations_phase25`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 39) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 148) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 32) — Index evidence_review_workflows_completion_due_at_utc_idx ON evidence_review_workflows(completion_due_at_utc) references column(s) {completion_due_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `evidence_review_workflows`, `review_escalations`, `reviewer_workload_snapshots`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260602100000_phase25_5_reviewer_ops_hardening`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 49) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 39) — Index saved_search_views_team_scope_idx ON saved_search_views(team_id,scope) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 42) — Index saved_search_views_team_scope_visibility_idx ON saved_search_views(team_id,scope,visibility) references column(s) {team_id,visibility} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `reviewer_ops_reminders`, `saved_search_views`, `workspace_governance_policies`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260603100000_phase26_identity_governance`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 20) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 78) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 127) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `authenticated_sessions`, `scim_provisioning_tokens`, `sso_connections`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260604100000_phase26_5_identity_hardening`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 46) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 97) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 25) — Index sso_connections_outage_idx ON sso_connections(outage_detected_at_utc) references column(s) {outage_detected_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 37) — Index authenticated_sessions_team_heartbeat_idx ON authenticated_sessions(team_id,last_heartbeat_at_utc) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 39) — Index authenticated_sessions_team_risk_idx ON authenticated_sessions(team_id,risk_score) references column(s) {team_id,risk_score} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `authenticated_sessions`, `scim_groups`, `sso_callback_attempts`, `sso_connections`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260605100000_phase26_75_identity_runtime`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 49) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 26) — Index authenticated_sessions_team_quarantined_idx ON authenticated_sessions(team_id,quarantined_at_utc) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 28) — Index authenticated_sessions_team_recomputed_idx ON authenticated_sessions(team_id,last_risk_recomputed_at_utc) references column(s) {team_id,last_risk_recomputed_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 40) — Index trusted_devices_team_decay_idx ON trusted_devices(team_id,trust_score_decay) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 42) — Index trusted_devices_team_quarantined_idx ON trusted_devices(team_id,quarantined_at_utc) references column(s) {team_id,quarantined_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `authenticated_sessions`, `geo_intelligence_lookups`, `trusted_devices`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260606100000_phase27_retention_lifecycle`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 48) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 101) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 141) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 199) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 41) — Index evidence_retention_policy_version_idx ON evidence(retention_policy_version_id) references column(s) {retention_policy_version_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `destruction_reviews`, `evidence`, `evidence_lifecycle_events`, `evidence_retention_policies`, `evidence_retention_policy_versions`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260613100000_phase27_5_governance_operationalization`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 147) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 196) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 268) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 314) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 382) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `destruction_executions`, `governance_export_snapshots`, `governance_notifications`, `governance_reconciliation_runs`, `immutable_storage_checks`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260620100000_phase24_31_consolidated_drift_patches`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 93) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 165) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 592) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 795) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 858) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 956) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1066) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1178) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1366) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1499) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1630) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1688) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1749) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 1947) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 2053) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 2112) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 531) — Index saved_search_views_team_scope_idx ON saved_search_views(team_id,scope) references column(s) {team_id,scope} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 534) — Index saved_search_views_team_scope_visibility_idx ON saved_search_views(team_id,scope,visibility) references column(s) {team_id,scope,visibility} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 822) — Index evidence_ocr_text_uk ON evidence_ocr_text(evidence_id,COALESCE) references column(s) {COALESCE} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 889) — Index evidence_transcript_segments_uk ON evidence_transcript_segments(evidence_id,COALESCE) references column(s) {COALESCE} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 1239) — Index media_intelligence_signals_evidence_material_type_uk ON media_intelligence_signals(evidence_id,COALESCE) references column(s) {COALESCE} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 1937) — Index evidence_review_workflows_assignment_due_at_utc_idx ON evidence_review_workflows(assignment_due_at_utc) references column(s) {assignment_due_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 1940) — Index evidence_review_workflows_completion_due_at_utc_idx ON evidence_review_workflows(completion_due_at_utc) references column(s) {completion_due_at_utc} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `evidence_ocr_text`, `evidence_part_derived_assets`, `evidence_part_exif_summaries`, `evidence_search_documents`, `evidence_transcript_segments`, `evidence_upload_session_parts`, `evidence_upload_sessions`, `external_review_grants`, `investigation_graph_edges`, `investigation_graph_nodes`, `manual_relationships`, `media_intelligence_runs`, `media_intelligence_signals`, `review_escalations`, `reviewer_ops_reminders`, `reviewer_workload_snapshots`, `search_audit_logs`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260625100000_phase328cpppp_dashboard_intelligence_closure`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 56) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 133) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `access_anomalies`, `evidence_annotations`, `evidence_integrity_snapshots`, `evidence_reviewer_comments`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260626100000_phase328cppppp_structural_intelligence_closure`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 91) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 157) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 216) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 277) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 334) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `case_comments`, `case_evidence_links`, `evidence_integrity_snapshots`, `operational_timeline_events`, `queue_telemetry_snapshots`, `worker_telemetry_snapshots`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260627100000_phase328c_control_plane_closure`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 69) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `operational_correlations`, `operational_incidents`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260628100000_phase328c_workflow_causality`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 171) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 240) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 269) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 295) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 339) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `operational_causality_chains`, `operational_causality_links`, `operational_workflow_actions`, `operational_workflow_events`, `operational_workflows`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260629100000_phase328c_enterprise_gap_closure`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 99) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 134) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 175) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 204) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 232) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 257) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 283) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `bulk_operational_action_items`, `bulk_operational_action_runs`, `operational_graph_edges`, `operational_graph_nodes`, `organizational_health_snapshots`, `reviewer_capacity_snapshots`, `reviewer_routing_recommendations`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260630100000_phase328d_matter_workspace`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 111) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 148) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 175) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `INDEX_COLUMN_RISK` (line 98) — Index case_team_reference_number_uniq ON cases(team_id,reference_number) references column(s) {team_id,reference_number} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 102) — Index cases_team_id_status_idx ON cases(team_id,status) references column(s) {team_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.
- `INDEX_COLUMN_RISK` (line 104) — Index cases_team_id_priority_idx ON cases(team_id,priority) references column(s) {team_id,priority} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `case_assignments`, `case_risk_snapshots`, `case_status_history`, `cases`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260720100000_personal_workspace_bootstrap`
- `INDEX_COLUMN_RISK` (line 28) — Index teams_owner_personal_uniq ON teams(owner_user_id) references column(s) {owner_user_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: `teams`

**Recommended action:**
- Verify every index column exists in production before re-deploy. Wrap CREATE INDEX in a `DO $$ ... END $$` block with an `information_schema.columns` existence check (Phase O-Final pattern).

### `20260720200000_dashboard_projections`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 7) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 26) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `org_health_projections`, `reviewer_queue_projections`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260721000000_workspace_persona_profile`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 6) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `workspace_persona_profiles`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260925000000_phase0_schema_catchup`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 776) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 793) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 821) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 842) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 862) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `CREATE_TABLE_IF_NOT_EXISTS` (line 887) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.
- `ALTER_TABLE_DROP_COLUMN` (line 460) — DROP COLUMN is destructive and cannot be safely re-applied.
- `ALTER_TABLE_DROP_COLUMN` (line 590) — DROP COLUMN is destructive and cannot be safely re-applied.
- `ALTER_TABLE_DROP_COLUMN` (line 617) — DROP COLUMN is destructive and cannot be safely re-applied.
- `ALTER_TABLE_DROP_COLUMN` (line 682) — DROP COLUMN is destructive and cannot be safely re-applied.

_Tables touched_: `access_reviews`, `cases`, `demo_requests`, `destruction_reviews`, `evidence_ai_categorizations`, `evidence_anchors`, `evidence_certifications`, `evidence_relationships`, `member_capability_grants`, `reports`, `review_escalations`, `sso_callback_attempts`, `sso_connections`, `step_up_challenges`, `teams`, `trusted_devices`, `verification_packages`, `verification_views`, `workspace_storage_addons`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

### `20260927000000_p2_7x_stage6_invite_token_hash`
- `SET_NOT_NULL_NO_READINESS` (line 54) — SET NOT NULL without a readiness marker risks rejecting NULL rows from production.

_Tables touched_: `organization_invites`

**Recommended action:**
- Confirm the column has been backfilled to 100% non-NULL before SET NOT NULL runs. Add a readiness-marker comment OR wrap in a DO block that verifies via SELECT COUNT(*) ... WHERE col IS NULL = 0.

### `20260928000000_p2_7x_stage6_teams_org_not_null`
- `SET_NOT_NULL_NO_READINESS` (line 29) — SET NOT NULL without a readiness marker risks rejecting NULL rows from production.

_Tables touched_: (none detected)

**Recommended action:**
- Confirm the column has been backfilled to 100% non-NULL before SET NOT NULL runs. Add a readiness-marker comment OR wrap in a DO block that verifies via SELECT COUNT(*) ... WHERE col IS NULL = 0.

### `20261001000000_phase_a1_evidence_org_tenancy`
- `INDEX_COLUMN_RISK` (line 128) — Index evidence_team_id_organization_id_idx ON evidence(team_id,organization_id) references column(s) {team_id,organization_id} not added or guarded by this migration. Same failure class as 'mentioned_user_id does not exist'.

_Tables touched_: (none detected)

**Recommended action:**
- Verify every index column exists in production before re-deploy. Wrap CREATE INDEX in a `DO $$ ... END $$` block with an `information_schema.columns` existence check (Phase O-Final pattern).

### `email_password_auth`
- `CREATE_TABLE_IF_NOT_EXISTS` (line 19) — CREATE TABLE IF NOT EXISTS silently skips the entire block when the table already exists, hiding missed column evolution. This is the root cause of the Phase O-Final `discussion_mentions.team_id` failure.

_Tables touched_: `password_reset_tokens`, `users`

**Recommended action:**
- Confirm the table shape in production matches Prisma's expectations via `full-production-schema-audit.mjs`. If drift is present, author an additive repair migration (ADD COLUMN IF NOT EXISTS + deterministic backfill, Phase O-Final pattern).

## HIGH findings
### `20260131235343_init`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 88) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 91) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 94) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 97) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 100) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 103) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 106) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 109) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 112) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 115) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 118) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 121) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 124) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 127) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 130) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 133) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260201120000_phase9_hardening`
- `ALTER_TYPE` (line 9) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 17) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 25) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 9) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 17) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 25) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260201124500_add_document_evidence_type`
- `ALTER_TYPE` (line 9) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 9) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260201132000_add_evidence_locked_event`
- `ALTER_TYPE` (line 9) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 9) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260321000000_expand_user_country_field`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 18) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.

### `20260321110000_add_evidence_archive_field`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 7) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 10) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 11) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260404193000_add_analytics_tables`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 37) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 40) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 43) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 46) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 49) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 52) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 55) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260430_add_tsa_input_digest_fields`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 2) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 3) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.

### `20260504150000_add_evidence_internal_notes`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 2) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.

### `20260504170000_add_capture_plan_and_part_metadata`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 2) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 5) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 8) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 11) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 14) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 17) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.

### `20260508133000_add_evidence_operations_workspace_features`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 104) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 106) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 108) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 111) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 113) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 115) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 118) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 120) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 122) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 125) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 127) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 129) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 131) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 134) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 136) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 138) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260508153000_add_evidence_review_workflow_relationships_audit`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 140) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 142) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 144) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 146) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 148) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 150) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 152) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 155) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 157) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 159) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 161) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 164) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 166) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 168) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 170) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 172) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 175) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 177) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 179) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260510120000_add_capture_sessions`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 55) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 57) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 59) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 61) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 63) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 78) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 80) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260516120000_add_workflow_template_foundation`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 41) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 43) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 81) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 83) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 85) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 87) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 97) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 101) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260516180000_add_workflow_intake_links_phase4`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 113) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 115) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 117) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 119) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 121) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 123) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 172) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 174) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 176) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 178) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 180) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 182) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `ALTER_TYPE` (line 50) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 51) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 52) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 54) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 50) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 51) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 52) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 54) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260516220000_add_evidence_requests_phase7`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 135) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 137) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 139) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 141) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 143) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 145) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 147) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 149) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 151) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 180) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 182) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 218) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 220) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 222) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 224) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 244) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 246) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260517020000_add_notification_deliveries_phase8`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 86) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 88) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 90) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 92) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 94) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 96) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 98) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260517060000_add_notification_template_context`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 16) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.

### `20260517100000_add_governance_phase9`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 68) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 102) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 104) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 106) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 108) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `ALTER_TYPE` (line 34) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 35) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 36) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 37) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 38) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 34) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 35) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 36) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 37) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 38) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260517140000_add_integrations_phase10`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 26) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 69) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 71) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 73) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 106) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 133) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 135) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 137) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 139) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 141) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260518100000_add_integrations_phase10_5`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 29) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 31) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 33) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260519100000_add_security_hardening_phase11`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 52) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 54) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 56) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 73) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 75) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 77) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 79) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260520100000_add_reliability_phase12`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 57) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 59) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 61) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260722000000_r8_1_mfa_activation`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 46) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 48) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 75) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 77) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 79) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260724000000_r8_1_3_mfa_pending_challenges`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 42) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 46) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 48) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260725000000_r8_1_4_mfa_recovery_requests`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 45) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 47) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 49) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 74) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 76) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260726000000_r8_1_5_recovery_email_preflight`
- `ALTER_TYPE` (line 17) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 18) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 19) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 17) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 18) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 19) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20260727000000_r8_1_6_recovery_digest_logs`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 18) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 21) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260728000000_r8_1_7_digest_preferences`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 29) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 31) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 58) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 60) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260801000000_phase_e3_automation_foundation`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 73) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 74) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 76) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 122) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 125) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 127) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 129) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260802000000_phase_e3_2_webhook_delivery`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 80) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 83) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 137) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 140) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 142) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 144) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260803000000_phase_e3_3_async_delivery_runtime`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 45) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 46) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 47) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 51) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 58) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260804000000_phase_e10_1_stripe_webhook_idempotency`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 36) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 38) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 39) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260926000000_p2_7x_stage1_org_model_additive`
- `ADD_COLUMN_NO_IF_NOT_EXISTS` (line 41) — ADD COLUMN without IF NOT EXISTS is not idempotent. Re-running the migration after a partial failure breaks.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 120) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 123) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 126) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 129) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 132) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 135) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 138) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 141) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 144) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 147) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260929000000_phase_b2_workflow_review_decisions`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 73) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 76) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 79) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 82) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20260930000000_phase_a0_integrity_hard_gate`
- `ALTER_TYPE` (line 22) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 23) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 22) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 23) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20261002000000_phase_a2_pdf_artifact_status`
- `ALTER_TYPE` (line 43) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ALTER_TYPE` (line 44) — ALTER TYPE on an enum requires consideration for in-flight transactions and dependent columns.
- `ENUM_ADD_VALUE` (line 43) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.
- `ENUM_ADD_VALUE` (line 44) — ALTER TYPE ... ADD VALUE cannot run inside a transaction in older PostgreSQL; verify deploy mode.

### `20261003000000_phase_g3_1_notification_preferences`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 45) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 54) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 57) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20261004000000_phase_m3_1_siu_durability`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 45) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 48) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 50) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 52) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 54) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 56) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 81) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 83) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 85) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 117) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 119) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 121) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 150) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 152) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 154) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 190) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 192) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 194) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

### `20261005000000_phase_m3_2_siu_governance_export`
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 33) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 36) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 38) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 40) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.
- `CREATE_INDEX_NO_IF_NOT_EXISTS` (line 42) — CREATE INDEX without IF NOT EXISTS is not idempotent. Re-running fails on the second attempt.

## Prisma compatibility issues

| Migration | Table | Column | Detail |
| --- | --- | --- | --- |
| `20260131235343_init` | `evidence` | `device_time_utc` | Migration ADDs column evidence.device_time_utc but Prisma model Evidence no longer references it. |
| `20260131235343_init` | `evidence` | `timezone_offset_min` | Migration ADDs column evidence.timezone_offset_min but Prisma model Evidence no longer references it. |
| `20260131235343_init` | `custody_events` | `actor_type` | Migration ADDs column custody_events.actor_type but Prisma model CustodyEvent no longer references it. |
| `20260131235343_init` | `custody_events` | `actor_id` | Migration ADDs column custody_events.actor_id but Prisma model CustodyEvent no longer references it. |
| `20260131235343_init` | `reports` | `report_sha256` | Migration ADDs column reports.report_sha256 but Prisma model Report no longer references it. |
| `20260131235343_init` | `reports` | `created_at` | Migration ADDs column reports.created_at but Prisma model Report no longer references it. |
| `20260215095541_email_password_auth` | `password_reset_tokens` | `ON` | Migration ADDs column password_reset_tokens.ON but Prisma model PasswordResetToken no longer references it. |
| `20260407_add_legal_acceptance_and_cookie_consent` | `user_legal_acceptances` | `ON` | Migration ADDs column user_legal_acceptances.ON but Prisma model UserLegalAcceptance no longer references it. |
| `20260407_add_legal_acceptance_and_cookie_consent` | `cookie_consent_records` | `ON` | Migration ADDs column cookie_consent_records.ON but Prisma model CookieConsentRecord no longer references it. |
| `20260510120000_add_capture_sessions` | `capture_session_events` | `ON` | Migration ADDs column capture_session_events.ON but Prisma model CaptureSessionEvent no longer references it. |
| `20260516120000_add_workflow_template_foundation` | `evidence_workflow_templates` | `intake_modes` | Migration ADDs column evidence_workflow_templates.intake_modes but Prisma model EvidenceWorkflowTemplate no longer references it. |
| `20260516120000_add_workflow_template_foundation` | `evidence_workflow_templates` | `allowed_roles` | Migration ADDs column evidence_workflow_templates.allowed_roles but Prisma model EvidenceWorkflowTemplate no longer references it. |
| `20260516120000_add_workflow_template_foundation` | `evidence_workflow_templates` | `ON` | Migration ADDs column evidence_workflow_templates.ON but Prisma model EvidenceWorkflowTemplate no longer references it. |
| `20260516180000_add_workflow_intake_links_phase4` | `workflow_intake_links` | `allowed_accepted_kinds` | Migration ADDs column workflow_intake_links.allowed_accepted_kinds but Prisma model WorkflowIntakeLink no longer references it. |
| `20260516180000_add_workflow_intake_links_phase4` | `workflow_intake_links` | `ip_allowlist_cidrs` | Migration ADDs column workflow_intake_links.ip_allowlist_cidrs but Prisma model WorkflowIntakeLink no longer references it. |
| `20260516180000_add_workflow_intake_links_phase4` | `workflow_intake_links` | `ON` | Migration ADDs column workflow_intake_links.ON but Prisma model WorkflowIntakeLink no longer references it. |
| `20260516180000_add_workflow_intake_links_phase4` | `workflow_intake_sessions` | `ON` | Migration ADDs column workflow_intake_sessions.ON but Prisma model WorkflowIntakeSession no longer references it. |
| `20260516220000_add_evidence_requests_phase7` | `evidence_requests` | `ON` | Migration ADDs column evidence_requests.ON but Prisma model EvidenceRequest no longer references it. |
| `20260516220000_add_evidence_requests_phase7` | `evidence_request_deliverables` | `accepted_kinds` | Migration ADDs column evidence_request_deliverables.accepted_kinds but Prisma model EvidenceRequestDeliverable no longer references it. |
| `20260516220000_add_evidence_requests_phase7` | `evidence_request_deliverables` | `ON` | Migration ADDs column evidence_request_deliverables.ON but Prisma model EvidenceRequestDeliverable no longer references it. |
| `20260516220000_add_evidence_requests_phase7` | `evidence_request_responses` | `ON` | Migration ADDs column evidence_request_responses.ON but Prisma model EvidenceRequestResponse no longer references it. |
| `20260516220000_add_evidence_requests_phase7` | `evidence_request_events` | `ON` | Migration ADDs column evidence_request_events.ON but Prisma model EvidenceRequestEvent no longer references it. |
| `20260517020000_add_notification_deliveries_phase8` | `notification_deliveries` | `ON` | Migration ADDs column notification_deliveries.ON but Prisma model NotificationDelivery no longer references it. |
| `20260517100000_add_governance_phase9` | `workspace_governance_policies` | `ON` | Migration ADDs column workspace_governance_policies.ON but Prisma model WorkspaceGovernancePolicy no longer references it. |
| `20260517100000_add_governance_phase9` | `evidence_legal_holds` | `ON` | Migration ADDs column evidence_legal_holds.ON but Prisma model EvidenceLegalHold no longer references it. |
| `20260517140000_add_integrations_phase10` | `api_credentials` | `scopes` | Migration ADDs column api_credentials.scopes but Prisma model ApiCredential no longer references it. |
| `20260517140000_add_integrations_phase10` | `api_credentials` | `ON` | Migration ADDs column api_credentials.ON but Prisma model ApiCredential no longer references it. |
| `20260517140000_add_integrations_phase10` | `integration_webhook_endpoints` | `event_types` | Migration ADDs column integration_webhook_endpoints.event_types but Prisma model WebhookEndpoint no longer references it. |
| `20260517140000_add_integrations_phase10` | `integration_webhook_endpoints` | `ON` | Migration ADDs column integration_webhook_endpoints.ON but Prisma model WebhookEndpoint no longer references it. |
| `20260517140000_add_integrations_phase10` | `integration_webhook_deliveries` | `ON` | Migration ADDs column integration_webhook_deliveries.ON but Prisma model IntegrationWebhookDelivery no longer references it. |
| `20260518100000_add_integrations_phase10_5` | `api_credential_usage_logs` | `ON` | Migration ADDs column api_credential_usage_logs.ON but Prisma model ApiCredentialUsageLog no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `file_security_scans` | `ON` | Migration ADDs column file_security_scans.ON but Prisma model FileSecurityScan no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `team_id` | Migration ADDs column security_events.team_id but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `event_type` | Migration ADDs column security_events.event_type but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `evidence_id` | Migration ADDs column security_events.evidence_id but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `api_credential_id` | Migration ADDs column security_events.api_credential_id but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `webhook_endpoint_id` | Migration ADDs column security_events.webhook_endpoint_id but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `details` | Migration ADDs column security_events.details but Prisma model SecurityEvent no longer references it. |
| `20260519100000_add_security_hardening_phase11` | `security_events` | `created_at` | Migration ADDs column security_events.created_at but Prisma model SecurityEvent no longer references it. |
| `20260520100000_add_reliability_phase12` | `upload_sessions` | `ON` | Migration ADDs column upload_sessions.ON but Prisma model UploadSession no longer references it. |
| `20260523100000_add_governance_platform_phase14` | `case_legal_holds` | `ON` | Migration ADDs column case_legal_holds.ON but Prisma model CaseLegalHold no longer references it. |
| `20260524100000_add_intelligence_phase15` | `evidence_intelligence_jobs` | `ON` | Migration ADDs column evidence_intelligence_jobs.ON but Prisma model EvidenceIntelligenceJob no longer references it. |
| `20260524100000_add_intelligence_phase15` | `evidence_extracted_texts` | `ON` | Migration ADDs column evidence_extracted_texts.ON but Prisma model EvidenceExtractedText no longer references it. |
| `20260524100000_add_intelligence_phase15` | `evidence_entities` | `ON` | Migration ADDs column evidence_entities.ON but Prisma model EvidenceEntity no longer references it. |
| `20260524100000_add_intelligence_phase15` | `evidence_semantic_chunks` | `ON` | Migration ADDs column evidence_semantic_chunks.ON but Prisma model EvidenceSemanticChunk no longer references it. |
| `20260524100000_add_intelligence_phase15` | `evidence_similarities` | `ON` | Migration ADDs column evidence_similarities.ON but Prisma model EvidenceSimilarity no longer references it. |
| `20260525100000_add_collaboration_phase16` | `discussion_threads` | `ON` | Migration ADDs column discussion_threads.ON but Prisma model DiscussionThread no longer references it. |
| `20260525100000_add_collaboration_phase16` | `discussion_messages` | `ON` | Migration ADDs column discussion_messages.ON but Prisma model DiscussionMessage no longer references it. |
| `20260525100000_add_collaboration_phase16` | `discussion_mentions` | `ON` | Migration ADDs column discussion_mentions.ON but Prisma model DiscussionMention no longer references it. |
| `20260525100000_add_collaboration_phase16` | `discussion_participants` | `ON` | Migration ADDs column discussion_participants.ON but Prisma model DiscussionParticipant no longer references it. |
| `20260526100000_add_identity_phase17` | `organization_security_policies` | `allowed_email_domains` | Migration ADDs column organization_security_policies.allowed_email_domains but Prisma model OrganizationSecurityPolicy no longer references it. |
| `20260526100000_add_identity_phase17` | `organization_security_policies` | `restricted_ip_ranges` | Migration ADDs column organization_security_policies.restricted_ip_ranges but Prisma model OrganizationSecurityPolicy no longer references it. |
| `20260603100000_phase26_identity_governance` | `sso_connections` | `allowed_email_domains` | Migration ADDs column sso_connections.allowed_email_domains but Prisma model SsoConnection no longer references it. |
| `20260603100000_phase26_identity_governance` | `scim_provisioning_tokens` | `scopes` | Migration ADDs column scim_provisioning_tokens.scopes but Prisma model ScimProvisioningToken no longer references it. |
| `20260603100000_phase26_identity_governance` | `scim_provisioning_tokens` | `ip_allowlist` | Migration ADDs column scim_provisioning_tokens.ip_allowlist but Prisma model ScimProvisioningToken no longer references it. |
| `20260613100000_phase27_5_governance_operationalization` | `governance_notifications` | `channels` | Migration ADDs column governance_notifications.channels but Prisma model GovernanceNotification no longer references it. |
| `20260613100000_phase27_5_governance_operationalization` | `governance_notifications` | `recipient_user_ids` | Migration ADDs column governance_notifications.recipient_user_ids but Prisma model GovernanceNotification no longer references it. |
| `20260613100000_phase27_5_governance_operationalization` | `governance_export_snapshots` | `active_hold_ids` | Migration ADDs column governance_export_snapshots.active_hold_ids but Prisma model GovernanceExportSnapshot no longer references it. |
| `20260613100000_phase27_5_governance_operationalization` | `governance_export_snapshots` | `governance_incident_ids` | Migration ADDs column governance_export_snapshots.governance_incident_ids but Prisma model GovernanceExportSnapshot no longer references it. |
| `20260620100000_phase24_31_consolidated_drift_patches` | `evidence_search_documents` | `tsv` | Migration ADDs column evidence_search_documents.tsv but Prisma model EvidenceSearchDocument no longer references it. |
| `20260620100000_phase24_31_consolidated_drift_patches` | `evidence_search_documents` | `embedding` | Migration ADDs column evidence_search_documents.embedding but Prisma model EvidenceSearchDocument no longer references it. |
| `20260625100000_phase328cpppp_dashboard_intelligence_closure` | `evidence_integrity_snapshots` | `ON` | Migration ADDs column evidence_integrity_snapshots.ON but Prisma model EvidenceIntegritySnapshot no longer references it. |
| `20260625100000_phase328cpppp_dashboard_intelligence_closure` | `access_anomalies` | `ON` | Migration ADDs column access_anomalies.ON but Prisma model AccessAnomaly no longer references it. |
| `20260626100000_phase328cppppp_structural_intelligence_closure` | `queue_telemetry_snapshots` | `ON` | Migration ADDs column queue_telemetry_snapshots.ON but Prisma model QueueTelemetrySnapshot no longer references it. |
| `20260628100000_phase328c_workflow_causality` | `operational_workflow_events` | `ON` | Migration ADDs column operational_workflow_events.ON but Prisma model OperationalWorkflowEvent no longer references it. |
| `20260628100000_phase328c_workflow_causality` | `operational_workflow_actions` | `ON` | Migration ADDs column operational_workflow_actions.ON but Prisma model OperationalWorkflowAction no longer references it. |
| `20260629100000_phase328c_enterprise_gap_closure` | `bulk_operational_action_items` | `ON` | Migration ADDs column bulk_operational_action_items.ON but Prisma model BulkOperationalActionItem no longer references it. |
| `20260630100000_phase328d_matter_workspace` | `case_assignments` | `ON` | Migration ADDs column case_assignments.ON but Prisma model CaseAssignment no longer references it. |
| `20260630100000_phase328d_matter_workspace` | `case_status_history` | `from_status` | Migration ADDs column case_status_history.from_status but Prisma model CaseStatusHistory no longer references it. |
| `20260630100000_phase328d_matter_workspace` | `case_status_history` | `to_status` | Migration ADDs column case_status_history.to_status but Prisma model CaseStatusHistory no longer references it. |
| `20260630100000_phase328d_matter_workspace` | `case_status_history` | `ON` | Migration ADDs column case_status_history.ON but Prisma model CaseStatusHistory no longer references it. |
| `20260630100000_phase328d_matter_workspace` | `case_risk_snapshots` | `ON` | Migration ADDs column case_risk_snapshots.ON but Prisma model CaseRiskSnapshot no longer references it. |
| `20260726000000_r8_1_5_recovery_email_preflight` | `mfa_recovery_requests` | `mfa_enforcement_fail_mode` | Migration ADDs column mfa_recovery_requests.mfa_enforcement_fail_mode but Prisma model MfaRecoveryRequest no longer references it. |
| `20260803000000_phase_e3_3_async_delivery_runtime` | `automation_webhook_deliveries` | `consecutive_failure_count` | Migration ADDs column automation_webhook_deliveries.consecutive_failure_count but Prisma model AutomationWebhookDelivery no longer references it. |
| `20260925000000_phase0_schema_catchup` | `access_reviews` | `fromStatus` | Migration ADDs column access_reviews.fromStatus but Prisma model AccessReview no longer references it. |
| `20260925000000_phase0_schema_catchup` | `cases` | `event_hash` | Migration ADDs column cases.event_hash but Prisma model Case no longer references it. |
| `20260925000000_phase0_schema_catchup` | `destruction_reviews` | `capture_method` | Migration ADDs column destruction_reviews.capture_method but Prisma model DestructionReview no longer references it. |
| `20260925000000_phase0_schema_catchup` | `evidence_ai_categorizations` | `original_file_name` | Migration ADDs column evidence_ai_categorizations.original_file_name but Prisma model EvidenceAiCategorization no longer references it. |
| `20260925000000_phase0_schema_catchup` | `evidence_relationships` | `eventTypes` | Migration ADDs column evidence_relationships.eventTypes but Prisma model EvidenceRelationship no longer references it. |
| `20260925000000_phase0_schema_catchup` | `review_escalations` | `createdAtUtc` | Migration ADDs column review_escalations.createdAtUtc but Prisma model ReviewEscalation no longer references it. |
| `20260925000000_phase0_schema_catchup` | `trusted_devices` | `avatar_url` | Migration ADDs column trusted_devices.avatar_url but Prisma model TrustedDevice no longer references it. |
| `email_password_auth` | `password_reset_tokens` | `ON` | Migration ADDs column password_reset_tokens.ON but Prisma model PasswordResetToken no longer references it. |

## Naming drift (camelCase quoted identifiers)

| Migration | Identifier | snake_case form |
| --- | --- | --- |
| `20260404193000_add_analytics_tables` | `eventType` | `event_type` |
| `20260404193000_add_analytics_tables` | `userId` | `user_id` |
| `20260404193000_add_analytics_tables` | `sessionId` | `session_id` |
| `20260404193000_add_analytics_tables` | `visitorId` | `visitor_id` |
| `20260404193000_add_analytics_tables` | `createdAt` | `created_at` |
| `20260404193000_add_analytics_tables` | `startedAt` | `started_at` |
| `20260404193000_add_analytics_tables` | `lastSeenAt` | `last_seen_at` |
| `20260404213000_analytics_admin_audit_hardening` | `createdAt` | `created_at` |
| `20260404213000_analytics_admin_audit_hardening` | `startedAt` | `started_at` |
| `20260620200000_reviewer_ops_naming_drift_repair` | `safeSummary` | `safe_summary` |
| `20260620200000_reviewer_ops_naming_drift_repair` | `resolutionNote` | `resolution_note` |
| `20260620200000_reviewer_ops_naming_drift_repair` | `safeNote` | `safe_note` |
| `20260620200000_reviewer_ops_naming_drift_repair` | `dedupKey` | `dedup_key` |
| `20260620300000_team_billing_naming_drift_repair` | `billingPlan` | `billing_plan` |
| `20260620300000_team_billing_naming_drift_repair` | `billingStatus` | `billing_status` |
| `20260620300000_team_billing_naming_drift_repair` | `includedSeats` | `included_seats` |
| `20260620300000_team_billing_naming_drift_repair` | `overSeatLimit` | `over_seat_limit` |
| `20260925000000_phase0_schema_catchup` | `fromStatus` | `from_status` |
| `20260925000000_phase0_schema_catchup` | `toStatus` | `to_status` |
| `20260925000000_phase0_schema_catchup` | `eventTypes` | `event_types` |
| `20260925000000_phase0_schema_catchup` | `createdAtUtc` | `created_at_utc` |
| `20260925000000_phase0_schema_catchup` | `eventType` | `event_type` |
| `20260925000000_phase0_schema_catchup` | `ipAddressHash` | `ip_address_hash` |
| `20260925000000_phase0_schema_catchup` | `metadataJson` | `metadata_json` |
| `20260925000000_phase0_schema_catchup` | `requestId` | `request_id` |
| `20260925000000_phase0_schema_catchup` | `teamId` | `team_id` |
| `20260925000000_phase0_schema_catchup` | `userAgent` | `user_agent` |
| `20260925000000_phase0_schema_catchup` | `userId` | `user_id` |

## Required tests
- `services/api/test/phase-o-migration-safety-gate.test.ts` — CI gate that fails any NEW migration added after the configured baseline timestamp if it introduces a CRITICAL pattern.
- `services/api/test/phase-o-final-schema-repair.test.ts` — index column-safety + production-variant coverage tests (Phase O-Final).
- `services/api/test/phase-o-final-plus-full-schema-audit.test.ts` — Prisma↔Neon audit script contract (Phase O-Final+).

## Required production validation
1. Run `services/api/scripts/full-production-schema-audit.mjs` against production with the production `DATABASE_URL`.
2. For every UNSAFE migration listed above, verify against production that the table/column shape Prisma expects is actually present. If not, author an additive repair migration following the Phase O-Final pattern.
3. Take a Neon snapshot BEFORE running any repair migration. Apply via `services/api/scripts/safe-migrate.mjs deploy --allow-remote`.