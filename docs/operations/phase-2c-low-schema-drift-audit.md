# Phase 2C — LOW Schema Drift Audit & One-Shot Implementation Plan

## Executive summary

- Source of truth used here: the live Phase 2B audit snapshot at `D:\digital-witness\tmp_phase2b_audit.json`, plus the operator-provided current production baseline (`CRITICAL 0 / HIGH 0 / MEDIUM 0 / LOW 79`).
- Limitation: a fresh live rerun was attempted from this workstation but failed DNS resolution against the production `postgres` host, so this document transparently treats the preserved live snapshot as the working LOW inventory. The prompt-confirmed unchanged LOW count (`79`) makes that a reasonable planning baseline, but the exact prechecks below should still be run again immediately before implementation.
- LOW findings audited: **79**. Classification counts: **A=57**, **B=1**, **C=0**, **D=21**, **E=0**.
- One-shot implementation shape if Phase 2C proceeds now: **57 schema-only Prisma tightenings**, **1 DB-only relaxations**, **0 mixed items**, **21 deferred/manual items**.
- Recommended posture: implement only the clearly safe schema-only and DB-relaxation items after fresh read-only prechecks; keep the tenancy- and audit-semantics cluster out of the one-shot batch.

## Current production audit baseline

- Prisma migrate status: `Database schema is up to date` (per operator-provided baseline).
- Tables expected/present/missing: `240 / 240 / 0`.
- Columns expected/missing: `3499 / 0`.
- Severity counts: `CRITICAL 0`, `HIGH 0`, `MEDIUM 0`, `LOW 79`.
- LOW kind inventory available from the preserved live snapshot: all 79 are `NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL`.
- Meaning of this LOW class: DB currently enforces `NOT NULL`, while Prisma still marks the field optional. Reads are usually safe; the remaining question is which side is canonical for each field.

## Full LOW findings table

