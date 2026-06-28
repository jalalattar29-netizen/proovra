# Phase 2B High Schema Drift Plan

## Executive Summary

- Audit source: live read-only `full-production-schema-audit.mjs --json` run against the current Neon target on 2026-06-27.
- Phase 2A recap: production is at 240/240 expected tables, 3499/3499 expected columns, CRITICAL 0, HIGH 142, LOW 79.
- Scope here: HIGH findings only (TYPE_MISMATCH, NULLABLE_DB_NULLABLE_PRISMA_REQUIRED, MISSING_ENUM_VALUE).
- Classification totals: A 9, B 29, C 7, D 20, E 64, F 2, G 11, H 0, I 0, J 0.
- Recommended for automatic Phase 2B repair after standard prechecks: 45.
- Findings requiring live value/null audit before any repair: 126.
- Deferred/manual-review findings: 13.

## Category Legend

- A: Safe timestamp repair
- B: Safe varchar/text alignment
- C: Safe integer widening
- D: Enum alignment candidate
- E: Required nullability candidate
- F: JSON/boolean/object mismatch
- G: UUID/text mismatch
- H: Schema likely wrong
- I: Defer / disabled feature
- J: Dangerous manual review

## Full HIGH Findings Classification Table

| # | table | column/object | model.field | finding type | DB actual type/nullability | Prisma expected type/nullability | code usage summary | category | proposed permanent action | data-loss risk | requires backfill? | requires value audit? | include in Phase 2B execution? | reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `reports` | `last_verified_source_snapshot` | `Report.lastVerifiedSourceSnapshot` | `TYPE_MISMATCH` | text / text | USER-DEFINED | no direct prisma.<model>.<field> hit | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 2 | `reports` | `last_verified_source_snapshot` | `Report.lastVerifiedSourceSnapshot` | `TYPE_MISMATCH` | udt=text | enum:VerificationSource | no direct prisma.<model>.<field> hit | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 3 | `verification_views` | `verification_status_snapshot` | `VerificationView.verificationStatusSnapshot` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/evidence.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 4 | `verification_views` | `verification_status_snapshot` | `VerificationView.verificationStatusSnapshot` | `TYPE_MISMATCH` | udt=text | enum:VerificationStatus | services/api/src/routes/evidence.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 5 | `teams` | `billing_plan` | `Team.billingPlan` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/analytics-operations.routes.ts; services/api/src/routes/analytics.routes.ts; services/api/src/routes/automation-webhooks.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 6 | `teams` | `billing_plan` | `Team.billingPlan` | `TYPE_MISMATCH` | udt=text | enum:PlanType | services/api/src/routes/analytics-operations.routes.ts; services/api/src/routes/analytics.routes.ts; services/api/src/routes/automation-webhooks.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 7 | `teams` | `billing_status` | `Team.billingStatus` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/analytics.routes.ts; services/api/src/routes/evidence.routes.ts; services/api/src/routes/organizations-governance.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 8 | `teams` | `billing_status` | `Team.billingStatus` | `TYPE_MISMATCH` | udt=text | enum:TeamBillingStatus | services/api/src/routes/analytics.routes.ts; services/api/src/routes/evidence.routes.ts; services/api/src/routes/organizations-governance.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 9 | `evidence_saved_views` | `owner_user_id` | `EvidenceSavedView.ownerUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/evidence.saved-views.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 10 | `evidence_saved_views` | `name` | `EvidenceSavedView.name` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/evidence.saved-views.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 11 | `evidence_saved_views` | `filters_json` | `EvidenceSavedView.filtersJson` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/evidence.saved-views.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 12 | `evidence_saved_views` | `scope` | `EvidenceSavedView.scope` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/evidence.saved-views.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 13 | `evidence_saved_views` | `updated_at` | `EvidenceSavedView.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/evidence.saved-views.routes.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 14 | `evidence_saved_views` | `updated_at` | `EvidenceSavedView.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/evidence.saved-views.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 15 | `workflow_review_decisions` | `stage` | `WorkflowReviewDecision.stage` | `TYPE_MISMATCH` | udt=workflow_review_stage | enum:WorkflowReviewStage | services/api/src/routes/me-inbox.routes.ts; services/api/src/routes/reviewer-ops.routes.ts; services/api/src/services/reviewer-workspace/reviewer-metrics.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 16 | `workflow_review_decisions` | `decision` | `WorkflowReviewDecision.decision` | `TYPE_MISMATCH` | udt=workflow_review_decision_kind | enum:WorkflowReviewDecisionKind | services/api/src/routes/me-inbox.routes.ts; services/api/src/routes/reviewer-ops.routes.ts; services/api/src/services/governance/policy-evaluation.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 17 | `workflow_review_decisions` | `reason_code` | `WorkflowReviewDecision.reasonCode` | `TYPE_MISMATCH` | udt=workflow_review_reason_code | enum:WorkflowReviewReasonCode | services/api/src/routes/me-inbox.routes.ts; services/api/src/routes/reviewer-ops.routes.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 18 | `demo_requests` | `lead_quality` | `DemoRequest.leadQuality` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 19 | `demo_requests` | `lead_quality` | `DemoRequest.leadQuality` | `TYPE_MISMATCH` | udt=text | enum:DemoLeadQuality | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 20 | `demo_requests` | `lead_track` | `DemoRequest.leadTrack` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 21 | `demo_requests` | `lead_track` | `DemoRequest.leadTrack` | `TYPE_MISMATCH` | udt=text | enum:DemoLeadTrack | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 22 | `demo_requests` | `recommended_action` | `DemoRequest.recommendedAction` | `TYPE_MISMATCH` | text / text | USER-DEFINED | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 23 | `demo_requests` | `recommended_action` | `DemoRequest.recommendedAction` | `TYPE_MISMATCH` | udt=text | enum:DemoRecommendedAction | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 24 | `demo_requests` | `follow_up_status` | `DemoRequest.followUpStatus` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 25 | `demo_requests` | `follow_up_step` | `DemoRequest.followUpStep` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/admin-demo-requests.routes.ts; services/api/src/services/demo-follow-up.service.ts; services/api/src/services/demo-request.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 26 | `notification_deliveries` | `event_type` | `NotificationDelivery.eventType` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 27 | `notification_deliveries` | `recipient` | `NotificationDelivery.recipient` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 28 | `notification_deliveries` | `recipient_name` | `NotificationDelivery.recipientName` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 29 | `notification_deliveries` | `subject` | `NotificationDelivery.subject` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 30 | `notification_deliveries` | `template_key` | `NotificationDelivery.templateKey` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 31 | `notification_deliveries` | `rendered_preview` | `NotificationDelivery.renderedPreview` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 32 | `notification_deliveries` | `provider_message_id` | `NotificationDelivery.providerMessageId` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 33 | `notification_deliveries` | `error_code` | `NotificationDelivery.errorCode` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 34 | `notification_deliveries` | `error_message` | `NotificationDelivery.errorMessage` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 35 | `workspace_governance_policies` | `metadata_redaction_default` | `WorkspaceGovernancePolicy.metadataRedactionDefault` | `TYPE_MISMATCH` | boolean / bool | jsonb / json | no direct prisma.<model>.<field> hit | **F** | Treat as semantic mismatch; inspect stored shape and decide whether DB or schema is canonical before any migration. | high | no | yes | no | JSON/object vs scalar mismatch changes meaning, not just storage type. |
| 36 | `evidence_legal_holds` | `title` | `EvidenceLegalHold.title` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/governance-lifecycle.routes.ts; services/api/src/routes/governance.routes.ts; services/api/src/routes/reviewer-ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 37 | `evidence_legal_holds` | `reason` | `EvidenceLegalHold.reason` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/governance-lifecycle.routes.ts; services/api/src/routes/governance.routes.ts; services/api/src/routes/reviewer-ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 38 | `evidence_legal_holds` | `release_note` | `EvidenceLegalHold.releaseNote` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/governance.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 39 | `evidence_legal_holds` | `updated_at` | `EvidenceLegalHold.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/governance-lifecycle.routes.ts; services/api/src/routes/reviewer-ops.routes.ts; services/api/src/services/analytics/analytics.service.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 40 | `evidence_legal_holds` | `updated_at` | `EvidenceLegalHold.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/governance-lifecycle.routes.ts; services/api/src/routes/reviewer-ops.routes.ts; services/api/src/services/analytics/analytics.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 41 | `security_events` | `userAgent` | `SecurityEvent.userAgent` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/services/security/mfa-admin-lifecycle.service.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 42 | `upload_sessions` | `multipart_upload_id` | `UploadSession.multipartUploadId` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 43 | `upload_sessions` | `failure_reason` | `UploadSession.failureReason` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 44 | `case_legal_holds` | `placed_by_user_id` | `CaseLegalHold.placedByUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 45 | `evidence_extracted_texts` | `provider` | `EvidenceExtractedText.provider` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/investigation-diagnostics.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 46 | `evidence_extracted_texts` | `updated_at` | `EvidenceExtractedText.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | no direct prisma.<model>.<field> hit | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 47 | `evidence_extracted_texts` | `updated_at` | `EvidenceExtractedText.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 48 | `evidence_entities` | `value` | `EvidenceEntity.value` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 49 | `evidence_entities` | `normalized_value` | `EvidenceEntity.normalizedValue` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 50 | `evidence_semantic_chunks` | `chunk_text` | `EvidenceSemanticChunk.chunkText` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 51 | `discussion_threads` | `resolution_note` | `DiscussionThread.resolutionNote` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/collaboration.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 52 | `discussion_threads` | `escalation_reason` | `DiscussionThread.escalationReason` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/collaboration.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 53 | `discussion_threads` | `updated_at` | `DiscussionThread.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/case-workspace.routes.ts; services/api/src/routes/evidence.routes.ts; services/api/src/routes/me-inbox.routes.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 54 | `discussion_threads` | `updated_at` | `DiscussionThread.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/case-workspace.routes.ts; services/api/src/routes/evidence.routes.ts; services/api/src/routes/me-inbox.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 55 | `discussion_messages` | `body` | `DiscussionMessage.body` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 56 | `discussion_mentions` | `thread_id` | `DiscussionMention.threadId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/collaboration.routes.ts; services/api/src/routes/me-inbox.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 57 | `discussion_mentions` | `mentioned_user_id` | `DiscussionMention.mentionedUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/collaboration.routes.ts; services/api/src/routes/me-inbox.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 58 | `discussion_mentions` | `created_at` | `DiscussionMention.createdAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 59 | `step_up_challenges` | `resource_id` | `StepUpChallenge.resourceId` | `TYPE_MISMATCH` | uuid / uuid | character varying | services/api/src/routes/identity-security.routes.ts | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 60 | `trusted_devices` | `updated_at` | `TrustedDevice.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/ops.routes.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 61 | `trusted_devices` | `updated_at` | `TrustedDevice.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/ops.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 62 | `mfa_pending_challenges` | `purpose` | `MfaPendingChallenge.purpose` | `TYPE_MISMATCH` | udt=mfa_challenge_purpose | enum:MfaChallengePurpose | services/api/src/services/security/mfa.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 63 | `mfa_recovery_requests` | `status` | `MfaRecoveryRequest.status` | `TYPE_MISMATCH` | udt=mfa_recovery_request_status | enum:MfaRecoveryRequestStatus | services/api/src/routes/me-inbox.routes.ts; services/api/src/services/security/mfa-admin-lifecycle.service.ts; services/api/src/services/security/mfa-recovery-digest-preview.service.ts | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |
| 64 | `operational_incidents` | `safe_summary` | `OperationalIncident.safeSummary` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/services/cases/matter-workspace.service.ts; services/api/src/services/dashboard/command-center.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 65 | `operational_incidents` | `first_seen_at_utc` | `OperationalIncident.firstSeenAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/services/dashboard/command-center.service.ts; services/api/src/services/dashboard/operational-timeline.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 66 | `operational_incidents` | `last_seen_at_utc` | `OperationalIncident.lastSeenAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/services/cases/matter-workspace.service.ts; services/api/src/services/dashboard/causality.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 67 | `operational_incidents` | `occurrence_count` | `OperationalIncident.occurrenceCount` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/services/cases/matter-workspace.service.ts; services/api/src/services/dashboard/command-center.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 68 | `operational_incidents` | `opened_by_system` | `OperationalIncident.openedBySystem` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 69 | `operational_incidents` | `resolution_note` | `OperationalIncident.resolutionNote` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/ops.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 70 | `operational_incidents` | `created_at` | `OperationalIncident.createdAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/routes/ops.routes.ts; services/api/src/services/cases/matter-queue.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 71 | `operational_incidents` | `updated_at` | `OperationalIncident.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/me-inbox.routes.ts; services/api/src/routes/ops.routes.ts; services/api/src/services/cases/matter-queue.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 72 | `operational_incident_events` | `incident_id` | `OperationalIncidentEvent.incidentId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 73 | `operational_incident_events` | `event_type` | `OperationalIncidentEvent.eventType` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 74 | `operational_incident_events` | `safe_message` | `OperationalIncidentEvent.safeMessage` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 75 | `evidence_workflow_instances` | `team_id` | `EvidenceWorkflowInstance.teamId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 76 | `evidence_workflow_instances` | `intake_mode` | `EvidenceWorkflowInstance.intakeMode` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 77 | `evidence_workflow_instances` | `actor_role` | `EvidenceWorkflowInstance.actorRole` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 78 | `evidence_workflow_instances` | `updated_at` | `EvidenceWorkflowInstance.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | no direct prisma.<model>.<field> hit | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 79 | `evidence_workflow_instances` | `updated_at` | `EvidenceWorkflowInstance.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 80 | `evidence_workflow_instance_evidence` | `id` | `EvidenceWorkflowInstanceEvidence.id` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/workflow-instances.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 81 | `evidence_workflow_instance_evidence` | `workflow_instance_id` | `EvidenceWorkflowInstanceEvidence.workflowInstanceId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/workflow-instances.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 82 | `evidence_workflow_instance_evidence` | `evidence_id` | `EvidenceWorkflowInstanceEvidence.evidenceId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/workflow-instances.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 83 | `evidence_workflow_instance_evidence` | `created_at` | `EvidenceWorkflowInstanceEvidence.createdAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/workflow-instances.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 84 | `evidence_workflow_step_instances` | `workflow_instance_id` | `EvidenceWorkflowStepInstance.workflowInstanceId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 85 | `evidence_workflow_step_instances` | `step_key` | `EvidenceWorkflowStepInstance.stepKey` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 86 | `evidence_workflow_step_instances` | `order_index` | `EvidenceWorkflowStepInstance.orderIndex` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 87 | `evidence_workflow_step_instances` | `updated_at` | `EvidenceWorkflowStepInstance.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | no direct prisma.<model>.<field> hit | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 88 | `evidence_workflow_step_instances` | `updated_at` | `EvidenceWorkflowStepInstance.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 89 | `evidence_workflow_visibility_decisions` | `workflow_instance_id` | `EvidenceWorkflowVisibilityDecision.workflowInstanceId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 90 | `evidence_workflow_visibility_decisions` | `field_key` | `EvidenceWorkflowVisibilityDecision.fieldKey` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 91 | `evidence_workflow_visibility_decisions` | `reason` | `EvidenceWorkflowVisibilityDecision.reason` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/reviewer-ops.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 92 | `evidence_workflow_visibility_decisions` | `updated_at` | `EvidenceWorkflowVisibilityDecision.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/reviewer-ops.routes.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 93 | `evidence_workflow_visibility_decisions` | `updated_at` | `EvidenceWorkflowVisibilityDecision.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/reviewer-ops.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 94 | `evidence_search_documents` | `team_id` | `EvidenceSearchDocument.teamId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 95 | `evidence_search_documents` | `document_type` | `EvidenceSearchDocument.documentType` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 96 | `evidence_search_documents` | `source_id` | `EvidenceSearchDocument.sourceId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 97 | `evidence_search_documents` | `title` | `EvidenceSearchDocument.title` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/search.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 98 | `evidence_search_documents` | `title` | `EvidenceSearchDocument.title` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 99 | `evidence_search_documents` | `subtitle` | `EvidenceSearchDocument.subtitle` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/search.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 100 | `evidence_search_documents` | `summary` | `EvidenceSearchDocument.summary` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/routes/search.routes.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 101 | `evidence_search_documents` | `source_updated_at_utc` | `EvidenceSearchDocument.sourceUpdatedAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 102 | `evidence_search_documents` | `updated_at` | `EvidenceSearchDocument.updatedAt` | `TYPE_MISMATCH` | timestamp without time zone / timestamp | timestamp with time zone | services/api/src/routes/search.routes.ts | **A** | Add shadow timestamptz column, backfill from existing timestamp, swap in a later migration, keep original until validated. | medium | yes | no | yes | Timestamp shape mismatch is repairable, but timezone semantics still need controlled conversion. |
| 103 | `evidence_search_documents` | `updated_at` | `EvidenceSearchDocument.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/routes/search.routes.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 104 | `saved_search_views` | `team_id` | `SavedSearchView.teamId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 105 | `saved_search_views` | `created_by_user_id` | `SavedSearchView.createdByUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 106 | `saved_search_views` | `query_json` | `SavedSearchView.queryJson` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 107 | `saved_search_views` | `created_at` | `SavedSearchView.createdAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 108 | `saved_search_views` | `updated_at` | `SavedSearchView.updatedAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 109 | `reviewer_ops_reminders` | `id` | `ReviewerOpsReminder.id` | `TYPE_MISMATCH` | text / text | uuid | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 110 | `reviewer_ops_reminders` | `dedup_key` | `ReviewerOpsReminder.dedupKey` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 111 | `reviewer_ops_reminders` | `workflow_id` | `ReviewerOpsReminder.workflowId` | `TYPE_MISMATCH` | text / text | uuid | services/api/src/services/reviewer-ops/reviewer-ops-runtime-probe.service.ts | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 112 | `reviewer_ops_reminders` | `escalation_id` | `ReviewerOpsReminder.escalationId` | `TYPE_MISMATCH` | text / text | uuid | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 113 | `reviewer_ops_reminders` | `reviewer_user_id` | `ReviewerOpsReminder.reviewerUserId` | `TYPE_MISMATCH` | text / text | uuid | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 114 | `reviewer_ops_reminders` | `safe_summary` | `ReviewerOpsReminder.safeSummary` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 115 | `reviewer_ops_reminders` | `status` | `ReviewerOpsReminder.status` | `TYPE_MISMATCH` | text / text | character varying | services/api/src/services/reviewer-ops/reviewer-ops-runtime-probe.service.ts | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 116 | `evidence_exchange_package_deliveries` | `delivered_at` | `EvidenceExchangePackageDelivery.deliveredAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/exchange/signed-delivery.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 117 | `external_review_invitation_deliveries` | `attempt` | `ExternalReviewInvitationDelivery.attempt` | `TYPE_MISMATCH` | smallint / int2 | integer | services/api/src/services/external-review/portal-invitation-email.service.ts; services/api/src/services/external-review/portal-invitation.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 118 | `external_review_invitation_deliveries` | `bulk_batch_id` | `ExternalReviewInvitationDelivery.bulkBatchId` | `TYPE_MISMATCH` | uuid / uuid | character varying | services/api/src/services/external-review/portal-invitation-email.service.ts | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 119 | `redaction_versions` | `version_ordinal` | `RedactionVersion.versionOrdinal` | `TYPE_MISMATCH` | smallint / int2 | integer | services/api/src/routes/redaction.routes.ts; services/api/src/services/redaction/redaction-project.service.ts; services/api/src/services/redaction/redaction-projection.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 120 | `redaction_approvals` | `approved_at_utc` | `RedactionApproval.approvedAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 121 | `subprocessor_versions` | `effective_at` | `SubprocessorVersion.effectiveAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | no direct prisma.<model>.<field> hit | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 122 | `delegated_admin_grants` | `granted_to_user_id` | `DelegatedAdminGrant.granteeUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/delegated-admin.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 123 | `governance_policy_assignments` | `created_at` | `GovernancePolicyAssignment.createdAt` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/governance-policy.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 124 | `access_review_campaigns` | `starts_at_utc` | `AccessReviewCampaign.startsAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/access-review.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 125 | `access_review_campaigns` | `ends_at_utc` | `AccessReviewCampaign.endsAtUtc` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/access-review.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 126 | `cross_org_review_grants` | `granted_by_user_id` | `CrossOrgReviewGrant.createdByUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/cross-org-review.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 127 | `cross_org_review_grants` | `scope` | `CrossOrgReviewGrant.scope` | `TYPE_MISMATCH` | character varying / varchar | jsonb / json | services/api/src/services/governance/cross-org-review.service.ts | **F** | Treat as semantic mismatch; inspect stored shape and decide whether DB or schema is canonical before any migration. | high | no | yes | no | JSON/object vs scalar mismatch changes meaning, not just storage type. |
| 128 | `evidence_exchange_package_builds` | `id` | `EvidenceExchangePackageBuild.id` | `TYPE_MISMATCH` | text / text | uuid | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 129 | `evidence_exchange_package_builds` | `package_id` | `EvidenceExchangePackageBuild.packageId` | `TYPE_MISMATCH` | text / text | character varying | no direct prisma.<model>.<field> hit | **B** | Align DB string type to schema only when length audit proves no truncation risk; otherwise keep DB and fix schema later. | low | no | yes | yes | String-family mismatch is often safe, but varchar bounds must be checked first when schema constrains length. |
| 130 | `media_intelligence_records` | `provider_record_key` | `MediaIntelligenceRecord.providerRecordKey` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/intelligence/media-intelligence.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 131 | `redaction_policy_versions` | `version_ordinal` | `RedactionPolicyVersion.versionOrdinal` | `TYPE_MISMATCH` | smallint / int2 | integer | services/api/src/services/redaction/redaction-policy-store.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 132 | `redaction_policy_assignments` | `version_id` | `RedactionPolicyAssignment.policyVersionId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/redaction/policy-verification-manifest.service.ts; services/api/src/services/redaction/redaction-policy-store.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 133 | `video_timeline_events` | `start_ms` | `VideoTimelineEvent.startMs` | `TYPE_MISMATCH` | integer / int4 | bigint | services/api/src/services/redaction/video/video-timeline.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 134 | `video_timeline_events` | `end_ms` | `VideoTimelineEvent.endMs` | `TYPE_MISMATCH` | integer / int4 | bigint | services/api/src/services/redaction/video/video-timeline.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 135 | `department_memberships` | `granted_by_user_id` | `DepartmentMembership.grantedByUserId` | `NULLABLE_DB_NULLABLE_PRISMA_REQUIRED` | nullable | required (NOT NULL) | services/api/src/services/governance/department-membership.service.ts | **E** | Count NULLs, define safe backfill/default, then harden NOT NULL only when zero-NULL readiness is proven. | high | yes | null-count | yes | Runtime can fail if Prisma reads NULL into a required field; readiness has to be proven with live counts. |
| 136 | `video_frames` | `timestamp_ms` | `VideoFrame.timestampMs` | `TYPE_MISMATCH` | integer / int4 | bigint | services/api/src/routes/redaction.routes.ts; services/api/src/services/redaction/video/video-frame.service.ts; services/api/src/services/redaction/video/video-timeline.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 137 | `video_frames` | `byte_size` | `VideoFrame.byteSize` | `TYPE_MISMATCH` | integer / int4 | bigint | services/api/src/routes/redaction.routes.ts; services/api/src/services/redaction/video/video-frame.service.ts | **C** | Widen integer type in place or via shadow column; no narrowing. | low | no | no | yes | Only widening conversions are in scope; no value reinterpretation expected. |
| 138 | `duplicate_decisions` | `id` | `DuplicateDecision.id` | `TYPE_MISMATCH` | uuid / uuid | text / character varying | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 139 | `duplicate_decisions` | `team_id` | `DuplicateDecision.teamId` | `TYPE_MISMATCH` | uuid / uuid | text / character varying | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 140 | `duplicate_decisions` | `edge_id` | `DuplicateDecision.edgeId` | `TYPE_MISMATCH` | uuid / uuid | text / character varying | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 141 | `duplicate_decisions` | `decided_by_user_id` | `DuplicateDecision.decidedByUserId` | `TYPE_MISMATCH` | uuid / uuid | text / character varying | no direct prisma.<model>.<field> hit | **G** | Run UUID validity audit and decide direction; only convert text→uuid if every value is valid and schema is canonical. | high | no | yes | no | Identifier format change can reject existing values or reveal schema/DB disagreement. |
| 142 | `(enum)` | `CustodyEventType.CAPTURE_TRUST_EVENT` | `CustodyEventType` | `MISSING_ENUM_VALUE` | enum type missing value | enum includes CAPTURE_TRUST_EVENT | n/a | **D** | Run distinct-value audit first, map legacy values if needed, then convert to Prisma enum or reconcile enum-type naming. | medium | no | yes | yes | Enum adoption cannot be done safely without confirming every stored value and enum-type mapping. |

