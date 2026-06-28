# Phase 2C-A — Category A LOW Drift Runtime Safety Audit

## Executive summary

- Existing Phase 2C baseline used: `docs/operations/phase-2c-low-schema-drift-audit.md`
- Category A inventory audited: **57**
- Live read-only DB precheck result: **57/57 remain `NOT NULL` with `null_rows = 0`**
- Final Category A statuses:
  - `SAFE_SCHEMA_ONLY`: **52**
  - `SAFE_WITH_SCHEMA_NOTE`: **5**
  - `BLOCKED_MOVE_TO_D`: **0**
- Fields recommended for the later one-shot schema-only implementation: **57**
- Category B quick confirmation:
  - `media_intelligence_records.provider_confidence` remains eligible for a later **DB-only** `DROP NOT NULL` migration
  - DB is currently `NOT NULL`
  - Prisma optionality is intentional
  - runtime analytics code already handles `null`
- Repo write-path audit result:
  - searched create/createMany/upsert/update/updateMany and surrounding helpers for all 57 Category A models
  - found current production write paths in application services only
  - found no separate seed/test/legacy writer that contradicts the DB-required shape for these 57 fields

## Method

1. Extracted the 57 Category A rows from `docs/operations/phase-2c-low-schema-drift-audit.md`.
2. Ran the required read-only DB prechecks for every Category A field:
   - `COUNT(*) FILTER (WHERE column IS NULL)`
   - `information_schema.columns`
3. Ran a repo-wide write-path audit across:
   - `create`
   - `createMany`
   - `upsert`
   - `update`
   - `updateMany`
   - `$transaction` write wrappers
4. Checked whether each field is:
   - always provided by application code
   - provided by a centralized helper before write
   - provided by DB default on create
   - ambiguous enough to block a later schema-only tightening
5. Runtime safety conclusion:
   - no Category A field needs to move to Category D based on current live data or current write paths
   - 42 of the 57 targets currently have `total_rows = 0`; those are still safe because the current create paths require or explicitly set the fields

## Shared write-path evidence

- `G1` Retention policy config
  - `services/api/src/services/lifecycle/retention-engine.service.ts:179`
  - `services/api/src/services/lifecycle/retention-engine.service.ts:268`
- `G2` External review invitation delivery
  - `services/api/src/services/external-review/portal-invitation-email.service.ts:48`
  - `services/api/src/services/external-review/portal-invitation-email.service.ts:54`
  - `services/api/src/services/external-review/portal-invitation-email.service.ts:147`
- `G3` Redaction project, version, region
  - `services/api/src/services/redaction/redaction-project.service.ts:32`
  - `services/api/src/services/redaction/redaction-project.service.ts:80`
  - `services/api/src/services/redaction/redaction-project.service.ts:108`
  - `services/api/src/services/redaction/redaction-project.service.ts:139`
  - `services/api/src/services/redaction/redaction-region.service.ts:29`
  - `services/api/src/services/redaction/redaction-region.service.ts:68`
- `G4` Redaction detection ingest
  - `services/api/src/services/redaction/redaction-detection-providers.service.ts:81`
  - `services/api/src/services/redaction/redaction-detection.service.ts:353`
- `G5` Redaction decision
  - `services/api/src/services/redaction/redaction-decision.service.ts:31`
  - `services/api/src/services/redaction/redaction-decision.service.ts:121`
- `G6` Redaction approval
  - `services/api/src/services/redaction/redaction-approval.service.ts:29`
  - `services/api/src/services/redaction/redaction-approval.service.ts:77`
- `G7` Trust Center article and version
  - `services/api/src/services/trust/trust-center.service.ts:51`
  - `services/api/src/services/trust/trust-center.service.ts:94`
  - `services/api/src/services/trust/trust-center.service.ts:131`
- `G8` Subprocessor registry and version
  - `services/api/src/services/trust/subprocessor.service.ts:25`
  - `services/api/src/services/trust/subprocessor.service.ts:60`
  - `services/api/src/services/trust/subprocessor.service.ts:92`