| # | Table.column | Prisma model.field | Domain | Finding type | DB shape | Prisma shape | Category | Canonical side | Later action | Risk | Reason |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | team_members.access_granted_at_utc | TeamMember.accessGrantedAtUtc | Identity / Access Lifecycle | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | accessGrantedAtUtc    DateTime?        @map("access_granted_at_utc") @db.Timestamptz(6) | D | defer | manual review before any schema or DB change | high | Access-grant timestamp is lifecycle/audit semantics; current runtime reads it but the safe canonical rule for pre-Phase-17 members still needs explicit review. |
| 2 | workspace_governance_policies.metadata_redaction_default | WorkspaceGovernancePolicy.metadataRedactionDefault | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | metadataRedactionDefault Json? @map("metadata_redaction_default") | D | defer | manual review before any schema or DB change | high | Null means "no override" in code, and this column previously carried a semantic type drift; do not relax or tighten it blindly. |
| 3 | upload_sessions.team_id | UploadSession.teamId | Evidence Lifecycle | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId     String? @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on the evidence upload lifecycle; Phase 2C should not change tenancy semantics blindly. |
| 4 | evidence_intelligence_jobs.team_id | EvidenceIntelligenceJob.teamId | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId         String?                       @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on async intelligence jobs; changing optionality needs a dedicated tenancy review. |
| 5 | evidence_extracted_texts.team_id | EvidenceExtractedText.teamId | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId          String?                     @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on extracted-text rows; keep out of the one-shot LOW batch. |
| 6 | evidence_entities.team_id | EvidenceEntity.teamId | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId          String?              @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on entity rows; keep out of Phase 2C one-shot implementation. |
| 7 | evidence_semantic_chunks.team_id | EvidenceSemanticChunk.teamId | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId              String?                      @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on semantic indexing rows; safe canonical direction needs separate review. |
| 8 | evidence_similarities.team_id | EvidenceSimilarity.teamId | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId           String?                @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Workspace tenancy field on similarity graph rows; keep out of the LOW batch. |
| 9 | discussion_threads.team_id | DiscussionThread.teamId | Collaboration | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId            String? @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Collaboration tenancy field; current writes supply it, but Phase 2C should not tighten or relax collaboration tenancy blindly. |
| 10 | discussion_messages.team_id | DiscussionMessage.teamId | Collaboration | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId   String? @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Collaboration tenancy field; defer until the collaboration data model is reviewed end-to-end. |
| 11 | discussion_participants.team_id | DiscussionParticipant.teamId | Collaboration | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId          String?                   @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Collaboration tenancy field; do not change blindly inside the LOW one-shot batch. |
| 12 | evidence_exchange_package_deliveries.channel | EvidenceExchangePackageDelivery.channel | Evidence Lifecycle | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | channel          String?   @db.VarChar(40) | D | defer | manual review before any schema or DB change | high | Package-delivery channel is evidence/package lifecycle data; current service defaults it, but this flow is explicitly out of scope for blind LOW fixes. |
| 13 | evidence_exchange_package_deliveries.delivered_at_utc | EvidenceExchangePackageDelivery.deliveredAtUtc | Evidence Lifecycle | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | deliveredAtUtc   DateTime? @map("delivered_at_utc") @db.Timestamptz(6) | D | defer | manual review before any schema or DB change | high | Delivery timestamp carries package-lifecycle meaning; Phase 2C should not invent or reinterpret it. |
| 14 | retention_policy_configs.created_by_user_id | RetentionPolicyConfig.createdByUserId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | createdByUserId String?  @map("created_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Current retention-policy create path always supplies createdByUserId, so the DB-required shape is the active canonical contract. |
| 15 | external_review_invitation_deliveries.recipient_email | ExternalReviewInvitationDelivery.recipientEmail | Governance / External Review | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | recipientEmail   String?   @map("recipient_email") @db.VarChar(320) | A | DB | schema.prisma change only | low | Portal invitation delivery writes always persist recipientEmail; Prisma optionality is stale compatibility drift. |
| 16 | external_review_invitation_deliveries.subject | ExternalReviewInvitationDelivery.subject | Governance / External Review | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | subject          String?   @db.VarChar(400) | A | DB | schema.prisma change only | low | Portal invitation delivery writes always persist subject; Prisma optionality is stale compatibility drift. |
| 17 | redaction_projects.artifact_kind | RedactionProject.artifactKind | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | artifactKind    String?   @map("artifact_kind") @db.VarChar(40) | A | DB | schema.prisma change only | medium | Redaction project creation requires artifactKind and downstream derivative logic casts it as canonical. |
| 18 | redaction_versions.authored_by_user_id | RedactionVersion.authoredByUserId | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | authoredByUserId String?   @map("authored_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Version creation writes authoredByUserId every time; Prisma optionality is a legacy compatibility holdover. |
| 19 | redaction_regions.authored_by_user_id | RedactionRegion.authoredByUserId | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | authoredByUserId  String?  @map("authored_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Region creation writes authoredByUserId every time; the DB-required contract matches current runtime. |
| 20 | redaction_detections.raw_confidence | RedactionDetection.rawConfidence | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | rawConfidence           Float?   @map("raw_confidence") | A | DB | schema.prisma change only | medium | Detection orchestrator persists rawConfidence for every new suggestion row. |
| 21 | redaction_detections.confidence_band | RedactionDetection.confidenceBand | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | confidenceBand          String?  @map("confidence_band") @db.VarChar(20) | A | DB | schema.prisma change only | medium | Detection orchestrator persists confidenceBand for every new suggestion row. |
| 22 | redaction_detections.kind | RedactionDetection.kind | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | kind                    String?  @db.VarChar(40) | A | DB | schema.prisma change only | medium | Detection orchestrator persists kind as the canonical additive field. |
| 23 | redaction_detections.suggested_region_kind | RedactionDetection.suggestedRegionKind | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | suggestedRegionKind     String?  @map("suggested_region_kind") @db.VarChar(40) | A | DB | schema.prisma change only | medium | Detection orchestrator persists suggestedRegionKind for every provider-generated suggestion row. |
| 24 | redaction_detections.suggested_region_geometry | RedactionDetection.suggestedRegionGeometry | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | suggestedRegionGeometry Json?    @map("suggested_region_geometry") | A | DB | schema.prisma change only | medium | Detection orchestrator persists suggestedRegionGeometry for every provider-generated suggestion row. |
| 25 | redaction_detections.suggested_method | RedactionDetection.suggestedMethod | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | suggestedMethod         String?  @map("suggested_method") @db.VarChar(40) | A | DB | schema.prisma change only | medium | Detection orchestrator persists suggestedMethod for every provider-generated suggestion row. |
| 26 | redaction_detections.decision_state | RedactionDetection.decisionState | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | decisionState           String?  @map("decision_state") @db.VarChar(20) | A | DB | schema.prisma change only | medium | Detection orchestrator seeds decisionState as SUGGESTED on create and updates it on reviewer action. |
| 27 | redaction_decisions.decided_at_utc | RedactionDecision.decidedAtUtc | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | decidedAtUtc           DateTime? @map("decided_at_utc") @db.Timestamptz(6) | A | DB | schema.prisma change only | medium | Decision rows are decision events; verify the live default first, then tighten Prisma to the DB-required contract. |
| 28 | redaction_decisions.version_id | RedactionDecision.versionId | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | versionId              String?   @map("version_id") @db.Uuid | A | DB | schema.prisma change only | medium | Decision creation always writes versionId; DB-required shape matches the runtime. |
| 29 | redaction_decisions.detection_id | RedactionDecision.detectionId | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | detectionId            String?   @map("detection_id") @db.Uuid | A | DB | schema.prisma change only | medium | Decision creation always writes detectionId; DB-required shape matches the runtime. |
| 30 | redaction_decisions.decision_state | RedactionDecision.decisionState | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | decisionState          String?   @map("decision_state") @db.VarChar(20) | A | DB | schema.prisma change only | medium | Decision creation always writes decisionState; DB-required shape matches the runtime. |
| 31 | redaction_approvals.approver_user_id | RedactionApproval.approverUserId | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | approverUserId   String?   @map("approver_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Approval creation always writes approverUserId; DB-required shape matches the active workflow. |
| 32 | redaction_approvals.decided_at_utc | RedactionApproval.decidedAtUtc | Redaction | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | decidedAtUtc     DateTime? @map("decided_at_utc") @db.Timestamptz(6) | A | DB | schema.prisma change only | medium | Approval rows are decision events; verify the live default first, then tighten Prisma to the DB-required contract. |
| 33 | trust_center_articles.team_id | TrustCenterArticle.teamId | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId                   String?   @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Trust Center tenancy field; current writes supply it, but Phase 2C should not change workspace-tenancy semantics blindly. |
| 34 | trust_center_articles.summary | TrustCenterArticle.summary | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | summary                  String?   @db.VarChar(800) | A | DB | schema.prisma change only | medium | Trust article upsert always writes summary; Prisma optionality is stale compatibility drift. |
| 35 | trust_center_articles.body | TrustCenterArticle.body | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | body                     String? | A | DB | schema.prisma change only | medium | Trust article upsert always writes body; Prisma optionality is stale compatibility drift. |
| 36 | trust_center_articles.drift_state | TrustCenterArticle.driftState | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | driftState               String?   @map("drift_state") @db.VarChar(30) | A | DB | schema.prisma change only | medium | Trust drift scan writes driftState as a bounded canonical field; Prisma optionality is stale. |
| 37 | trust_center_article_versions.team_id | TrustCenterArticleVersion.teamId | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId                   String?   @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Trust article version tenancy field; keep it out of the one-shot LOW batch. |
| 38 | trust_center_article_versions.title | TrustCenterArticleVersion.title | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | title                    String?   @db.VarChar(300) | A | DB | schema.prisma change only | medium | Trust article version creation always writes title; Prisma optionality is stale compatibility drift. |
| 39 | trust_center_article_versions.summary | TrustCenterArticleVersion.summary | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | summary                  String?   @db.VarChar(800) | A | DB | schema.prisma change only | medium | Trust article version creation always writes summary; Prisma optionality is stale compatibility drift. |
| 40 | trust_center_article_versions.state | TrustCenterArticleVersion.state | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | state                    String?   @db.VarChar(20) | A | DB | schema.prisma change only | medium | Trust article version creation always writes state; Prisma optionality is stale compatibility drift. |
| 41 | trust_center_article_versions.authored_by_user_id | TrustCenterArticleVersion.authoredByUserId | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | authoredByUserId         String?   @map("authored_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Trust article version creation always writes authoredByUserId; Prisma optionality is stale compatibility drift. |
| 42 | subprocessors.team_id | Subprocessor.teamId | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId               String?  @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Subprocessor registry tenancy field; keep it out of the one-shot LOW batch. |
| 43 | subprocessors.slug | Subprocessor.slug | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | slug                 String?  @db.VarChar(120) | A | DB | schema.prisma change only | medium | Subprocessor upsert keys on slug and always writes it; DB-required shape is canonical. |
| 44 | subprocessors.vendor | Subprocessor.vendor | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | vendor               String?  @db.VarChar(200) | A | DB | schema.prisma change only | medium | Subprocessor upsert always writes vendor; Prisma optionality is stale compatibility drift. |
| 45 | subprocessors.purpose | Subprocessor.purpose | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | purpose              String?  @db.VarChar(600) | A | DB | schema.prisma change only | medium | Subprocessor upsert always writes purpose; Prisma optionality is stale compatibility drift. |
| 46 | subprocessors.region | Subprocessor.region | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | region               String?  @db.VarChar(80) | A | DB | schema.prisma change only | medium | Subprocessor upsert always writes region; Prisma optionality is stale compatibility drift. |
| 47 | subprocessors.data_categories | Subprocessor.dataCategories | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | dataCategories       Json?    @map("data_categories") | A | DB | schema.prisma change only | medium | Subprocessor upsert always writes dataCategories; DB-required shape is canonical. |
| 48 | subprocessors.change_history_summary | Subprocessor.changeHistorySummary | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | changeHistorySummary String?  @map("change_history_summary") @db.VarChar(800) | A | DB | schema.prisma change only | medium | Subprocessor upsert always writes changeHistorySummary; Prisma optionality is stale compatibility drift. |
| 49 | subprocessor_versions.team_id | SubprocessorVersion.teamId | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId           String?   @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Subprocessor version tenancy field; keep it out of the one-shot LOW batch. |
| 50 | subprocessor_versions.change_summary | SubprocessorVersion.changeSummary | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | changeSummary    String?   @map("change_summary") @db.VarChar(800) | A | DB | schema.prisma change only | medium | Subprocessor version creation always writes changeSummary; Prisma optionality is stale compatibility drift. |
| 51 | subprocessor_versions.snapshot | SubprocessorVersion.snapshot | Trust Center | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | snapshot         Json? | A | DB | schema.prisma change only | medium | Subprocessor version creation always writes snapshot; DB-required shape is canonical. |
| 52 | status_components.description | StatusComponent.description | Trust Center / Status | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | description       String?  @db.VarChar(400) | A | DB | schema.prisma change only | medium | Status component upsert always writes description; Prisma optionality is stale compatibility drift. |
| 53 | status_components.team_id | StatusComponent.teamId | Trust Center / Status | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | teamId            String?  @map("team_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Status component tenancy field; keep it out of the one-shot LOW batch. |
| 54 | status_components.upstream_source | StatusComponent.upstreamSource | Trust Center / Status | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | upstreamSource    String?  @map("upstream_source") @db.VarChar(80) | A | DB | schema.prisma change only | medium | Status component upsert always writes upstreamSource with LOCAL fallback; DB-required shape is canonical. |
| 55 | departments.organization_id | Department.organizationId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | organizationId  String?  @map("organization_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Department hierarchy field is governance-critical; current create path requires it, but Phase 2C should not tighten or relax org-scope semantics blindly. |
| 56 | departments.slug | Department.slug | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | slug            String?  @db.VarChar(120) | A | DB | schema.prisma change only | medium | Department creation always writes slug and duplicate checks depend on it; DB-required shape is canonical. |
| 57 | delegated_admin_grants.organization_id | DelegatedAdminGrant.organizationId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | organizationId  String?   @map("organization_id") @db.Uuid | D | defer | manual review before any schema or DB change | high | Delegated-admin org scope has a schema comment that permits org-less grants for some tiers, while current writes require organizationId; resolve that conflict first. |
| 58 | governance_policies.slug | GovernancePolicy.slug | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | slug            String?  @db.VarChar(120) | A | DB | schema.prisma change only | medium | Policy creation always writes slug and downstream resolution keys depend on it. |
| 59 | governance_policies.summary | GovernancePolicy.summary | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | summary         String?  @db.VarChar(600) | A | DB | schema.prisma change only | medium | Policy creation always writes summary; Prisma optionality is stale compatibility drift. |
| 60 | governance_policies.rule | GovernancePolicy.rule | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | rule            Json? | A | DB | schema.prisma change only | medium | Policy creation always writes rule JSON; DB-required shape is canonical. |
| 61 | governance_policies.version | GovernancePolicy.version | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | version         Int?     @default(1) | A | DB | schema.prisma change only | medium | Policy creation always seeds version 1; DB-required shape is canonical. |
| 62 | governance_policies.created_by_user_id | GovernancePolicy.createdByUserId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | createdByUserId String?  @map("created_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Policy creation always writes createdByUserId; Prisma optionality is stale compatibility drift. |
| 63 | governance_policy_assignments.scope_target_id | GovernancePolicyAssignment.scopeTargetId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | scopeTargetId     String?  @map("scope_target_id") @db.Uuid | A | DB | schema.prisma change only | medium | Governance policy assignment writes always provide scopeTargetId in the current runtime contract. |
| 64 | governance_policy_assignments.scope | GovernancePolicyAssignment.scope | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | scope             String?  @db.VarChar(40) | A | DB | schema.prisma change only | medium | Governance policy assignment writes use scope as the canonical field, not legacy scopeKind. |
| 65 | governance_policy_assignments.assigned_by_user_id | GovernancePolicyAssignment.assignedByUserId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | assignedByUserId  String?  @map("assigned_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Governance policy assignment writes always provide assignedByUserId. |
| 66 | access_review_campaigns.name | AccessReviewCampaign.name | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | name              String?   @db.VarChar(300) | A | DB | schema.prisma change only | medium | Access review campaign creation always writes name as the canonical display field. |
| 67 | access_review_campaigns.scheduled_start_utc | AccessReviewCampaign.scheduledStartUtc | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | scheduledStartUtc DateTime? @map("scheduled_start_utc") @db.Timestamptz(6) | A | DB | schema.prisma change only | medium | Access review campaign creation always writes scheduledStartUtc. |
| 68 | access_review_campaigns.scheduled_end_utc | AccessReviewCampaign.scheduledEndUtc | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | scheduledEndUtc   DateTime? @map("scheduled_end_utc") @db.Timestamptz(6) | A | DB | schema.prisma change only | medium | Access review campaign creation always writes scheduledEndUtc. |
| 69 | access_review_campaigns.created_by_user_id | AccessReviewCampaign.createdByUserId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | createdByUserId   String?   @map("created_by_user_id") @db.Uuid | A | DB | schema.prisma change only | medium | Access review campaign creation always writes createdByUserId. |
| 70 | access_review_items.decision | AccessReviewItem.decision | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | decision       String?   @db.VarChar(20) | A | DB | schema.prisma change only | medium | Access review item creation seeds decision=PENDING and later updates it from the review workflow. |
| 71 | access_review_items.grant_ref | AccessReviewItem.grantRef | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | grantRef       String?   @map("grant_ref") @db.VarChar(200) | A | DB | schema.prisma change only | medium | Access review item creation always writes grantRef as the bounded grant pointer. |
| 72 | cross_org_review_grants.inviting_organization_id | CrossOrgReviewGrant.invitingOrganizationId | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | invitingOrganizationId String?   @map("inviting_organization_id") @db.Uuid | A | DB | schema.prisma change only | medium | Cross-org review invite creation always writes invitingOrganizationId and current enforcement depends on it. |
| 73 | cross_org_review_grants.invited_org_slug | CrossOrgReviewGrant.invitedOrgSlug | Governance | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | invitedOrgSlug         String?   @map("invited_org_slug") @db.VarChar(120) | A | DB | schema.prisma change only | medium | Cross-org review invite creation always writes invitedOrgSlug and current enforcement depends on it. |
| 74 | media_intelligence_records.provider_confidence | MediaIntelligenceRecord.providerConfidence | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | providerConfidence     Float?    @map("provider_confidence") | B | Prisma | DB migration only | medium | Current analytics code treats null providerConfidence as a valid state for legacy/provider-no-confidence rows; DB NOT NULL is over-strict. |
| 75 | media_intelligence_entities.value_hash | MediaIntelligenceEntity.valueHash | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | valueHash      String?  @map("value_hash") @db.VarChar(64) | A | DB | schema.prisma change only | medium | Media intelligence entity ingest always writes valueHash from the adapter contract. |
| 76 | media_intelligence_entities.raw_confidence | MediaIntelligenceEntity.rawConfidence | Media Intelligence | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | rawConfidence  Float?   @map("raw_confidence") | A | DB | schema.prisma change only | medium | Media intelligence entity ingest always writes rawConfidence from the adapter contract. |
| 77 | security_claim_checks.last_verified_at | SecurityClaimCheck.lastVerifiedAt | Trust Center / Security | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | lastVerifiedAt             DateTime? @map("last_verified_at") @db.Timestamptz(6) | D | defer | manual review before any schema or DB change | high | Governance verification timestamp; current writes set it, but changing this timestamp contract should happen only after semantic review. |
| 78 | video_frames.timestamp_ms | VideoFrame.timestampMs | Redaction / Video | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | timestampMs   BigInt?  @map("timestamp_ms") | A | DB | schema.prisma change only | medium | Video frame registration requires timestampMs and downstream timeline code treats it as canonical. |
| 79 | video_track_detections.raw_confidence | VideoTrackDetection.rawConfidence | Redaction / Video | NULLABLE_DB_NOT_NULL_PRISMA_OPTIONAL | NOT NULL; live type must be reconfirmed via information_schema | rawConfidence Float? @map("raw_confidence") | A | DB | schema.prisma change only | medium | Video track detection upsert always writes rawConfidence; DB-required shape is canonical. |

### Classification legend

- `A` — Prisma should match DB. DB is stricter/canonical; later fix is `schema.prisma` optional -> required.
- `B` — DB should match Prisma. Prisma optionality is intentional; later fix is `ALTER TABLE ... DROP NOT NULL`.
- `C` — Intentional mismatch / leave as-is.
- `D` — Needs runtime/code review before deciding.
- `E` — Legacy residue / cleanup later.

## Canonical side decisions

- Canonical DB / schema-only later: 57 findings.
- Canonical Prisma / DB-relaxation later: 1 findings.
- Intentional leave-as-is: 0 findings.
- Manual review before any change: 21 findings.
- Legacy-cleanup-later: 0 findings.

## Read-only precheck SQL for every LOW finding

Run both queries for every item immediately before implementation. The null-count query answers whether schema tightening is safe; the metadata query answers whether the current DB still matches the preserved snapshot and whether inserts rely on a DB default.

### team_members.access_granted_at_utc

- Prisma field: `TeamMember.accessGrantedAtUtc`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'team_members.access_granted_at_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "access_granted_at_utc" IS NULL) AS null_rows
FROM "team_members";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'team_members'
  AND column_name = 'access_granted_at_utc';
```

### workspace_governance_policies.metadata_redaction_default

- Prisma field: `WorkspaceGovernancePolicy.metadataRedactionDefault`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'workspace_governance_policies.metadata_redaction_default' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "metadata_redaction_default" IS NULL) AS null_rows
FROM "workspace_governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'workspace_governance_policies'
  AND column_name = 'metadata_redaction_default';
```

### upload_sessions.team_id

- Prisma field: `UploadSession.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'upload_sessions.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "upload_sessions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'upload_sessions'
  AND column_name = 'team_id';
```

### evidence_intelligence_jobs.team_id

- Prisma field: `EvidenceIntelligenceJob.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_intelligence_jobs.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "evidence_intelligence_jobs";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_intelligence_jobs'
  AND column_name = 'team_id';
```

### evidence_extracted_texts.team_id

- Prisma field: `EvidenceExtractedText.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_extracted_texts.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "evidence_extracted_texts";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_extracted_texts'
  AND column_name = 'team_id';
```

### evidence_entities.team_id

- Prisma field: `EvidenceEntity.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_entities.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "evidence_entities";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_entities'
  AND column_name = 'team_id';
```

### evidence_semantic_chunks.team_id

- Prisma field: `EvidenceSemanticChunk.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_semantic_chunks.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "evidence_semantic_chunks";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_semantic_chunks'
  AND column_name = 'team_id';
```

### evidence_similarities.team_id

- Prisma field: `EvidenceSimilarity.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_similarities.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "evidence_similarities";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_similarities'
  AND column_name = 'team_id';
```

### discussion_threads.team_id

- Prisma field: `DiscussionThread.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'discussion_threads.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "discussion_threads";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'discussion_threads'
  AND column_name = 'team_id';
```

### discussion_messages.team_id

- Prisma field: `DiscussionMessage.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'discussion_messages.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "discussion_messages";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'discussion_messages'
  AND column_name = 'team_id';
```

### discussion_participants.team_id

- Prisma field: `DiscussionParticipant.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'discussion_participants.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "discussion_participants";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'discussion_participants'
  AND column_name = 'team_id';
```

### evidence_exchange_package_deliveries.channel

- Prisma field: `EvidenceExchangePackageDelivery.channel`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_exchange_package_deliveries.channel' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "channel" IS NULL) AS null_rows
FROM "evidence_exchange_package_deliveries";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_exchange_package_deliveries'
  AND column_name = 'channel';
```

### evidence_exchange_package_deliveries.delivered_at_utc

- Prisma field: `EvidenceExchangePackageDelivery.deliveredAtUtc`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'evidence_exchange_package_deliveries.delivered_at_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "delivered_at_utc" IS NULL) AS null_rows
FROM "evidence_exchange_package_deliveries";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'evidence_exchange_package_deliveries'
  AND column_name = 'delivered_at_utc';
```

### retention_policy_configs.created_by_user_id

- Prisma field: `RetentionPolicyConfig.createdByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'retention_policy_configs.created_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "created_by_user_id" IS NULL) AS null_rows
FROM "retention_policy_configs";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'retention_policy_configs'
  AND column_name = 'created_by_user_id';
```

### external_review_invitation_deliveries.recipient_email

- Prisma field: `ExternalReviewInvitationDelivery.recipientEmail`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'external_review_invitation_deliveries.recipient_email' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "recipient_email" IS NULL) AS null_rows
FROM "external_review_invitation_deliveries";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'external_review_invitation_deliveries'
  AND column_name = 'recipient_email';
```

### external_review_invitation_deliveries.subject

- Prisma field: `ExternalReviewInvitationDelivery.subject`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'external_review_invitation_deliveries.subject' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "subject" IS NULL) AS null_rows
FROM "external_review_invitation_deliveries";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'external_review_invitation_deliveries'
  AND column_name = 'subject';
```

### redaction_projects.artifact_kind

- Prisma field: `RedactionProject.artifactKind`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_projects.artifact_kind' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "artifact_kind" IS NULL) AS null_rows
FROM "redaction_projects";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_projects'
  AND column_name = 'artifact_kind';
```

### redaction_versions.authored_by_user_id

- Prisma field: `RedactionVersion.authoredByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_versions.authored_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "authored_by_user_id" IS NULL) AS null_rows
FROM "redaction_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_versions'
  AND column_name = 'authored_by_user_id';
```

### redaction_regions.authored_by_user_id

- Prisma field: `RedactionRegion.authoredByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_regions.authored_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "authored_by_user_id" IS NULL) AS null_rows
FROM "redaction_regions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_regions'
  AND column_name = 'authored_by_user_id';
```

### redaction_detections.raw_confidence

- Prisma field: `RedactionDetection.rawConfidence`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.raw_confidence' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "raw_confidence" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'raw_confidence';
```

### redaction_detections.confidence_band

- Prisma field: `RedactionDetection.confidenceBand`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.confidence_band' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "confidence_band" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'confidence_band';
```

### redaction_detections.kind

- Prisma field: `RedactionDetection.kind`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.kind' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "kind" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'kind';
```

### redaction_detections.suggested_region_kind

- Prisma field: `RedactionDetection.suggestedRegionKind`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.suggested_region_kind' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "suggested_region_kind" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'suggested_region_kind';
```

### redaction_detections.suggested_region_geometry

- Prisma field: `RedactionDetection.suggestedRegionGeometry`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.suggested_region_geometry' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "suggested_region_geometry" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'suggested_region_geometry';
```

### redaction_detections.suggested_method

- Prisma field: `RedactionDetection.suggestedMethod`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.suggested_method' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "suggested_method" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'suggested_method';
```

### redaction_detections.decision_state

- Prisma field: `RedactionDetection.decisionState`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_detections.decision_state' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "decision_state" IS NULL) AS null_rows
FROM "redaction_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_detections'
  AND column_name = 'decision_state';
```

### redaction_decisions.decided_at_utc

- Prisma field: `RedactionDecision.decidedAtUtc`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_decisions.decided_at_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "decided_at_utc" IS NULL) AS null_rows
FROM "redaction_decisions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_decisions'
  AND column_name = 'decided_at_utc';
```

### redaction_decisions.version_id

- Prisma field: `RedactionDecision.versionId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_decisions.version_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "version_id" IS NULL) AS null_rows
FROM "redaction_decisions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_decisions'
  AND column_name = 'version_id';
```

### redaction_decisions.detection_id

- Prisma field: `RedactionDecision.detectionId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_decisions.detection_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "detection_id" IS NULL) AS null_rows
FROM "redaction_decisions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_decisions'
  AND column_name = 'detection_id';
```

### redaction_decisions.decision_state

- Prisma field: `RedactionDecision.decisionState`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_decisions.decision_state' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "decision_state" IS NULL) AS null_rows
FROM "redaction_decisions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_decisions'
  AND column_name = 'decision_state';
```

### redaction_approvals.approver_user_id

- Prisma field: `RedactionApproval.approverUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_approvals.approver_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "approver_user_id" IS NULL) AS null_rows
FROM "redaction_approvals";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_approvals'
  AND column_name = 'approver_user_id';
```

### redaction_approvals.decided_at_utc

- Prisma field: `RedactionApproval.decidedAtUtc`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'redaction_approvals.decided_at_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "decided_at_utc" IS NULL) AS null_rows
FROM "redaction_approvals";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'redaction_approvals'
  AND column_name = 'decided_at_utc';
```

### trust_center_articles.team_id

- Prisma field: `TrustCenterArticle.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'trust_center_articles.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "trust_center_articles";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_articles'
  AND column_name = 'team_id';
```

### trust_center_articles.summary

- Prisma field: `TrustCenterArticle.summary`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_articles.summary' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "summary" IS NULL) AS null_rows
FROM "trust_center_articles";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_articles'
  AND column_name = 'summary';
```

### trust_center_articles.body

- Prisma field: `TrustCenterArticle.body`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_articles.body' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "body" IS NULL) AS null_rows
FROM "trust_center_articles";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_articles'
  AND column_name = 'body';
```

### trust_center_articles.drift_state

- Prisma field: `TrustCenterArticle.driftState`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_articles.drift_state' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "drift_state" IS NULL) AS null_rows
FROM "trust_center_articles";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_articles'
  AND column_name = 'drift_state';
```

### trust_center_article_versions.team_id

- Prisma field: `TrustCenterArticleVersion.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'trust_center_article_versions.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "trust_center_article_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_article_versions'
  AND column_name = 'team_id';
```

### trust_center_article_versions.title

- Prisma field: `TrustCenterArticleVersion.title`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_article_versions.title' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "title" IS NULL) AS null_rows
FROM "trust_center_article_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_article_versions'
  AND column_name = 'title';
```

### trust_center_article_versions.summary

- Prisma field: `TrustCenterArticleVersion.summary`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_article_versions.summary' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "summary" IS NULL) AS null_rows
FROM "trust_center_article_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_article_versions'
  AND column_name = 'summary';
```

### trust_center_article_versions.state

- Prisma field: `TrustCenterArticleVersion.state`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_article_versions.state' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "state" IS NULL) AS null_rows
FROM "trust_center_article_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_article_versions'
  AND column_name = 'state';
```

### trust_center_article_versions.authored_by_user_id

- Prisma field: `TrustCenterArticleVersion.authoredByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'trust_center_article_versions.authored_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "authored_by_user_id" IS NULL) AS null_rows
FROM "trust_center_article_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'trust_center_article_versions'
  AND column_name = 'authored_by_user_id';
```

### subprocessors.team_id

- Prisma field: `Subprocessor.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'subprocessors.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'team_id';
```

### subprocessors.slug

- Prisma field: `Subprocessor.slug`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.slug' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "slug" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'slug';
```

### subprocessors.vendor

- Prisma field: `Subprocessor.vendor`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.vendor' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "vendor" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'vendor';
```

### subprocessors.purpose

- Prisma field: `Subprocessor.purpose`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.purpose' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "purpose" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'purpose';
```

### subprocessors.region

- Prisma field: `Subprocessor.region`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.region' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "region" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'region';
```

### subprocessors.data_categories

- Prisma field: `Subprocessor.dataCategories`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.data_categories' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "data_categories" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'data_categories';
```

### subprocessors.change_history_summary

- Prisma field: `Subprocessor.changeHistorySummary`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessors.change_history_summary' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "change_history_summary" IS NULL) AS null_rows
FROM "subprocessors";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessors'
  AND column_name = 'change_history_summary';
```

### subprocessor_versions.team_id

- Prisma field: `SubprocessorVersion.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'subprocessor_versions.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "subprocessor_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessor_versions'
  AND column_name = 'team_id';
```

### subprocessor_versions.change_summary

- Prisma field: `SubprocessorVersion.changeSummary`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessor_versions.change_summary' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "change_summary" IS NULL) AS null_rows
FROM "subprocessor_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessor_versions'
  AND column_name = 'change_summary';
```

### subprocessor_versions.snapshot

- Prisma field: `SubprocessorVersion.snapshot`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'subprocessor_versions.snapshot' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "snapshot" IS NULL) AS null_rows
FROM "subprocessor_versions";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'subprocessor_versions'
  AND column_name = 'snapshot';
```

### status_components.description

- Prisma field: `StatusComponent.description`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'status_components.description' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "description" IS NULL) AS null_rows
FROM "status_components";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'status_components'
  AND column_name = 'description';
```

### status_components.team_id

- Prisma field: `StatusComponent.teamId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'status_components.team_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "team_id" IS NULL) AS null_rows
FROM "status_components";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'status_components'
  AND column_name = 'team_id';
```

### status_components.upstream_source

- Prisma field: `StatusComponent.upstreamSource`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'status_components.upstream_source' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "upstream_source" IS NULL) AS null_rows
FROM "status_components";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'status_components'
  AND column_name = 'upstream_source';
```

### departments.organization_id

- Prisma field: `Department.organizationId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'departments.organization_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "organization_id" IS NULL) AS null_rows
FROM "departments";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'departments'
  AND column_name = 'organization_id';
```

### departments.slug

- Prisma field: `Department.slug`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'departments.slug' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "slug" IS NULL) AS null_rows
FROM "departments";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'departments'
  AND column_name = 'slug';
```

### delegated_admin_grants.organization_id

- Prisma field: `DelegatedAdminGrant.organizationId`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'delegated_admin_grants.organization_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "organization_id" IS NULL) AS null_rows
FROM "delegated_admin_grants";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'delegated_admin_grants'
  AND column_name = 'organization_id';
```

### governance_policies.slug

- Prisma field: `GovernancePolicy.slug`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policies.slug' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "slug" IS NULL) AS null_rows
FROM "governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policies'
  AND column_name = 'slug';
```

### governance_policies.summary

- Prisma field: `GovernancePolicy.summary`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policies.summary' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "summary" IS NULL) AS null_rows
FROM "governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policies'
  AND column_name = 'summary';
```

### governance_policies.rule

- Prisma field: `GovernancePolicy.rule`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policies.rule' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "rule" IS NULL) AS null_rows
FROM "governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policies'
  AND column_name = 'rule';
```

### governance_policies.version

- Prisma field: `GovernancePolicy.version`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policies.version' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "version" IS NULL) AS null_rows
FROM "governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policies'
  AND column_name = 'version';
```

### governance_policies.created_by_user_id

- Prisma field: `GovernancePolicy.createdByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policies.created_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "created_by_user_id" IS NULL) AS null_rows
FROM "governance_policies";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policies'
  AND column_name = 'created_by_user_id';