## Read-Only Value / Null Audit SQL

These queries are intentionally read-only and should be run against the same live target before any Phase 2B implementation migration is authored.

### 1. Report.lastVerifiedSourceSnapshot

- Table / object: `reports` / `last_verified_source_snapshot`
- Category: **D**

```sql
SELECT "last_verified_source_snapshot" AS value, COUNT(*) AS row_count
FROM public."reports"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 3. VerificationView.verificationStatusSnapshot

- Table / object: `verification_views` / `verification_status_snapshot`
- Category: **D**

```sql
SELECT "verification_status_snapshot" AS value, COUNT(*) AS row_count
FROM public."verification_views"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 5. Team.billingPlan

- Table / object: `teams` / `billing_plan`
- Category: **D**

```sql
SELECT "billing_plan" AS value, COUNT(*) AS row_count
FROM public."teams"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 7. Team.billingStatus

- Table / object: `teams` / `billing_status`
- Category: **D**

```sql
SELECT "billing_status" AS value, COUNT(*) AS row_count
FROM public."teams"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 9. EvidenceSavedView.ownerUserId

- Table / object: `evidence_saved_views` / `owner_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_saved_views" WHERE "owner_user_id" IS NULL;
```

### 10. EvidenceSavedView.name

- Table / object: `evidence_saved_views` / `name`
- Category: **B**