- `G9` Status page component
  - `services/api/src/services/trust/status-page.service.ts:49`
  - `services/api/src/services/trust/status-page.service.ts:66`
- `G10` Department
  - `services/api/src/services/governance/department.service.ts:20`
  - `services/api/src/services/governance/department.service.ts:45`
- `G11` Governance policy and assignment
  - `services/api/src/services/governance/governance-policy.service.ts:34`
  - `services/api/src/services/governance/governance-policy.service.ts:64`
  - `services/api/src/services/governance/governance-policy.service.ts:142`
  - `services/api/src/services/governance/governance-policy.service.ts:160`
- `G12` Access review campaign and items
  - `services/api/src/services/governance/access-review.service.ts:35`
  - `services/api/src/services/governance/access-review.service.ts:64`
  - `services/api/src/services/governance/access-review.service.ts:80`
  - `services/api/src/services/governance/access-review-escalation.service.ts:79`
- `G13` Cross-org review grant
  - `services/api/src/services/governance/cross-org-review.service.ts:28`
  - `services/api/src/services/governance/cross-org-review.service.ts:49`
- `G14` Media intelligence ingest
  - `services/api/src/services/intelligence/providers/provider-adapter.ts:81`
  - `services/api/src/services/intelligence/media-intelligence.service.ts:63`
  - `services/api/src/services/intelligence/media-intelligence.service.ts:163`
- `G15` Video frame and track detection
  - `services/api/src/services/redaction/video/video-frame.service.ts:42`
  - `services/api/src/services/redaction/video/video-frame.service.ts:114`
  - `services/api/src/services/redaction/video/video-track.service.ts:66`
  - `services/api/src/services/redaction/video/video-track.service.ts:169`

## Category A results

Legend:

- `DB metadata` format: `nullable / data_type / default`
- `Coverage` values:
  - `create explicit` means the write call sets the field directly
  - `createMany explicit` means `createMany` sets the field directly
  - `upsert explicit` means `create` and `update` payloads both set the field where relevant
  - `DB default on create` means the field is omitted by app code but the live DB default guarantees a value
  - `helper-derived` means the final value is computed centrally before the write