```

### governance_policy_assignments.scope_target_id

- Prisma field: `GovernancePolicyAssignment.scopeTargetId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policy_assignments.scope_target_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "scope_target_id" IS NULL) AS null_rows
FROM "governance_policy_assignments";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policy_assignments'
  AND column_name = 'scope_target_id';
```

### governance_policy_assignments.scope

- Prisma field: `GovernancePolicyAssignment.scope`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policy_assignments.scope' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "scope" IS NULL) AS null_rows
FROM "governance_policy_assignments";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policy_assignments'
  AND column_name = 'scope';
```

### governance_policy_assignments.assigned_by_user_id

- Prisma field: `GovernancePolicyAssignment.assignedByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'governance_policy_assignments.assigned_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "assigned_by_user_id" IS NULL) AS null_rows
FROM "governance_policy_assignments";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'governance_policy_assignments'
  AND column_name = 'assigned_by_user_id';
```

### access_review_campaigns.name

- Prisma field: `AccessReviewCampaign.name`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_campaigns.name' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "name" IS NULL) AS null_rows
FROM "access_review_campaigns";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_campaigns'
  AND column_name = 'name';
```

### access_review_campaigns.scheduled_start_utc

- Prisma field: `AccessReviewCampaign.scheduledStartUtc`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_campaigns.scheduled_start_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "scheduled_start_utc" IS NULL) AS null_rows
FROM "access_review_campaigns";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_campaigns'
  AND column_name = 'scheduled_start_utc';
```