```sql
SELECT MAX(char_length("name")) AS max_length, COUNT(*) FILTER (WHERE char_length("name") > 120) AS over_limit_rows
FROM public."evidence_saved_views";
```

### 11. EvidenceSavedView.filtersJson

- Table / object: `evidence_saved_views` / `filters_json`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_saved_views" WHERE "filters_json" IS NULL;
```

### 12. EvidenceSavedView.scope

- Table / object: `evidence_saved_views` / `scope`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_saved_views" WHERE "scope" IS NULL;
```

### 13. EvidenceSavedView.updatedAt

- Table / object: `evidence_saved_views` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 14. EvidenceSavedView.updatedAt

- Table / object: `evidence_saved_views` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_saved_views" WHERE "updated_at" IS NULL;
```

### 15. WorkflowReviewDecision.stage

- Table / object: `workflow_review_decisions` / `stage`
- Category: **D**

```sql
SELECT "stage" AS value, COUNT(*) AS row_count
FROM public."workflow_review_decisions"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 16. WorkflowReviewDecision.decision

- Table / object: `workflow_review_decisions` / `decision`
- Category: **D**

```sql
SELECT "decision" AS value, COUNT(*) AS row_count
FROM public."workflow_review_decisions"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 17. WorkflowReviewDecision.reasonCode

- Table / object: `workflow_review_decisions` / `reason_code`
- Category: **D**

```sql
SELECT "reason_code" AS value, COUNT(*) AS row_count
FROM public."workflow_review_decisions"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 18. DemoRequest.leadQuality