| # | table.column | Prisma model.field | Domain | DB null count | DB metadata | Write path(s) | Coverage | Source | Final status | Reason |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `retention_policy_configs.created_by_user_id` | `RetentionPolicyConfig.createdByUserId` | Governance | `0 / 0` | `NO / uuid / null` | `G1` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateRetentionPolicyInput` requires `createdByUserId` and the create payload writes it explicitly. |
| 2 | `external_review_invitation_deliveries.recipient_email` | `ExternalReviewInvitationDelivery.recipientEmail` | Governance / External Review | `0 / 0` | `NO / character varying / null` | `G2` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `SendInvitationEmailInput` requires `recipientEmail` and the create payload persists it after length bounding. |
| 3 | `external_review_invitation_deliveries.subject` | `ExternalReviewInvitationDelivery.subject` | Governance / External Review | `0 / 0` | `NO / character varying / null` | `G2` | `create explicit` | `helper-derived` | `SAFE_WITH_SCHEMA_NOTE` | `subject` is always written, but it is computed centrally before the create call rather than supplied directly by the caller. |
| 4 | `redaction_projects.artifact_kind` | `RedactionProject.artifactKind` | Redaction | `0 / 0` | `NO / character varying / null` | `G3` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `OpenRedactionProjectInput` requires `artifactKind` and the create payload writes it explicitly. |
| 5 | `redaction_versions.authored_by_user_id` | `RedactionVersion.authoredByUserId` | Redaction | `0 / 0` | `NO / uuid / null` | `G3` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateRedactionVersionInput` requires `authoredByUserId` and the create payload writes it explicitly. |
| 6 | `redaction_regions.authored_by_user_id` | `RedactionRegion.authoredByUserId` | Redaction | `0 / 0` | `NO / uuid / null` | `G3` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AddRedactionRegionInput` requires `authoredByUserId` and the create payload writes it explicitly. |
| 7 | `redaction_detections.raw_confidence` | `RedactionDetection.rawConfidence` | Redaction | `0 / 0` | `NO / double precision / null` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `ProviderDetectionRow` requires `rawConfidence` and the detection create path writes it explicitly. |
| 8 | `redaction_detections.confidence_band` | `RedactionDetection.confidenceBand` | Redaction | `0 / 0` | `NO / character varying / null` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `ProviderDetectionRow` requires `confidenceBand` and the detection create path writes it explicitly. |
| 9 | `redaction_detections.kind` | `RedactionDetection.kind` | Redaction | `0 / 0` | `NO / character varying / null` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | The detection create path writes `kind` explicitly for every provider-generated suggestion. |
| 10 | `redaction_detections.suggested_region_kind` | `RedactionDetection.suggestedRegionKind` | Redaction | `0 / 0` | `NO / character varying / null` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `ProviderDetectionRow` requires `suggestedRegionKind` and the detection create path writes it explicitly. |
| 11 | `redaction_detections.suggested_region_geometry` | `RedactionDetection.suggestedRegionGeometry` | Redaction | `0 / 0` | `NO / jsonb / null` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `ProviderDetectionRow` requires `suggestedRegionGeometry` and the detection create path writes it explicitly. |
| 12 | `redaction_detections.suggested_method` | `RedactionDetection.suggestedMethod` | Redaction | `0 / 0` | `NO / character varying / 'BLACKOUT'` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | The DB has a default, but the app already writes `suggestedMethod` explicitly for each detection row. |
| 13 | `redaction_detections.decision_state` | `RedactionDetection.decisionState` | Redaction | `0 / 0` | `NO / character varying / 'SUGGESTED'` | `G4` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | The detection create path explicitly seeds `decisionState: "SUGGESTED"` and later updates it through reviewer actions. |
| 14 | `redaction_decisions.decided_at_utc` | `RedactionDecision.decidedAtUtc` | Redaction | `0 / 0` | `NO / timestamp with time zone / now()` | `G5` | `DB default on create` | `DB default` | `SAFE_WITH_SCHEMA_NOTE` | The create path omits `decidedAtUtc`; the live DB default guarantees it, so a later schema-only tightening needs a Prisma default note or typecheck confirmation. |
| 15 | `redaction_decisions.version_id` | `RedactionDecision.versionId` | Redaction | `0 / 0` | `NO / uuid / null` | `G5` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `RecordDetectionDecisionInput` requires `versionId` and the create payload writes it explicitly. |
| 16 | `redaction_decisions.detection_id` | `RedactionDecision.detectionId` | Redaction | `0 / 0` | `NO / uuid / null` | `G5` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `RecordDetectionDecisionInput` requires `detectionId` and the create payload writes it explicitly. |
| 17 | `redaction_decisions.decision_state` | `RedactionDecision.decisionState` | Redaction | `0 / 0` | `NO / character varying / null` | `G5` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `RecordDetectionDecisionInput` requires `decisionState` and the create payload writes it explicitly. |
| 18 | `redaction_approvals.approver_user_id` | `RedactionApproval.approverUserId` | Redaction | `0 / 0` | `NO / uuid / null` | `G6` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `RecordApprovalInput` requires `approverUserId` and the create payload writes it explicitly. |
| 19 | `redaction_approvals.decided_at_utc` | `RedactionApproval.decidedAtUtc` | Redaction | `0 / 0` | `NO / timestamp with time zone / now()` | `G6` | `DB default on create` | `DB default` | `SAFE_WITH_SCHEMA_NOTE` | The create path omits `decidedAtUtc`; the live DB default guarantees it, so a later schema-only tightening needs a Prisma default note or typecheck confirmation. |
| 20 | `trust_center_articles.summary` | `TrustCenterArticle.summary` | Trust Center | `0 / 122` | `NO / character varying / null` | `G7` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertArticleInput` requires `summary` and the upsert payload writes it explicitly. |
| 21 | `trust_center_articles.body` | `TrustCenterArticle.body` | Trust Center | `0 / 122` | `NO / text / null` | `G7` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertArticleInput` requires `body` and the upsert payload writes it explicitly. |
| 22 | `trust_center_articles.drift_state` | `TrustCenterArticle.driftState` | Trust Center | `0 / 122` | `NO / character varying / 'CURRENT'` | `G7` | `DB default on create` | `DB default` | `SAFE_WITH_SCHEMA_NOTE` | The article upsert create path relies on the DB default for `driftState`, so the later schema-only tightening needs a Prisma default note or typecheck confirmation. |
| 23 | `trust_center_article_versions.title` | `TrustCenterArticleVersion.title` | Trust Center | `0 / 122` | `NO / character varying / null` | `G7` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | Version creation writes `title` explicitly from the same required article input. |
| 24 | `trust_center_article_versions.summary` | `TrustCenterArticleVersion.summary` | Trust Center | `0 / 122` | `NO / character varying / null` | `G7` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | Version creation writes `summary` explicitly from the same required article input. |
| 25 | `trust_center_article_versions.state` | `TrustCenterArticleVersion.state` | Trust Center | `0 / 122` | `NO / character varying / null` | `G7` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | Version creation writes `state` explicitly. |
| 26 | `trust_center_article_versions.authored_by_user_id` | `TrustCenterArticleVersion.authoredByUserId` | Trust Center | `0 / 122` | `NO / uuid / null` | `G7` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertArticleInput` requires `authoredByUserId` and the version create payload writes it explicitly. |
| 27 | `subprocessors.slug` | `Subprocessor.slug` | Trust Center | `0 / 1` | `NO / character varying / null` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertSubprocessorInput` requires `slug` and the upsert payload writes it explicitly. |
| 28 | `subprocessors.vendor` | `Subprocessor.vendor` | Trust Center | `0 / 1` | `NO / character varying / null` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertSubprocessorInput` requires `vendor` and the upsert payload writes it explicitly. |
| 29 | `subprocessors.purpose` | `Subprocessor.purpose` | Trust Center | `0 / 1` | `NO / character varying / null` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertSubprocessorInput` requires `purpose` and the upsert payload writes it explicitly. |
| 30 | `subprocessors.region` | `Subprocessor.region` | Trust Center | `0 / 1` | `NO / character varying / null` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertSubprocessorInput` requires `region` and the upsert payload writes it explicitly. |
| 31 | `subprocessors.data_categories` | `Subprocessor.dataCategories` | Trust Center | `0 / 1` | `NO / jsonb / null` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertSubprocessorInput` requires `dataCategories` and the upsert payload writes it explicitly. |
| 32 | `subprocessors.change_history_summary` | `Subprocessor.changeHistorySummary` | Trust Center | `0 / 1` | `NO / character varying / 'Initial registration'` | `G8` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | The DB has a default, but the upsert payload explicitly writes `changeHistorySummary` from the input `changeSummary`. |
| 33 | `subprocessor_versions.change_summary` | `SubprocessorVersion.changeSummary` | Trust Center | `0 / 0` | `NO / character varying / null` | `G8` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | Version creation writes `changeSummary` explicitly. |
| 34 | `subprocessor_versions.snapshot` | `SubprocessorVersion.snapshot` | Trust Center | `0 / 0` | `NO / jsonb / null` | `G8` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | Version creation writes `snapshot` explicitly. |
| 35 | `status_components.description` | `StatusComponent.description` | Trust Center / Status | `0 / 13` | `NO / character varying / null` | `G9` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `UpsertComponentInput` requires `description` and the upsert payload writes it explicitly. |
| 36 | `status_components.upstream_source` | `StatusComponent.upstreamSource` | Trust Center / Status | `0 / 13` | `NO / character varying / 'LOCAL'` | `G9` | `upsert explicit` | `helper-derived` | `SAFE_WITH_SCHEMA_NOTE` | The upsert payload always writes a value, but it may come from the centralized fallback `input.upstreamSource ?? "LOCAL"`. |
| 37 | `departments.slug` | `Department.slug` | Governance | `0 / 0` | `NO / character varying / null` | `G10` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateDepartmentInput` requires `slug` and the create payload writes it explicitly. |
| 38 | `governance_policies.slug` | `GovernancePolicy.slug` | Governance | `0 / 0` | `NO / character varying / null` | `G11` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreatePolicyInput` requires `slug` and the create payload writes it explicitly. |
| 39 | `governance_policies.summary` | `GovernancePolicy.summary` | Governance | `0 / 0` | `NO / character varying / null` | `G11` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreatePolicyInput` requires `summary` and the create payload writes it explicitly. |
| 40 | `governance_policies.rule` | `GovernancePolicy.rule` | Governance | `0 / 0` | `NO / jsonb / null` | `G11` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreatePolicyInput` requires `rule` and the create payload writes it explicitly. |
| 41 | `governance_policies.version` | `GovernancePolicy.version` | Governance | `0 / 0` | `NO / integer / 1` | `G11` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | The DB has a default, but the create payload explicitly writes `version: 1`. |
| 42 | `governance_policies.created_by_user_id` | `GovernancePolicy.createdByUserId` | Governance | `0 / 0` | `NO / uuid / null` | `G11` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreatePolicyInput` requires `createdByUserId` and the create payload writes it explicitly. |
| 43 | `governance_policy_assignments.scope_target_id` | `GovernancePolicyAssignment.scopeTargetId` | Governance | `0 / 0` | `NO / uuid / null` | `G11` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AssignPolicyInput` requires `scopeTargetId` and the upsert payload writes it explicitly. |
| 44 | `governance_policy_assignments.scope` | `GovernancePolicyAssignment.scope` | Governance | `0 / 0` | `NO / character varying / null` | `G11` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AssignPolicyInput` requires `scope` and the upsert payload writes it explicitly. |
| 45 | `governance_policy_assignments.assigned_by_user_id` | `GovernancePolicyAssignment.assignedByUserId` | Governance | `0 / 0` | `NO / uuid / null` | `G11` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AssignPolicyInput` requires `assignedByUserId` and the upsert payload writes it explicitly. |
| 46 | `access_review_campaigns.name` | `AccessReviewCampaign.name` | Governance | `0 / 0` | `NO / character varying / null` | `G12` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateCampaignInput` requires `name` and the create payload writes it explicitly. |
| 47 | `access_review_campaigns.scheduled_start_utc` | `AccessReviewCampaign.scheduledStartUtc` | Governance | `0 / 0` | `NO / timestamp with time zone / null` | `G12` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateCampaignInput` requires `scheduledStartUtc` and the create payload writes it explicitly. |
| 48 | `access_review_campaigns.scheduled_end_utc` | `AccessReviewCampaign.scheduledEndUtc` | Governance | `0 / 0` | `NO / timestamp with time zone / null` | `G12` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateCampaignInput` requires `scheduledEndUtc` and the create payload writes it explicitly. |
| 49 | `access_review_campaigns.created_by_user_id` | `AccessReviewCampaign.createdByUserId` | Governance | `0 / 0` | `NO / uuid / null` | `G12` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateCampaignInput` requires `createdByUserId` and the create payload writes it explicitly. |
| 50 | `access_review_items.decision` | `AccessReviewItem.decision` | Governance | `0 / 0` | `NO / character varying / 'PENDING'` | `G12` | `createMany explicit` | `app` | `SAFE_SCHEMA_ONLY` | `createMany` explicitly seeds `decision: "PENDING"` and later workflow updates keep the field non-null. |
| 51 | `access_review_items.grant_ref` | `AccessReviewItem.grantRef` | Governance | `0 / 0` | `NO / character varying / null` | `G12` | `createMany explicit` | `app` | `SAFE_SCHEMA_ONLY` | `CreateCampaignInput.items` requires `grantRef` and `createMany` writes it explicitly. |
| 52 | `cross_org_review_grants.inviting_organization_id` | `CrossOrgReviewGrant.invitingOrganizationId` | Governance | `0 / 0` | `NO / uuid / null` | `G13` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `InviteCrossOrgReviewInput` requires `invitingOrganizationId` and the create payload writes it explicitly. |
| 53 | `cross_org_review_grants.invited_org_slug` | `CrossOrgReviewGrant.invitedOrgSlug` | Governance | `0 / 0` | `NO / character varying / null` | `G13` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `InviteCrossOrgReviewInput` requires `invitedOrgSlug` and the create payload writes it explicitly. |
| 54 | `media_intelligence_entities.value_hash` | `MediaIntelligenceEntity.valueHash` | Media Intelligence | `0 / 0` | `NO / character varying / null` | `G14` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AdapterEntityRow` requires `valueHash` and the ingest create path writes it explicitly. |
| 55 | `media_intelligence_entities.raw_confidence` | `MediaIntelligenceEntity.rawConfidence` | Media Intelligence | `0 / 0` | `NO / double precision / null` | `G14` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AdapterEntityRow` requires `rawConfidence` and the ingest create path writes it explicitly. |
| 56 | `video_frames.timestamp_ms` | `VideoFrame.timestampMs` | Redaction / Video | `0 / 0` | `NO / bigint / null` | `G15` | `create explicit` | `app` | `SAFE_SCHEMA_ONLY` | `RegisterFrameInput` requires `timestampMs` and the create payload writes it explicitly. |
| 57 | `video_track_detections.raw_confidence` | `VideoTrackDetection.rawConfidence` | Redaction / Video | `0 / 0` | `NO / double precision / null` | `G15` | `upsert explicit` | `app` | `SAFE_SCHEMA_ONLY` | `AppendTrackDetectionInput` requires `rawConfidence` and the upsert payload writes it explicitly. |