### access_review_campaigns.scheduled_end_utc

- Prisma field: `AccessReviewCampaign.scheduledEndUtc`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_campaigns.scheduled_end_utc' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "scheduled_end_utc" IS NULL) AS null_rows
FROM "access_review_campaigns";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_campaigns'
  AND column_name = 'scheduled_end_utc';
```

### access_review_campaigns.created_by_user_id

- Prisma field: `AccessReviewCampaign.createdByUserId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_campaigns.created_by_user_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "created_by_user_id" IS NULL) AS null_rows
FROM "access_review_campaigns";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_campaigns'
  AND column_name = 'created_by_user_id';
```

### access_review_items.decision

- Prisma field: `AccessReviewItem.decision`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_items.decision' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "decision" IS NULL) AS null_rows
FROM "access_review_items";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_items'
  AND column_name = 'decision';
```

### access_review_items.grant_ref

- Prisma field: `AccessReviewItem.grantRef`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'access_review_items.grant_ref' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "grant_ref" IS NULL) AS null_rows
FROM "access_review_items";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'access_review_items'
  AND column_name = 'grant_ref';
```

### cross_org_review_grants.inviting_organization_id

- Prisma field: `CrossOrgReviewGrant.invitingOrganizationId`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'cross_org_review_grants.inviting_organization_id' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "inviting_organization_id" IS NULL) AS null_rows
FROM "cross_org_review_grants";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cross_org_review_grants'
  AND column_name = 'inviting_organization_id';
```