- Table / object: `demo_requests` / `lead_quality`
- Category: **D**

```sql
SELECT "lead_quality" AS value, COUNT(*) AS row_count
FROM public."demo_requests"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 20. DemoRequest.leadTrack

- Table / object: `demo_requests` / `lead_track`
- Category: **D**

```sql
SELECT "lead_track" AS value, COUNT(*) AS row_count
FROM public."demo_requests"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 22. DemoRequest.recommendedAction

- Table / object: `demo_requests` / `recommended_action`
- Category: **D**

```sql
SELECT "recommended_action" AS value, COUNT(*) AS row_count
FROM public."demo_requests"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 24. DemoRequest.followUpStatus

- Table / object: `demo_requests` / `follow_up_status`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."demo_requests" WHERE "follow_up_status" IS NULL;
```

### 25. DemoRequest.followUpStep

- Table / object: `demo_requests` / `follow_up_step`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."demo_requests" WHERE "follow_up_step" IS NULL;
```

### 26. NotificationDelivery.eventType

- Table / object: `notification_deliveries` / `event_type`
- Category: **B**

```sql
SELECT MAX(char_length("event_type")) AS max_length, COUNT(*) FILTER (WHERE char_length("event_type") > 64) AS over_limit_rows
FROM public."notification_deliveries";
```

### 27. NotificationDelivery.recipient

- Table / object: `notification_deliveries` / `recipient`
- Category: **B**

```sql
SELECT MAX(char_length("recipient")) AS max_length, COUNT(*) FILTER (WHERE char_length("recipient") > 512) AS over_limit_rows
FROM public."notification_deliveries";
```

### 28. NotificationDelivery.recipientName

- Table / object: `notification_deliveries` / `recipient_name`
- Category: **B**

```sql
SELECT MAX(char_length("recipient_name")) AS max_length, COUNT(*) FILTER (WHERE char_length("recipient_name") > 180) AS over_limit_rows
FROM public."notification_deliveries";
```

### 29. NotificationDelivery.subject

- Table / object: `notification_deliveries` / `subject`
- Category: **B**

```sql
SELECT MAX(char_length("subject")) AS max_length, COUNT(*) FILTER (WHERE char_length("subject") > 400) AS over_limit_rows
FROM public."notification_deliveries";
```

### 30. NotificationDelivery.templateKey

- Table / object: `notification_deliveries` / `template_key`
- Category: **B**

```sql
SELECT MAX(char_length("template_key")) AS max_length, COUNT(*) FILTER (WHERE char_length("template_key") > 80) AS over_limit_rows
FROM public."notification_deliveries";
```

### 31. NotificationDelivery.renderedPreview

- Table / object: `notification_deliveries` / `rendered_preview`
- Category: **B**

```sql
SELECT MAX(char_length("rendered_preview")) AS max_length, COUNT(*) FILTER (WHERE char_length("rendered_preview") > 2000) AS over_limit_rows
FROM public."notification_deliveries";
```

### 32. NotificationDelivery.providerMessageId

- Table / object: `notification_deliveries` / `provider_message_id`
- Category: **B**

```sql
SELECT MAX(char_length("provider_message_id")) AS max_length, COUNT(*) FILTER (WHERE char_length("provider_message_id") > 255) AS over_limit_rows
FROM public."notification_deliveries";
```

### 33. NotificationDelivery.errorCode

- Table / object: `notification_deliveries` / `error_code`
- Category: **B**

```sql
SELECT MAX(char_length("error_code")) AS max_length, COUNT(*) FILTER (WHERE char_length("error_code") > 80) AS over_limit_rows
FROM public."notification_deliveries";
```

### 34. NotificationDelivery.errorMessage

- Table / object: `notification_deliveries` / `error_message`
- Category: **B**

```sql
SELECT MAX(char_length("error_message")) AS max_length, COUNT(*) FILTER (WHERE char_length("error_message") > 2000) AS over_limit_rows
FROM public."notification_deliveries";
```

### 35. WorkspaceGovernancePolicy.metadataRedactionDefault

- Table / object: `workspace_governance_policies` / `metadata_redaction_default`
- Category: **F**

```sql
SELECT pg_typeof("metadata_redaction_default")::text AS storage_type, "metadata_redaction_default"
FROM public."workspace_governance_policies"
WHERE "metadata_redaction_default" IS NOT NULL
LIMIT 20;
```

### 36. EvidenceLegalHold.title

- Table / object: `evidence_legal_holds` / `title`
- Category: **B**

```sql
SELECT MAX(char_length("title")) AS max_length, COUNT(*) FILTER (WHERE char_length("title") > 180) AS over_limit_rows
FROM public."evidence_legal_holds";
```

### 37. EvidenceLegalHold.reason

- Table / object: `evidence_legal_holds` / `reason`
- Category: **B**

```sql
SELECT MAX(char_length("reason")) AS max_length, COUNT(*) FILTER (WHERE char_length("reason") > 4000) AS over_limit_rows
FROM public."evidence_legal_holds";
```

### 38. EvidenceLegalHold.releaseNote

- Table / object: `evidence_legal_holds` / `release_note`
- Category: **B**

```sql
SELECT MAX(char_length("release_note")) AS max_length, COUNT(*) FILTER (WHERE char_length("release_note") > 4000) AS over_limit_rows
FROM public."evidence_legal_holds";
```

### 39. EvidenceLegalHold.updatedAt

- Table / object: `evidence_legal_holds` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 40. EvidenceLegalHold.updatedAt

- Table / object: `evidence_legal_holds` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_legal_holds" WHERE "updated_at" IS NULL;
```