## Category A count summary

- Original Category A count: **57**
- `SAFE_SCHEMA_ONLY`: **52**
- `SAFE_WITH_SCHEMA_NOTE`: **5**
- `BLOCKED_MOVE_TO_D`: **0**

## Final one-shot implementation list

These are the exact `schema.prisma` fields recommended for the later one-shot schema-only implementation.

- `RetentionPolicyConfig.createdByUserId`
- `ExternalReviewInvitationDelivery.recipientEmail`
- `ExternalReviewInvitationDelivery.subject`
- `RedactionProject.artifactKind`
- `RedactionVersion.authoredByUserId`
- `RedactionRegion.authoredByUserId`
- `RedactionDetection.rawConfidence`
- `RedactionDetection.confidenceBand`
- `RedactionDetection.kind`
- `RedactionDetection.suggestedRegionKind`
- `RedactionDetection.suggestedRegionGeometry`
- `RedactionDetection.suggestedMethod`
- `RedactionDetection.decisionState`
- `RedactionDecision.decidedAtUtc`
- `RedactionDecision.versionId`
- `RedactionDecision.detectionId`
- `RedactionDecision.decisionState`
- `RedactionApproval.approverUserId`
- `RedactionApproval.decidedAtUtc`
- `TrustCenterArticle.summary`
- `TrustCenterArticle.body`
- `TrustCenterArticle.driftState`
- `TrustCenterArticleVersion.title`
- `TrustCenterArticleVersion.summary`
- `TrustCenterArticleVersion.state`
- `TrustCenterArticleVersion.authoredByUserId`
- `Subprocessor.slug`
- `Subprocessor.vendor`
- `Subprocessor.purpose`
- `Subprocessor.region`
- `Subprocessor.dataCategories`
- `Subprocessor.changeHistorySummary`
- `SubprocessorVersion.changeSummary`
- `SubprocessorVersion.snapshot`
- `StatusComponent.description`
- `StatusComponent.upstreamSource`
- `Department.slug`
- `GovernancePolicy.slug`
- `GovernancePolicy.summary`
- `GovernancePolicy.rule`
- `GovernancePolicy.version`
- `GovernancePolicy.createdByUserId`
- `GovernancePolicyAssignment.scopeTargetId`
- `GovernancePolicyAssignment.scope`
- `GovernancePolicyAssignment.assignedByUserId`
- `AccessReviewCampaign.name`
- `AccessReviewCampaign.scheduledStartUtc`
- `AccessReviewCampaign.scheduledEndUtc`
- `AccessReviewCampaign.createdByUserId`
- `AccessReviewItem.decision`
- `AccessReviewItem.grantRef`
- `CrossOrgReviewGrant.invitingOrganizationId`
- `CrossOrgReviewGrant.invitedOrgSlug`
- `MediaIntelligenceEntity.valueHash`
- `MediaIntelligenceEntity.rawConfidence`
- `VideoFrame.timestampMs`
- `VideoTrackDetection.rawConfidence`