### cross_org_review_grants.invited_org_slug

- Prisma field: `CrossOrgReviewGrant.invitedOrgSlug`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'cross_org_review_grants.invited_org_slug' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "invited_org_slug" IS NULL) AS null_rows
FROM "cross_org_review_grants";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'cross_org_review_grants'
  AND column_name = 'invited_org_slug';
```

### media_intelligence_records.provider_confidence

- Prisma field: `MediaIntelligenceRecord.providerConfidence`
- Candidate direction: category `B`, canonical side `Prisma`

```sql
SELECT
  'media_intelligence_records.provider_confidence' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "provider_confidence" IS NULL) AS null_rows
FROM "media_intelligence_records";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'media_intelligence_records'
  AND column_name = 'provider_confidence';
```

### media_intelligence_entities.value_hash

- Prisma field: `MediaIntelligenceEntity.valueHash`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'media_intelligence_entities.value_hash' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "value_hash" IS NULL) AS null_rows
FROM "media_intelligence_entities";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'media_intelligence_entities'
  AND column_name = 'value_hash';
```

### media_intelligence_entities.raw_confidence

- Prisma field: `MediaIntelligenceEntity.rawConfidence`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'media_intelligence_entities.raw_confidence' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "raw_confidence" IS NULL) AS null_rows
FROM "media_intelligence_entities";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'media_intelligence_entities'
  AND column_name = 'raw_confidence';