### 41. SecurityEvent.userAgent

- Table / object: `security_events` / `userAgent`
- Category: **B**

```sql
SELECT MAX(char_length("userAgent")) AS max_length, COUNT(*) FILTER (WHERE char_length("userAgent") > 512) AS over_limit_rows
FROM public."security_events";
```

### 42. UploadSession.multipartUploadId

- Table / object: `upload_sessions` / `multipart_upload_id`
- Category: **B**

```sql
SELECT MAX(char_length("multipart_upload_id")) AS max_length, COUNT(*) FILTER (WHERE char_length("multipart_upload_id") > 256) AS over_limit_rows
FROM public."upload_sessions";
```

### 43. UploadSession.failureReason

- Table / object: `upload_sessions` / `failure_reason`
- Category: **B**

```sql
SELECT MAX(char_length("failure_reason")) AS max_length, COUNT(*) FILTER (WHERE char_length("failure_reason") > 400) AS over_limit_rows
FROM public."upload_sessions";
```

### 44. CaseLegalHold.placedByUserId

- Table / object: `case_legal_holds` / `placed_by_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."case_legal_holds" WHERE "placed_by_user_id" IS NULL;
```

### 45. EvidenceExtractedText.provider

- Table / object: `evidence_extracted_texts` / `provider`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_extracted_texts" WHERE "provider" IS NULL;
```

### 46. EvidenceExtractedText.updatedAt

- Table / object: `evidence_extracted_texts` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 47. EvidenceExtractedText.updatedAt

- Table / object: `evidence_extracted_texts` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_extracted_texts" WHERE "updated_at" IS NULL;
```

### 48. EvidenceEntity.value

- Table / object: `evidence_entities` / `value`
- Category: **B**

```sql
SELECT MAX(char_length("value")) AS max_length, COUNT(*) FILTER (WHERE char_length("value") > 512) AS over_limit_rows
FROM public."evidence_entities";
```

### 49. EvidenceEntity.normalizedValue

- Table / object: `evidence_entities` / `normalized_value`
- Category: **B**

```sql
SELECT MAX(char_length("normalized_value")) AS max_length, COUNT(*) FILTER (WHERE char_length("normalized_value") > 512) AS over_limit_rows
FROM public."evidence_entities";
```

### 50. EvidenceSemanticChunk.chunkText

- Table / object: `evidence_semantic_chunks` / `chunk_text`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_semantic_chunks" WHERE "chunk_text" IS NULL;
```

### 51. DiscussionThread.resolutionNote

- Table / object: `discussion_threads` / `resolution_note`
- Category: **B**

```sql
SELECT MAX(char_length("resolution_note")) AS max_length, COUNT(*) FILTER (WHERE char_length("resolution_note") > 1000) AS over_limit_rows
FROM public."discussion_threads";
```

### 52. DiscussionThread.escalationReason

- Table / object: `discussion_threads` / `escalation_reason`
- Category: **B**

```sql
SELECT MAX(char_length("escalation_reason")) AS max_length, COUNT(*) FILTER (WHERE char_length("escalation_reason") > 400) AS over_limit_rows
FROM public."discussion_threads";
```

### 53. DiscussionThread.updatedAt

- Table / object: `discussion_threads` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 54. DiscussionThread.updatedAt

- Table / object: `discussion_threads` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."discussion_threads" WHERE "updated_at" IS NULL;
```

### 55. DiscussionMessage.body

- Table / object: `discussion_messages` / `body`
- Category: **B**

```sql
SELECT MAX(char_length("body")) AS max_length, COUNT(*) FILTER (WHERE char_length("body") > 8192) AS over_limit_rows
FROM public."discussion_messages";
```

### 56. DiscussionMention.threadId

- Table / object: `discussion_mentions` / `thread_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."discussion_mentions" WHERE "thread_id" IS NULL;
```

### 57. DiscussionMention.mentionedUserId

- Table / object: `discussion_mentions` / `mentioned_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."discussion_mentions" WHERE "mentioned_user_id" IS NULL;
```

### 58. DiscussionMention.createdAt

- Table / object: `discussion_mentions` / `created_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."discussion_mentions" WHERE "created_at" IS NULL;
```

### 59. StepUpChallenge.resourceId

- Table / object: `step_up_challenges` / `resource_id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."step_up_challenges"
WHERE "resource_id" IS NOT NULL AND pg_typeof("resource_id")::text <> 'uuid';
```

### 60. TrustedDevice.updatedAt

- Table / object: `trusted_devices` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 61. TrustedDevice.updatedAt

- Table / object: `trusted_devices` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."trusted_devices" WHERE "updated_at" IS NULL;
```

### 62. MfaPendingChallenge.purpose

- Table / object: `mfa_pending_challenges` / `purpose`
- Category: **D**

```sql
SELECT "purpose" AS value, COUNT(*) AS row_count
FROM public."mfa_pending_challenges"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 63. MfaRecoveryRequest.status

- Table / object: `mfa_recovery_requests` / `status`
- Category: **D**

```sql
SELECT "status" AS value, COUNT(*) AS row_count
FROM public."mfa_recovery_requests"
GROUP BY 1
ORDER BY row_count DESC, value ASC;
```

### 64. OperationalIncident.safeSummary

- Table / object: `operational_incidents` / `safe_summary`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "safe_summary" IS NULL;
```

### 65. OperationalIncident.firstSeenAtUtc

- Table / object: `operational_incidents` / `first_seen_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "first_seen_at_utc" IS NULL;
```

### 66. OperationalIncident.lastSeenAtUtc

- Table / object: `operational_incidents` / `last_seen_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "last_seen_at_utc" IS NULL;
```

### 67. OperationalIncident.occurrenceCount

- Table / object: `operational_incidents` / `occurrence_count`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "occurrence_count" IS NULL;
```