## Final blocked list

- None.
- No Category A field had `null_rows > 0`.
- No Category A field had an unresolved runtime write-path ambiguity significant enough to move it to Category D.

## Category B quick confirmation

`media_intelligence_records.provider_confidence` remains eligible for a later DB-only migration.

- Live DB metadata: `NOT NULL / double precision / default null`
- Live null precheck: `0 / 0`
- Prisma optionality remains intentional
- Runtime evidence:
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:84`
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:349`
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:358`
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:371`
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:425`
  - `services/api/src/services/intelligence/intelligence-quality.service.ts:440`
- Why it remains Category B:
  - analytics code already models `providerConfidence` as `number | null`
  - skip-null averaging is already implemented
  - no downstream reader audited here assumes the value always exists
  - the safe direction is still DB relaxation, not Prisma tightening

## Validation plan for the later implementation

1. Update only the 57 listed `schema.prisma` fields from optional to required.
2. For the 5 `SAFE_WITH_SCHEMA_NOTE` fields, confirm Prisma-side default handling or typecheck behavior during the implementation:
   - `ExternalReviewInvitationDelivery.subject`
   - `RedactionDecision.decidedAtUtc`
   - `RedactionApproval.decidedAtUtc`
   - `TrustCenterArticle.driftState`
   - `StatusComponent.upstreamSource`
3. Run:

```bash
pnpm --filter proovra-api exec prisma validate
pnpm --filter proovra-api exec prisma generate
pnpm --filter proovra-api run typecheck
```

4. Run focused API tests around the touched domains first.
5. Run full API tests if focused tests pass.
6. After deploy, rerun the production audit and confirm:
   - `LOW` count drops by exactly **57**
   - Category B remains the only intentional non-Category-D LOW drift unless other live data changed

## Exact next implementation prompt

```text
TASK: Phase 2C-B — Implement Verified Category A LOW Schema-Only Tightenings