```

### security_claim_checks.last_verified_at

- Prisma field: `SecurityClaimCheck.lastVerifiedAt`
- Candidate direction: category `D`, canonical side `defer`

```sql
SELECT
  'security_claim_checks.last_verified_at' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "last_verified_at" IS NULL) AS null_rows
FROM "security_claim_checks";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'security_claim_checks'
  AND column_name = 'last_verified_at';
```

### video_frames.timestamp_ms

- Prisma field: `VideoFrame.timestampMs`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'video_frames.timestamp_ms' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "timestamp_ms" IS NULL) AS null_rows
FROM "video_frames";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'video_frames'
  AND column_name = 'timestamp_ms';
```

### video_track_detections.raw_confidence

- Prisma field: `VideoTrackDetection.rawConfidence`
- Candidate direction: category `A`, canonical side `DB`

```sql
SELECT
  'video_track_detections.raw_confidence' AS target,
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE "raw_confidence" IS NULL) AS null_rows
FROM "video_track_detections";
```

```sql
SELECT column_name, is_nullable, column_default, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'video_track_detections'
  AND column_name = 'raw_confidence';
```

## One-shot implementation batch plan

### Batch 2C-1 — Schema-only optionality tightening

- Included findings: 57.
- Why this batch matters: these are the LOW findings where current runtime writes already behave as though the field is required and the DB already enforces that contract. The safest repair is to make Prisma honest about the live canonical shape.
- Safety profile: no DB mutation, no data movement, no backfill. The only gate is that the null-count recheck must still show zero null rows before the schema change is merged.
- Deploy posture: can be grouped into one code-only release after prechecks and smoke tests.

#### Exact `schema.prisma` changes proposed for Batch 2C-1