### 68. OperationalIncident.openedBySystem

- Table / object: `operational_incidents` / `opened_by_system`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "opened_by_system" IS NULL;
```

### 69. OperationalIncident.resolutionNote

- Table / object: `operational_incidents` / `resolution_note`
- Category: **B**

```sql
SELECT MAX(char_length("resolution_note")) AS max_length, COUNT(*) FILTER (WHERE char_length("resolution_note") > 400) AS over_limit_rows
FROM public."operational_incidents";
```

### 70. OperationalIncident.createdAt

- Table / object: `operational_incidents` / `created_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "created_at" IS NULL;
```

### 71. OperationalIncident.updatedAt

- Table / object: `operational_incidents` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incidents" WHERE "updated_at" IS NULL;
```

### 72. OperationalIncidentEvent.incidentId

- Table / object: `operational_incident_events` / `incident_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incident_events" WHERE "incident_id" IS NULL;
```

### 73. OperationalIncidentEvent.eventType

- Table / object: `operational_incident_events` / `event_type`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incident_events" WHERE "event_type" IS NULL;
```

### 74. OperationalIncidentEvent.safeMessage

- Table / object: `operational_incident_events` / `safe_message`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."operational_incident_events" WHERE "safe_message" IS NULL;
```

### 75. EvidenceWorkflowInstance.teamId

- Table / object: `evidence_workflow_instances` / `team_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instances" WHERE "team_id" IS NULL;
```

### 76. EvidenceWorkflowInstance.intakeMode

- Table / object: `evidence_workflow_instances` / `intake_mode`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instances" WHERE "intake_mode" IS NULL;
```

### 77. EvidenceWorkflowInstance.actorRole

- Table / object: `evidence_workflow_instances` / `actor_role`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instances" WHERE "actor_role" IS NULL;
```

### 78. EvidenceWorkflowInstance.updatedAt

- Table / object: `evidence_workflow_instances` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 79. EvidenceWorkflowInstance.updatedAt

- Table / object: `evidence_workflow_instances` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instances" WHERE "updated_at" IS NULL;
```

### 80. EvidenceWorkflowInstanceEvidence.id

- Table / object: `evidence_workflow_instance_evidence` / `id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instance_evidence" WHERE "id" IS NULL;
```

### 81. EvidenceWorkflowInstanceEvidence.workflowInstanceId

- Table / object: `evidence_workflow_instance_evidence` / `workflow_instance_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instance_evidence" WHERE "workflow_instance_id" IS NULL;
```

### 82. EvidenceWorkflowInstanceEvidence.evidenceId

- Table / object: `evidence_workflow_instance_evidence` / `evidence_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instance_evidence" WHERE "evidence_id" IS NULL;
```

### 83. EvidenceWorkflowInstanceEvidence.createdAt

- Table / object: `evidence_workflow_instance_evidence` / `created_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_instance_evidence" WHERE "created_at" IS NULL;
```

### 84. EvidenceWorkflowStepInstance.workflowInstanceId

- Table / object: `evidence_workflow_step_instances` / `workflow_instance_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_step_instances" WHERE "workflow_instance_id" IS NULL;
```

### 85. EvidenceWorkflowStepInstance.stepKey

- Table / object: `evidence_workflow_step_instances` / `step_key`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_step_instances" WHERE "step_key" IS NULL;
```

### 86. EvidenceWorkflowStepInstance.orderIndex

- Table / object: `evidence_workflow_step_instances` / `order_index`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_step_instances" WHERE "order_index" IS NULL;
```

### 87. EvidenceWorkflowStepInstance.updatedAt

- Table / object: `evidence_workflow_step_instances` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 88. EvidenceWorkflowStepInstance.updatedAt

- Table / object: `evidence_workflow_step_instances` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_step_instances" WHERE "updated_at" IS NULL;
```

### 89. EvidenceWorkflowVisibilityDecision.workflowInstanceId

- Table / object: `evidence_workflow_visibility_decisions` / `workflow_instance_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_visibility_decisions" WHERE "workflow_instance_id" IS NULL;
```

### 90. EvidenceWorkflowVisibilityDecision.fieldKey

- Table / object: `evidence_workflow_visibility_decisions` / `field_key`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_visibility_decisions" WHERE "field_key" IS NULL;
```

### 91. EvidenceWorkflowVisibilityDecision.reason

- Table / object: `evidence_workflow_visibility_decisions` / `reason`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_visibility_decisions" WHERE "reason" IS NULL;
```

### 92. EvidenceWorkflowVisibilityDecision.updatedAt

- Table / object: `evidence_workflow_visibility_decisions` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 93. EvidenceWorkflowVisibilityDecision.updatedAt

- Table / object: `evidence_workflow_visibility_decisions` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_workflow_visibility_decisions" WHERE "updated_at" IS NULL;
```

### 94. EvidenceSearchDocument.teamId

- Table / object: `evidence_search_documents` / `team_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "team_id" IS NULL;
```

### 95. EvidenceSearchDocument.documentType

- Table / object: `evidence_search_documents` / `document_type`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "document_type" IS NULL;
```

### 96. EvidenceSearchDocument.sourceId

- Table / object: `evidence_search_documents` / `source_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "source_id" IS NULL;
```

### 97. EvidenceSearchDocument.title

- Table / object: `evidence_search_documents` / `title`
- Category: **B**

```sql
SELECT MAX(char_length("title")) AS max_length, COUNT(*) FILTER (WHERE char_length("title") > 200) AS over_limit_rows
FROM public."evidence_search_documents";
```

### 98. EvidenceSearchDocument.title

- Table / object: `evidence_search_documents` / `title`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "title" IS NULL;
```

### 99. EvidenceSearchDocument.subtitle

- Table / object: `evidence_search_documents` / `subtitle`
- Category: **B**

```sql
SELECT MAX(char_length("subtitle")) AS max_length, COUNT(*) FILTER (WHERE char_length("subtitle") > 200) AS over_limit_rows
FROM public."evidence_search_documents";
```

### 100. EvidenceSearchDocument.summary

- Table / object: `evidence_search_documents` / `summary`
- Category: **B**

```sql
SELECT MAX(char_length("summary")) AS max_length, COUNT(*) FILTER (WHERE char_length("summary") > 400) AS over_limit_rows
FROM public."evidence_search_documents";
```

### 101. EvidenceSearchDocument.sourceUpdatedAtUtc

- Table / object: `evidence_search_documents` / `source_updated_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "source_updated_at_utc" IS NULL;
```

### 102. EvidenceSearchDocument.updatedAt

- Table / object: `evidence_search_documents` / `updated_at`
- Category: **A**

```sql
-- No prerequisite value audit required before planning.
```

### 103. EvidenceSearchDocument.updatedAt

- Table / object: `evidence_search_documents` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_search_documents" WHERE "updated_at" IS NULL;
```

### 104. SavedSearchView.teamId

- Table / object: `saved_search_views` / `team_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."saved_search_views" WHERE "team_id" IS NULL;
```

### 105. SavedSearchView.createdByUserId

- Table / object: `saved_search_views` / `created_by_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."saved_search_views" WHERE "created_by_user_id" IS NULL;
```

### 106. SavedSearchView.queryJson

- Table / object: `saved_search_views` / `query_json`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."saved_search_views" WHERE "query_json" IS NULL;
```

### 107. SavedSearchView.createdAt

- Table / object: `saved_search_views` / `created_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."saved_search_views" WHERE "created_at" IS NULL;
```

### 108. SavedSearchView.updatedAt

- Table / object: `saved_search_views` / `updated_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."saved_search_views" WHERE "updated_at" IS NULL;
```

### 109. ReviewerOpsReminder.id

- Table / object: `reviewer_ops_reminders` / `id`
- Category: **G**

```sql
SELECT COUNT(*) AS invalid_uuid_like_count
FROM public."reviewer_ops_reminders"
WHERE "id" IS NOT NULL
  AND "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