Context:
Use docs/operations/phase-2c-a-runtime-safety-audit.md as the source of truth.
Phase 2C-A verified:
- original Category A count: 57
- SAFE_SCHEMA_ONLY: 52
- SAFE_WITH_SCHEMA_NOTE: 5
- BLOCKED_MOVE_TO_D: 0

Goal:
Implement the 57 verified Category A schema-only Prisma tightenings.

Rules:
- Change only the exact 57 schema.prisma fields listed in the Phase 2C-A audit doc.
- Do NOT change Category B.
- Do NOT change Category D.
- Do NOT create SQL migrations in this step.
- Do NOT modify runtime logic unless a tiny mechanical compile fix is strictly required by the Prisma schema tightening.
- Do NOT broaden scope beyond these verified Category A fields.

Implementation requirements:
1. Update the exact 57 Prisma fields from optional to required.
2. For the 5 SAFE_WITH_SCHEMA_NOTE fields, preserve the current runtime semantics and make the minimum Prisma-side adjustment needed so typecheck passes without weakening the DB-canonical contract.
3. Run:
   - pnpm --filter proovra-api exec prisma validate
   - pnpm --filter proovra-api exec prisma generate
   - pnpm --filter proovra-api run typecheck
4. Run focused tests for the touched domains.
5. Run full API tests if focused tests pass.

Final report:
- fields changed
- any mechanical runtime fixes required, if any
- validation results
- focused test results
- full API test result
- confirmation Category B was not touched
- confirmation no migrations were created
```