- `RetentionPolicyConfig.createdByUserId`: from `createdByUserId String?  @map("created_by_user_id") @db.Uuid` to `createdByUserId String  @map("created_by_user_id") @db.Uuid`
- `ExternalReviewInvitationDelivery.recipientEmail`: from `recipientEmail   String?   @map("recipient_email") @db.VarChar(320)` to `recipientEmail   String   @map("recipient_email") @db.VarChar(320)`
- `ExternalReviewInvitationDelivery.subject`: from `subject          String?   @db.VarChar(400)` to `subject          String   @db.VarChar(400)`
- `RedactionProject.artifactKind`: from `artifactKind    String?   @map("artifact_kind") @db.VarChar(40)` to `artifactKind    String   @map("artifact_kind") @db.VarChar(40)`
- `RedactionVersion.authoredByUserId`: from `authoredByUserId String?   @map("authored_by_user_id") @db.Uuid` to `authoredByUserId String   @map("authored_by_user_id") @db.Uuid`
- `RedactionRegion.authoredByUserId`: from `authoredByUserId  String?  @map("authored_by_user_id") @db.Uuid` to `authoredByUserId  String  @map("authored_by_user_id") @db.Uuid`
- `RedactionDetection.rawConfidence`: from `rawConfidence           Float?   @map("raw_confidence")` to `rawConfidence           Float   @map("raw_confidence")`
- `RedactionDetection.confidenceBand`: from `confidenceBand          String?  @map("confidence_band") @db.VarChar(20)` to `confidenceBand          String  @map("confidence_band") @db.VarChar(20)`
- `RedactionDetection.kind`: from `kind                    String?  @db.VarChar(40)` to `kind                    String  @db.VarChar(40)`
- `RedactionDetection.suggestedRegionKind`: from `suggestedRegionKind     String?  @map("suggested_region_kind") @db.VarChar(40)` to `suggestedRegionKind     String  @map("suggested_region_kind") @db.VarChar(40)`
- `RedactionDetection.suggestedRegionGeometry`: from `suggestedRegionGeometry Json?    @map("suggested_region_geometry")` to `suggestedRegionGeometry Json    @map("suggested_region_geometry")`
- `RedactionDetection.suggestedMethod`: from `suggestedMethod         String?  @map("suggested_method") @db.VarChar(40)` to `suggestedMethod         String  @map("suggested_method") @db.VarChar(40)`
- `RedactionDetection.decisionState`: from `decisionState           String?  @map("decision_state") @db.VarChar(20)` to `decisionState           String  @map("decision_state") @db.VarChar(20)`
- `RedactionDecision.decidedAtUtc`: from `decidedAtUtc           DateTime? @map("decided_at_utc") @db.Timestamptz(6)` to `decidedAtUtc           DateTime @map("decided_at_utc") @db.Timestamptz(6)`
- `RedactionDecision.versionId`: from `versionId              String?   @map("version_id") @db.Uuid` to `versionId              String   @map("version_id") @db.Uuid`
- `RedactionDecision.detectionId`: from `detectionId            String?   @map("detection_id") @db.Uuid` to `detectionId            String   @map("detection_id") @db.Uuid`
- `RedactionDecision.decisionState`: from `decisionState          String?   @map("decision_state") @db.VarChar(20)` to `decisionState          String   @map("decision_state") @db.VarChar(20)`
- `RedactionApproval.approverUserId`: from `approverUserId   String?   @map("approver_user_id") @db.Uuid` to `approverUserId   String   @map("approver_user_id") @db.Uuid`
- `RedactionApproval.decidedAtUtc`: from `decidedAtUtc     DateTime? @map("decided_at_utc") @db.Timestamptz(6)` to `decidedAtUtc     DateTime @map("decided_at_utc") @db.Timestamptz(6)`
- `TrustCenterArticle.summary`: from `summary                  String?   @db.VarChar(800)` to `summary                  String   @db.VarChar(800)`
- `TrustCenterArticle.body`: from `body                     String?` to `body                     String`
- `TrustCenterArticle.driftState`: from `driftState               String?   @map("drift_state") @db.VarChar(30)` to `driftState               String   @map("drift_state") @db.VarChar(30)`
- `TrustCenterArticleVersion.title`: from `title                    String?   @db.VarChar(300)` to `title                    String   @db.VarChar(300)`
- `TrustCenterArticleVersion.summary`: from `summary                  String?   @db.VarChar(800)` to `summary                  String   @db.VarChar(800)`
- `TrustCenterArticleVersion.state`: from `state                    String?   @db.VarChar(20)` to `state                    String   @db.VarChar(20)`
- `TrustCenterArticleVersion.authoredByUserId`: from `authoredByUserId         String?   @map("authored_by_user_id") @db.Uuid` to `authoredByUserId         String   @map("authored_by_user_id") @db.Uuid`
- `Subprocessor.slug`: from `slug                 String?  @db.VarChar(120)` to `slug                 String  @db.VarChar(120)`
- `Subprocessor.vendor`: from `vendor               String?  @db.VarChar(200)` to `vendor               String  @db.VarChar(200)`
- `Subprocessor.purpose`: from `purpose              String?  @db.VarChar(600)` to `purpose              String  @db.VarChar(600)`
- `Subprocessor.region`: from `region               String?  @db.VarChar(80)` to `region               String  @db.VarChar(80)`
- `Subprocessor.dataCategories`: from `dataCategories       Json?    @map("data_categories")` to `dataCategories       Json    @map("data_categories")`
- `Subprocessor.changeHistorySummary`: from `changeHistorySummary String?  @map("change_history_summary") @db.VarChar(800)` to `changeHistorySummary String  @map("change_history_summary") @db.VarChar(800)`
- `SubprocessorVersion.changeSummary`: from `changeSummary    String?   @map("change_summary") @db.VarChar(800)` to `changeSummary    String   @map("change_summary") @db.VarChar(800)`
- `SubprocessorVersion.snapshot`: from `snapshot         Json?` to `snapshot         Json`
- `StatusComponent.description`: from `description       String?  @db.VarChar(400)` to `description       String  @db.VarChar(400)`
- `StatusComponent.upstreamSource`: from `upstreamSource    String?  @map("upstream_source") @db.VarChar(80)` to `upstreamSource    String  @map("upstream_source") @db.VarChar(80)`
- `Department.slug`: from `slug            String?  @db.VarChar(120)` to `slug            String  @db.VarChar(120)`
- `GovernancePolicy.slug`: from `slug            String?  @db.VarChar(120)` to `slug            String  @db.VarChar(120)`
- `GovernancePolicy.summary`: from `summary         String?  @db.VarChar(600)` to `summary         String  @db.VarChar(600)`
- `GovernancePolicy.rule`: from `rule            Json?` to `rule            Json`
- `GovernancePolicy.version`: from `version         Int?     @default(1)` to `version         Int     @default(1)`
- `GovernancePolicy.createdByUserId`: from `createdByUserId String?  @map("created_by_user_id") @db.Uuid` to `createdByUserId String  @map("created_by_user_id") @db.Uuid`
- `GovernancePolicyAssignment.scopeTargetId`: from `scopeTargetId     String?  @map("scope_target_id") @db.Uuid` to `scopeTargetId     String  @map("scope_target_id") @db.Uuid`
- `GovernancePolicyAssignment.scope`: from `scope             String?  @db.VarChar(40)` to `scope             String  @db.VarChar(40)`
- `GovernancePolicyAssignment.assignedByUserId`: from `assignedByUserId  String?  @map("assigned_by_user_id") @db.Uuid` to `assignedByUserId  String  @map("assigned_by_user_id") @db.Uuid`
- `AccessReviewCampaign.name`: from `name              String?   @db.VarChar(300)` to `name              String   @db.VarChar(300)`
- `AccessReviewCampaign.scheduledStartUtc`: from `scheduledStartUtc DateTime? @map("scheduled_start_utc") @db.Timestamptz(6)` to `scheduledStartUtc DateTime @map("scheduled_start_utc") @db.Timestamptz(6)`
- `AccessReviewCampaign.scheduledEndUtc`: from `scheduledEndUtc   DateTime? @map("scheduled_end_utc") @db.Timestamptz(6)` to `scheduledEndUtc   DateTime @map("scheduled_end_utc") @db.Timestamptz(6)`
- `AccessReviewCampaign.createdByUserId`: from `createdByUserId   String?   @map("created_by_user_id") @db.Uuid` to `createdByUserId   String   @map("created_by_user_id") @db.Uuid`
- `AccessReviewItem.decision`: from `decision       String?   @db.VarChar(20)` to `decision       String   @db.VarChar(20)`
- `AccessReviewItem.grantRef`: from `grantRef       String?   @map("grant_ref") @db.VarChar(200)` to `grantRef       String   @map("grant_ref") @db.VarChar(200)`
- `CrossOrgReviewGrant.invitingOrganizationId`: from `invitingOrganizationId String?   @map("inviting_organization_id") @db.Uuid` to `invitingOrganizationId String   @map("inviting_organization_id") @db.Uuid`
- `CrossOrgReviewGrant.invitedOrgSlug`: from `invitedOrgSlug         String?   @map("invited_org_slug") @db.VarChar(120)` to `invitedOrgSlug         String   @map("invited_org_slug") @db.VarChar(120)`
- `MediaIntelligenceEntity.valueHash`: from `valueHash      String?  @map("value_hash") @db.VarChar(64)` to `valueHash      String  @map("value_hash") @db.VarChar(64)`
- `MediaIntelligenceEntity.rawConfidence`: from `rawConfidence  Float?   @map("raw_confidence")` to `rawConfidence  Float   @map("raw_confidence")`
- `VideoFrame.timestampMs`: from `timestampMs   BigInt?  @map("timestamp_ms")` to `timestampMs   BigInt  @map("timestamp_ms")`
- `VideoTrackDetection.rawConfidence`: from `rawConfidence Float? @map("raw_confidence")` to `rawConfidence Float @map("raw_confidence")`

### Batch 2C-2 — DB nullability relaxation

- Included findings: 1.
- Why this batch matters: these are the LOW findings where code and schema intentionally tolerate NULL and the DB is stricter than the business model.
- Safety profile: additive in the sense that it only relaxes DB strictness; no backfill is needed. Still, confirm the column default first so we do not accidentally remove a runtime dependency on a DB default while changing nullability.
- Deploy posture: can ship alone after prechecks, or after Batch 2C-1 if operators prefer code changes first.

#### Exact migration SQL proposed for Batch 2C-2

```sql
ALTER TABLE "media_intelligence_records" ALTER COLUMN "provider_confidence" DROP NOT NULL;
```

### Batch 2C-3 — Mixed cases

- Included findings: 0.
- Recommended content: none for the current LOW inventory. Every reviewed item landed in schema-only, DB-only, or defer/manual.
- Exact migration SQL proposed for Batch 2C-3: none.

### Batch 2C-4 — Defer / manual review

- Included findings: 21.
- Why this batch matters: these are the tenancy, governance-hierarchy, package-lifecycle, or audit-timestamp fields where a blind LOW cleanup would create hidden semantic risk.
- Implementation rule: keep them out of the one-shot Phase 2C batch. Review them in a follow-on task with runtime smoke coverage and a narrower domain scope.