### 110. ReviewerOpsReminder.dedupKey

- Table / object: `reviewer_ops_reminders` / `dedup_key`
- Category: **B**

```sql
SELECT MAX(char_length("dedup_key")) AS max_length, COUNT(*) FILTER (WHERE char_length("dedup_key") > 80) AS over_limit_rows
FROM public."reviewer_ops_reminders";
```

### 111. ReviewerOpsReminder.workflowId

- Table / object: `reviewer_ops_reminders` / `workflow_id`
- Category: **G**

```sql
SELECT COUNT(*) AS invalid_uuid_like_count
FROM public."reviewer_ops_reminders"
WHERE "workflow_id" IS NOT NULL
  AND "workflow_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

### 112. ReviewerOpsReminder.escalationId

- Table / object: `reviewer_ops_reminders` / `escalation_id`
- Category: **G**

```sql
SELECT COUNT(*) AS invalid_uuid_like_count
FROM public."reviewer_ops_reminders"
WHERE "escalation_id" IS NOT NULL
  AND "escalation_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

### 113. ReviewerOpsReminder.reviewerUserId

- Table / object: `reviewer_ops_reminders` / `reviewer_user_id`
- Category: **G**

```sql
SELECT COUNT(*) AS invalid_uuid_like_count
FROM public."reviewer_ops_reminders"
WHERE "reviewer_user_id" IS NOT NULL
  AND "reviewer_user_id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

### 114. ReviewerOpsReminder.safeSummary

- Table / object: `reviewer_ops_reminders` / `safe_summary`
- Category: **B**

```sql
SELECT MAX(char_length("safe_summary")) AS max_length, COUNT(*) FILTER (WHERE char_length("safe_summary") > 400) AS over_limit_rows
FROM public."reviewer_ops_reminders";
```

### 115. ReviewerOpsReminder.status

- Table / object: `reviewer_ops_reminders` / `status`
- Category: **B**

```sql
SELECT MAX(char_length("status")) AS max_length, COUNT(*) FILTER (WHERE char_length("status") > 16) AS over_limit_rows
FROM public."reviewer_ops_reminders";
```

### 116. EvidenceExchangePackageDelivery.deliveredAt

- Table / object: `evidence_exchange_package_deliveries` / `delivered_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."evidence_exchange_package_deliveries" WHERE "delivered_at" IS NULL;
```

### 117. ExternalReviewInvitationDelivery.attempt

- Table / object: `external_review_invitation_deliveries` / `attempt`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 118. ExternalReviewInvitationDelivery.bulkBatchId

- Table / object: `external_review_invitation_deliveries` / `bulk_batch_id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."external_review_invitation_deliveries"
WHERE "bulk_batch_id" IS NOT NULL AND pg_typeof("bulk_batch_id")::text <> 'uuid';
```

### 119. RedactionVersion.versionOrdinal

- Table / object: `redaction_versions` / `version_ordinal`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 120. RedactionApproval.approvedAtUtc

- Table / object: `redaction_approvals` / `approved_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."redaction_approvals" WHERE "approved_at_utc" IS NULL;
```

### 121. SubprocessorVersion.effectiveAt

- Table / object: `subprocessor_versions` / `effective_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."subprocessor_versions" WHERE "effective_at" IS NULL;
```

### 122. DelegatedAdminGrant.granteeUserId

- Table / object: `delegated_admin_grants` / `granted_to_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."delegated_admin_grants" WHERE "granted_to_user_id" IS NULL;
```

### 123. GovernancePolicyAssignment.createdAt

- Table / object: `governance_policy_assignments` / `created_at`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."governance_policy_assignments" WHERE "created_at" IS NULL;
```

### 124. AccessReviewCampaign.startsAtUtc

- Table / object: `access_review_campaigns` / `starts_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."access_review_campaigns" WHERE "starts_at_utc" IS NULL;
```

### 125. AccessReviewCampaign.endsAtUtc

- Table / object: `access_review_campaigns` / `ends_at_utc`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."access_review_campaigns" WHERE "ends_at_utc" IS NULL;
```

### 126. CrossOrgReviewGrant.createdByUserId

- Table / object: `cross_org_review_grants` / `granted_by_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."cross_org_review_grants" WHERE "granted_by_user_id" IS NULL;
```

### 127. CrossOrgReviewGrant.scope

- Table / object: `cross_org_review_grants` / `scope`
- Category: **F**

```sql
SELECT pg_typeof("scope")::text AS storage_type, "scope"
FROM public."cross_org_review_grants"
WHERE "scope" IS NOT NULL
LIMIT 20;
```

### 128. EvidenceExchangePackageBuild.id

- Table / object: `evidence_exchange_package_builds` / `id`
- Category: **G**

```sql
SELECT COUNT(*) AS invalid_uuid_like_count
FROM public."evidence_exchange_package_builds"
WHERE "id" IS NOT NULL
  AND "id" !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
```

### 129. EvidenceExchangePackageBuild.packageId

- Table / object: `evidence_exchange_package_builds` / `package_id`
- Category: **B**

```sql
SELECT MAX(char_length("package_id")) AS max_length, COUNT(*) FILTER (WHERE char_length("package_id") > 200) AS over_limit_rows
FROM public."evidence_exchange_package_builds";
```

### 130. MediaIntelligenceRecord.providerRecordKey

- Table / object: `media_intelligence_records` / `provider_record_key`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."media_intelligence_records" WHERE "provider_record_key" IS NULL;
```

### 131. RedactionPolicyVersion.versionOrdinal

- Table / object: `redaction_policy_versions` / `version_ordinal`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 132. RedactionPolicyAssignment.policyVersionId

- Table / object: `redaction_policy_assignments` / `version_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."redaction_policy_assignments" WHERE "version_id" IS NULL;
```

### 133. VideoTimelineEvent.startMs

- Table / object: `video_timeline_events` / `start_ms`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 134. VideoTimelineEvent.endMs

- Table / object: `video_timeline_events` / `end_ms`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 135. DepartmentMembership.grantedByUserId

- Table / object: `department_memberships` / `granted_by_user_id`
- Category: **E**

```sql
SELECT COUNT(*) AS null_count FROM public."department_memberships" WHERE "granted_by_user_id" IS NULL;
```

### 136. VideoFrame.timestampMs

- Table / object: `video_frames` / `timestamp_ms`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 137. VideoFrame.byteSize

- Table / object: `video_frames` / `byte_size`
- Category: **C**

```sql
-- No prerequisite value audit required before planning.
```

### 138. DuplicateDecision.id

- Table / object: `duplicate_decisions` / `id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."duplicate_decisions"
WHERE "id" IS NOT NULL AND pg_typeof("id")::text <> 'uuid';
```

### 139. DuplicateDecision.teamId

- Table / object: `duplicate_decisions` / `team_id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."duplicate_decisions"
WHERE "team_id" IS NOT NULL AND pg_typeof("team_id")::text <> 'uuid';
```

### 140. DuplicateDecision.edgeId

- Table / object: `duplicate_decisions` / `edge_id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."duplicate_decisions"
WHERE "edge_id" IS NOT NULL AND pg_typeof("edge_id")::text <> 'uuid';
```

### 141. DuplicateDecision.decidedByUserId

- Table / object: `duplicate_decisions` / `decided_by_user_id`
- Category: **G**

```sql
SELECT COUNT(*) AS non_uuid_rows
FROM public."duplicate_decisions"
WHERE "decided_by_user_id" IS NOT NULL AND pg_typeof("decided_by_user_id")::text <> 'uuid';
```

### 142. CustodyEventType.CAPTURE_TRUST_EVENT

- Table / object: `CustodyEventType`
- Category: **D**

```sql
SELECT t.typname AS enum_name, e.enumlabel AS enum_value
FROM pg_type t
JOIN pg_enum e ON e.enumtypid = t.oid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public' AND t.typname = 'CustodyEventType'
ORDER BY e.enumsortorder;
```

## Safe Execution Batches

### Batch 2B-1 — Safe timestamp repairs

- Findings: 9
- Why it matters: timestamptz/timestamp drift affects timezone semantics and often co-travels with required updated-at/readiness fields.
- Safe additive? No. Use shadow-column conversions or guarded ALTER TYPE only after confirming exact semantics.
- Needs backfill? Yes, from existing timestamp columns.
- Deploy alone? Yes.
- Validation query after migration: `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('evidence_saved_views','evidence_legal_holds','evidence_extracted_texts','discussion_threads','trusted_devices','evidence_workflow_instances','evidence_workflow_step_instances','evidence_workflow_visibility_decisions','evidence_search_documents') AND column_name = 'updated_at';`

### Batch 2B-2 — Safe widening repairs

- Findings: 7
- Why it matters: counters and media timeline sizes should match current schema width before values exceed historical bounds.
- Safe additive? Usually yes or low-risk direct widen.
- Needs backfill? No.
- Deploy alone? Can be grouped.
- Validation query after migration: `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND (table_name, column_name) IN (('external_review_invitation_deliveries','attempt'),('redaction_versions','version_ordinal'),('redaction_policy_versions','version_ordinal'),('video_timeline_events','start_ms'),('video_timeline_events','end_ms'),('video_frames','timestamp_ms'),('video_frames','byte_size'));`

### Batch 2B-3 — Safe varchar/text alignment

- Findings: 29
- Why it matters: these are mostly contract-shape mismatches where DB `text` is broader than Prisma `varchar`.
- Safe additive? Only after confirming there is no schema length cap or no row exceeds that cap.
- Needs backfill? No.
- Deploy alone? Can be grouped after length audits.
- Validation query after migration: `SELECT table_name, column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('notification_deliveries','evidence_legal_holds','discussion_threads','discussion_messages','operational_incidents','operational_incident_events');`

### Batch 2B-4 — Nullability hardening

- Findings: 64
- Why it matters: Prisma-required fields reading NULL can still break runtime despite the absence of missing columns.
- Safe additive? No. Null-count and backfill readiness first.
- Needs backfill? Often yes.
- Deploy alone? Yes, by domain or by table cluster.
- Validation query after migration: `SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND is_nullable = 'YES' AND table_name IN ('evidence_saved_views','demo_requests','discussion_mentions','access_review_campaigns','cross_org_review_grants','media_intelligence_records','department_memberships');`

### Batch 2B-5 — Enum repairs

- Findings: 20
- Why it matters: several status and governance fields are still stored as plain text or legacy enum type names, and one enum is missing the `CAPTURE_TRUST_EVENT` value.
- Safe additive? No direct cast until distinct-value audit passes.
- Needs backfill? Potentially yes if text values need remapping.
- Deploy alone? Yes.
- Validation query after migration: `SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname IN ('VerificationSource','VerificationStatus','PlanType','TeamBillingStatus','DemoLeadQuality','DemoLeadTrack','DemoRecommendedAction','CustodyEventType') ORDER BY t.typname, e.enumsortorder;`

### Batch 2B-6 — Manual / deferred

- Findings: 13
- Why it matters: JSON/scalar mismatches and UUID/text mismatches can reveal schema-vs-DB canon disagreements rather than simple storage drift.
- Safe additive? Usually no.
- Needs backfill? Maybe.
- Deploy alone? Yes, and only after manual review.
- Validation query after migration: domain-specific, based on the read-only SQL above.

## Excluded From Phase 2B

- LOW findings remain out of scope except where they explain a HIGH drift, such as optional-vs-NOT-NULL legacy columns adjacent to current required fields.
- No destructive enum changes, no drops, no constraint drops, no full Prisma diff application.
- JSON/object mismatches on `workspace_governance_policies.metadata_redaction_default` and `cross_org_review_grants.scope` should not be auto-fixed in Phase 2B implementation.
- UUID/text disagreements on `reviewer_ops_reminders`, `duplicate_decisions`, `step_up_challenges`, `external_review_invitation_deliveries`, and `evidence_exchange_package_builds` need manual canonicality review first.

## Top 10 Riskiest Findings

- `workspace_governance_policies.metadata_redaction_default` (WorkspaceGovernancePolicy.metadataRedactionDefault) — category F; DB stores a boolean while Prisma expects JSON, so this is a semantic governance-policy mismatch, not a simple type cleanup.
- `cross_org_review_grants.scope` (CrossOrgReviewGrant.scope) — category F; DB stores varchar while Prisma expects JSON, which can change the meaning of cross-org authorization scope.
- `reviewer_ops_reminders.id` (ReviewerOpsReminder.id) — category G; DB text to Prisma UUID mismatch risks rejecting existing rows if values are not all valid UUIDs.
- `reviewer_ops_reminders.workflow_id` (ReviewerOpsReminder.workflowId) — category G; workflow linkage cannot be hardened until UUID validity is proven on live data.
- `reviewer_ops_reminders.escalation_id` (ReviewerOpsReminder.escalationId) — category G; escalation references require value audit before any cast or schema correction.
- `evidence_exchange_package_builds.id` (EvidenceExchangePackageBuild.id) — category G; package-build identity is core lifecycle data and should not be recast without validating every stored identifier.
- `duplicate_decisions.id` (DuplicateDecision.id) — category G; DB UUID vs Prisma text suggests either schema drift or canonical-ID drift in the graph/dedup layer.
- `teams.billing_plan` (Team.billingPlan) — category D; billing governance cannot move to enums safely until every stored plan value is audited and mapped.
- `verification_views.verification_status_snapshot` (VerificationView.verificationStatusSnapshot) — category D; verification snapshots affect public trust surfaces and need full distinct-value audit before enum conversion.
- `evidence_saved_views.owner_user_id` (EvidenceSavedView.ownerUserId) — category E; Prisma currently requires a non-null owner, so any live NULLs remain a runtime failure candidate until counted and backfilled.

## Exact Recommended Next Implementation Task

```text
TASK: Implement Phase 2B-1 and Phase 2B-2 only from docs/operations/phase-2b-high-schema-drift-plan.md.

Use the live audit findings already classified there.

Scope:
- Batch 2B-1 — Safe timestamp repairs
- Batch 2B-2 — Safe widening repairs

Do NOT implement Batch 2B-3, 2B-4, 2B-5, or 2B-6 yet.
Do NOT change schema.prisma.
Do NOT touch runtime code.
Do NOT drop columns, constraints, or enum values.
Do NOT use full Prisma diff output.

For Batch 2B-1:
- Use safe, phased timestamptz conversion patterns only.
- Preserve historical meaning.
- Do not invent dates.

For Batch 2B-2:
- Only perform widening changes (smallint→integer, integer→bigint).
- No narrowing.

Return:
1. proposed migration file path
2. exact columns included
3. why each change is safe
4. whether any shadow-column/backfill step is required
5. validation commands to run after authoring
```

## Rollback Strategy

- Take a Neon snapshot before any Phase 2B migration.
- Deploy one batch at a time.
- For timestamp and UUID-sensitive batches, prefer additive shadow-column patterns so rollback can stop at application routing without immediate destructive reversal.
- Never combine enum repairs with nullability hardening in the same deploy.

## Validation Plan

- Re-run `node scripts/full-production-schema-audit.mjs --json` against the same target after each batch.
- Expect HIGH count to fall only for the implemented batch categories.
- Run `pnpm --filter proovra-api exec prisma validate` and `pnpm --filter proovra-api run typecheck` after migration authoring.
- For enum and nullability batches, execute the read-only audit SQL in this document before writing any SQL migration.