- `team_members.access_granted_at_utc` -> `TeamMember.accessGrantedAtUtc`: Access-grant timestamp is lifecycle/audit semantics; current runtime reads it but the safe canonical rule for pre-Phase-17 members still needs explicit review.
- `workspace_governance_policies.metadata_redaction_default` -> `WorkspaceGovernancePolicy.metadataRedactionDefault`: Null means "no override" in code, and this column previously carried a semantic type drift; do not relax or tighten it blindly.
- `upload_sessions.team_id` -> `UploadSession.teamId`: Workspace tenancy field on the evidence upload lifecycle; Phase 2C should not change tenancy semantics blindly.
- `evidence_intelligence_jobs.team_id` -> `EvidenceIntelligenceJob.teamId`: Workspace tenancy field on async intelligence jobs; changing optionality needs a dedicated tenancy review.
- `evidence_extracted_texts.team_id` -> `EvidenceExtractedText.teamId`: Workspace tenancy field on extracted-text rows; keep out of the one-shot LOW batch.
- `evidence_entities.team_id` -> `EvidenceEntity.teamId`: Workspace tenancy field on entity rows; keep out of Phase 2C one-shot implementation.
- `evidence_semantic_chunks.team_id` -> `EvidenceSemanticChunk.teamId`: Workspace tenancy field on semantic indexing rows; safe canonical direction needs separate review.
- `evidence_similarities.team_id` -> `EvidenceSimilarity.teamId`: Workspace tenancy field on similarity graph rows; keep out of the LOW batch.
- `discussion_threads.team_id` -> `DiscussionThread.teamId`: Collaboration tenancy field; current writes supply it, but Phase 2C should not tighten or relax collaboration tenancy blindly.
- `discussion_messages.team_id` -> `DiscussionMessage.teamId`: Collaboration tenancy field; defer until the collaboration data model is reviewed end-to-end.
- `discussion_participants.team_id` -> `DiscussionParticipant.teamId`: Collaboration tenancy field; do not change blindly inside the LOW one-shot batch.
- `evidence_exchange_package_deliveries.channel` -> `EvidenceExchangePackageDelivery.channel`: Package-delivery channel is evidence/package lifecycle data; current service defaults it, but this flow is explicitly out of scope for blind LOW fixes.
- `evidence_exchange_package_deliveries.delivered_at_utc` -> `EvidenceExchangePackageDelivery.deliveredAtUtc`: Delivery timestamp carries package-lifecycle meaning; Phase 2C should not invent or reinterpret it.
- `trust_center_articles.team_id` -> `TrustCenterArticle.teamId`: Trust Center tenancy field; current writes supply it, but Phase 2C should not change workspace-tenancy semantics blindly.
- `trust_center_article_versions.team_id` -> `TrustCenterArticleVersion.teamId`: Trust article version tenancy field; keep it out of the one-shot LOW batch.
- `subprocessors.team_id` -> `Subprocessor.teamId`: Subprocessor registry tenancy field; keep it out of the one-shot LOW batch.
- `subprocessor_versions.team_id` -> `SubprocessorVersion.teamId`: Subprocessor version tenancy field; keep it out of the one-shot LOW batch.
- `status_components.team_id` -> `StatusComponent.teamId`: Status component tenancy field; keep it out of the one-shot LOW batch.
- `departments.organization_id` -> `Department.organizationId`: Department hierarchy field is governance-critical; current create path requires it, but Phase 2C should not tighten or relax org-scope semantics blindly.
- `delegated_admin_grants.organization_id` -> `DelegatedAdminGrant.organizationId`: Delegated-admin org scope has a schema comment that permits org-less grants for some tiers, while current writes require organizationId; resolve that conflict first.
- `security_claim_checks.last_verified_at` -> `SecurityClaimCheck.lastVerifiedAt`: Governance verification timestamp; current writes set it, but changing this timestamp contract should happen only after semantic review.

## Items deferred and why

- All 21 deferred items share one of four risk patterns: workspace-tenancy fields (`team_id`), governance hierarchy identifiers (`organization_id`), package-lifecycle semantics (`channel`, `delivered_at_utc`), or audit/verification timestamps (`access_granted_at_utc`, `last_verified_at`).
- None of those fields should be tightened or relaxed just because they are LOW severity; they need domain-specific runtime confirmation first.
- The preserved live snapshot is good enough to plan around them, but not good enough to authorize an automatic one-shot fix.

## Validation plan

1. Re-run the read-only prechecks for every Batch 2C-1 and 2C-2 item against the live DB immediately before implementation.
2. Re-run the full production schema audit after the implementation branch is prepared, using the exact audit script rather than a Prisma diff.
3. Run `pnpm --filter proovra-api exec prisma validate`.
4. Run `pnpm --filter proovra-api run typecheck`.
5. Run the API test suite that covers governance, redaction, trust center, media intelligence, and exchange lifecycles.
6. After deploy, rerun the live schema audit and confirm `LOW` drops by exactly the number of implemented findings.

## Deployment plan

1. Do not bundle Phase 2C with any unrelated runtime or schema work.
2. If operators want the lowest-risk path, ship Batch 2C-1 first because it is code-only and merely makes Prisma honest about the already-live DB contract.
3. Ship Batch 2C-2 only after the live precheck confirms `media_intelligence_records.provider_confidence` still has the expected shape and current write paths do not depend on its NOT NULL constraint.
4. Keep Batch 2C-4 out of the release entirely.

## Rollback strategy

- Batch 2C-1 rollback: revert the `schema.prisma` changes and regenerate Prisma artifacts if needed. No DB rollback required.
- Batch 2C-2 rollback: if the DB relaxation causes an unexpected runtime issue, restore the prior DB contract only after confirming there are still zero null rows; otherwise hold the rollback and fix the runtime instead of invalidating fresh data.
- Because no destructive drops are proposed, rollback remains bounded and operationally safe.

## Top 10 risky LOW findings

- `workspace_governance_policies.metadata_redaction_default` (WorkspaceGovernancePolicy.metadataRedactionDefault) — Null means "no override" in code, and this column previously carried a semantic type drift; do not relax or tighten it blindly.
- `upload_sessions.team_id` (UploadSession.teamId) — Workspace tenancy field on the evidence upload lifecycle; Phase 2C should not change tenancy semantics blindly.
- `evidence_exchange_package_deliveries.delivered_at_utc` (EvidenceExchangePackageDelivery.deliveredAtUtc) — Delivery timestamp carries package-lifecycle meaning; Phase 2C should not invent or reinterpret it.
- `evidence_exchange_package_deliveries.channel` (EvidenceExchangePackageDelivery.channel) — Package-delivery channel is evidence/package lifecycle data; current service defaults it, but this flow is explicitly out of scope for blind LOW fixes.
- `team_members.access_granted_at_utc` (TeamMember.accessGrantedAtUtc) — Access-grant timestamp is lifecycle/audit semantics; current runtime reads it but the safe canonical rule for pre-Phase-17 members still needs explicit review.
- `delegated_admin_grants.organization_id` (DelegatedAdminGrant.organizationId) — Delegated-admin org scope has a schema comment that permits org-less grants for some tiers, while current writes require organizationId; resolve that conflict first.
- `departments.organization_id` (Department.organizationId) — Department hierarchy field is governance-critical; current create path requires it, but Phase 2C should not tighten or relax org-scope semantics blindly.
- `trust_center_articles.team_id` (TrustCenterArticle.teamId) — Trust Center tenancy field; current writes supply it, but Phase 2C should not change workspace-tenancy semantics blindly.
- `trust_center_article_versions.team_id` (TrustCenterArticleVersion.teamId) — Trust article version tenancy field; keep it out of the one-shot LOW batch.
- `security_claim_checks.last_verified_at` (SecurityClaimCheck.lastVerifiedAt) — Governance verification timestamp; current writes set it, but changing this timestamp contract should happen only after semantic review.

## Final recommendation

- Phase 2C can be repaired safely, but **not as a single all-79 cleanup**.
- The safe one-shot scope is the category `A` schema-tightening set plus the single category `B` DB relaxation, after fresh read-only prechecks.
- The category `D` set should wait until after additional runtime smoke tests, because those fields sit on tenancy, governance hierarchy, or audit-semantic boundaries.
- Recommendation: implement Batch 2C-1 first, optionally Batch 2C-2 immediately after, and schedule the 21 deferred findings as follow-on domain reviews rather than forcing them into the LOW cleanup release.
