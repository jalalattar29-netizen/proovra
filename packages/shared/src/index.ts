import { z } from "zod";

export const PROOVRA_BRAND = {
  name: "Proovra",
  domain: "proovra.com",
  tagline: "Capture truth. Prove it forever.",
} as const;

export const SUPPORT_EMAILS = {
  support: "support@proovra.com",
  legal: "legal@proovra.com",
  admin: "admin@proovra.com",
  security: "security@proovra.com",
} as const;

export const EvidenceTypeSchema = z.enum(["PHOTO", "VIDEO", "AUDIO", "DOCUMENT"]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const LegalVersionsSchema = z.object({
  termsVersion: z.string().min(1),
  privacyVersion: z.string().min(1),
  cookiesVersion: z.string().min(1),
});
export type LegalVersions = z.infer<typeof LegalVersionsSchema>;

export * from "./i18n.js";

// PROOVRA Phase 2 — Target Domain Blueprint architectural constants.
// See docs/architecture/proovra-domain-model.md
export {
  TARGET_WORKSPACE_KINDS,
  LEGACY_WORKSPACE_SCOPES,
  FORBIDDEN_WORKSPACE_KIND_TOKENS,
  FORBIDDEN_WORKSPACE_KIND_UI_STRINGS,
  isPersonalWorkspaceKind,
  isOrganizationWorkspaceKind,
  assertTargetWorkspaceKind,
  coerceLegacyScopeToTargetKind,
} from "./architecture/workspace-kinds.js";
export type {
  TargetWorkspaceKind,
  LegacyWorkspaceScope,
  ForbiddenWorkspaceKindToken,
} from "./architecture/workspace-kinds.js";

// PROOVRA Phase 3 — Canonical denial vocabulary (Stage 3).
// See docs/architecture/architecture-invariants.md (INV-9).
export {
  DENIAL_REASONS,
  denialReasonCopy,
  denialReasonHeadline,
  denialReasonGuidance,
  accessStateToDenialReason,
  accessGateKindToDenialReason,
  authorizationDenialCodeToDenialReason,
  anyDenialToCanonical,
} from "./architecture/denial-vocabulary.js";
export type {
  DenialReason,
  DenialCopy,
} from "./architecture/denial-vocabulary.js";

// PROOVRA Phase 3 — Canonical TOM persona projection (Stage 4).
// See docs/architecture/architecture-invariants.md (INV-4) and
// docs/architecture/proovra-domain-model.md (TOM personas).
export {
  TOM_PERSONA_KINDS,
  projectTomPersona,
  tomPersonaLabel,
  tomPersonaShortLabel,
  isSoloTomPersona,
  isOrgTomPersona,
} from "./architecture/canonical-persona.js";
export type {
  TomPersonaKind,
  TomPersonaProjectionInput,
} from "./architecture/canonical-persona.js";

// PROOVRA Phase 5 — Collaboration Team canonical vocabulary.
// See docs/architecture/phase-5-team-platform-readiness.md and
// docs/architecture/phase-5-team-platform-final.md.
export {
  COLLABORATION_TEAM_ROLES,
  COLLABORATION_TEAM_MANAGE_ROLES,
  COLLABORATION_TEAM_ASSIGN_ROLES,
  COLLABORATION_TEAM_TRANSFER_LEAD_ROLES,
  COLLABORATION_TEAM_STATUSES,
  COLLABORATION_TEAM_MEMBER_STATUSES,
  COLLABORATION_TEAM_TYPES,
  COLLABORATION_TEAM_INVITE_CHANNELS,
  COLLABORATION_TEAM_INVITE_STATUSES,
  COLLABORATION_TEAM_DELIVERY_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_STATUSES,
  COLLABORATION_TEAM_ASSIGNMENT_PRIORITIES,
  COLLABORATION_TEAM_ASSIGNMENT_TARGETS,
  COLLABORATION_TEAM_ACTIVITY_EVENT_TYPES,
  COLLABORATION_TEAM_PLAN_LIMITS,
  COLLABORATION_TEAM_INVITE_TOKEN_PREFIX,
  COLLABORATION_TEAM_INVITE_TOKEN_RANDOM_BYTES,
  getCollaborationTeamPlanLimits,
  collaborationTeamRoleHasPermission,
  listCollaborationTeamRolePermissions,
  isWellFormedCollaborationTeamInviteToken,
  renderCollaborationTeamInvitationSmsBody,
  // Phase 7 additions
  COLLABORATION_TEAM_COMMENT_TARGETS,
  COLLABORATION_TEAM_COMMENT_STATUSES,
  COLLABORATION_TEAM_MENTION_TYPES,
  COLLABORATION_TEAM_NOTIFICATION_TYPES,
  COLLABORATION_TEAM_DIGEST_MODES,
  COLLABORATION_TEAM_GUEST_STATUSES,
  COLLABORATION_TEAM_ACCESS_REVIEW_STATUSES,
  COLLABORATION_TEAM_ACCESS_REVIEW_DECISIONS,
  COLLABORATION_TEAM_SPECIAL_MENTIONS,
  parseCollaborationTeamMentionHandles,
  isSpecialCollaborationTeamMention,
  sanitiseCollaborationTeamCommentBody,
  buildCollaborationTeamUserDirectoryEntry,
} from "./collaboration-team.js";
export type {
  CollaborationTeamRole,
  CollaborationTeamStatus,
  CollaborationTeamMemberStatus,
  CollaborationTeamType,
  CollaborationTeamInviteChannel,
  CollaborationTeamInviteStatus,
  CollaborationTeamDeliveryStatus,
  CollaborationTeamAssignmentStatus,
  CollaborationTeamAssignmentPriority,
  CollaborationTeamAssignmentTarget,
  CollaborationTeamActivityEventType,
  CollaborationTeamPermission,
  CollaborationTeamPlanLimits,
  // Phase 7 type additions
  CollaborationTeamCommentTarget,
  CollaborationTeamCommentStatus,
  CollaborationTeamMentionType,
  CollaborationTeamNotificationType,
  CollaborationTeamDigestMode,
  CollaborationTeamGuestStatus,
  CollaborationTeamAccessReviewStatus,
  CollaborationTeamAccessReviewDecision,
  CollaborationTeamSpecialMention,
  CollaborationTeamUserDirectoryEntry,
} from "./collaboration-team.js";

// PROOVRA Phase 10 — Canonical billing-guard error codes for the
// /v1/collaboration-teams mutation surface. The structured error thrown
// by services/api/src/services/collaboration-team/billing-guards.ts uses
// these codes as its bounded `.code` union.
export {
  COLLABORATION_TEAM_BILLING_ERROR_CODES,
  COLLABORATION_TEAM_BILLING_ERROR_HTTP_STATUS,
  COLLABORATION_TEAM_BILLING_UPGRADE_CTA,
  isCollaborationTeamBillingErrorCode,
} from "./collaboration-team-billing-codes.js";
export type { CollaborationTeamBillingErrorCode } from "./collaboration-team-billing-codes.js";

// PROOVRA Phase 10 — Shared (cross-surface) billing error-code vocabulary.
// Broader than the collaboration-team union: includes UPGRADE_REQUIRED as
// the generic catch-all for non-collaboration-team billing-guarded
// surfaces. See packages/shared/src/billing-errors.ts.
export {
  BILLING_ERROR_CODES,
  BILLING_ERROR_HTTP_STATUS,
  BILLING_ERROR_UPGRADE_CTA,
  isBillingErrorCode,
} from "./billing-errors.js";
export type { BillingErrorCode } from "./billing-errors.js";

export {
  CAPTURE_LOCATION_MAP_ATTRIBUTION,
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SHORT_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  buildCaptureLocationDisplayModel,
  buildCaptureLocationExternalMapUrl,
  buildCaptureLocationGeoUri,
  buildCaptureLocationMapDataUrl,
  buildCaptureLocationMapSvg,
  buildCaptureLocationPdfFallbackSvg,
  buildCaptureLocationStaticMapFallbackSvg,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  hasCaptureLocationMetadata,
} from "./capture-location.js";

export type {
  CaptureLocationDisplayModel,
  CaptureLocationInput,
  CaptureLocationTile,
} from "./capture-location.js";

export { maskPublicEmail, maskPublicEmailsInText } from "./public-identifiers.js";

export type {
  EnqueueReportJobOptions,
  ReportJobPayload,
  ExistingReportJobState,
  ReportJobEnqueueDecision,
} from "./report-queue.js";

export {
  buildReportJobId,
  buildReportJobPayload,
  decideReportJobEnqueueAction,
  generateReportJobName,
  normalizeRegenerateReason,
} from "./report-queue.js";

export type { CustodyEventCategory } from "./custody.js";
export type { EvidenceIntelligence } from "./evidence-intelligence.js";
export { buildEvidenceLibraryIntelligenceSummary } from "./evidence-intelligence.js";

export {
  classifyCustodyEventType,
  isAccessCustodyEventType,
  isForensicCustodyEventType,
} from "./custody.js";

export {
  getReviewerEvidenceCategories,
  getReviewerEvidenceTypeLabel,
  getReviewerUploadModeLabel,
} from "./reviewer-evidence.js";

export type {
  ReviewerArtifactRole,
  ReviewerArtifactRoleSource,
  ResolvedReviewerArtifactRole,
} from "./evidence-roles.js";

export {
  compareReviewerArtifactRolePriority,
  getReviewerArtifactRoleLabel,
  isExplicitReviewerArtifactRoleSource,
  isPrimaryReviewerArtifactRole,
  resolveReviewerArtifactRole,
} from "./evidence-roles.js";

export type {
  TrustDecision,
  ReviewerPackageTrustDecision,
  ReviewerPackageTrustSignal,
  TrustDecisionTone,
  TrustSignal,
  TrustSignalKey,
  TrustSignalStatus,
  TrustDecisionVerdict,
  TrustPresentationState,
  TrustPublicationState,
  TrustDecisionEvidenceInput,
  TrustDecisionCustodyEventInput,
  BuildEvidenceTrustDecisionInput,
  RecordedIntegrityPromotionInput,
  RecordedIntegrityPromotionDecision,
} from "./trust-decision.js";

export {
  buildEvidenceTrustDecision,
  evaluateRecordedIntegrityPromotion,
  getReviewerRelianceLabel,
  getTrustDecisionConfidenceLabel,
  getTrustDecisionLabel,
  getTrustDecisionPresentationTone,
  getTrustNarrative,
  getTrustSignalPresentationLabel,
  hasCoreCryptoMaterials,
  isExplicitRecordedIntegrityVerified,
  serializeTrustDecisionForReviewerPackage,
  TRUST_DECISION_LEGAL_BOUNDARY,
} from "./trust-decision.js";

export type {
  AnchorSemantics,
  AnchorSemanticsInput,
} from "./anchor.js";

export { deriveAnchorSemantics } from "./anchor.js";

export type {
  EffectiveOtsStatus,
  OtsAnchorCompletenessInput,
} from "./ots.js";

export type { VerificationPackageMetadata } from "./verification-package-metadata.js";

// Phase M2 + M2.1 — C2PA provenance interoperability
export {
  C2PA_STATUSES,
  C2PA_VALIDATION_STATUSES,
  C2PA_PROVIDER_MODES,
  C2PA_FAILURE_REASONS,
  C2PA_WARNING_CODES,
  C2PA_LIMITATION_CODES,
  C2PA_CLAIM_SIGNATURE_STATUSES,
  C2PA_RESULT_SCHEMA_VERSION,
  C2PA_SUPPORTED_MEDIA_TYPES,
  STANDING_C2PA_LIMITATIONS,
  C2PA_RAW_MANIFEST_STORAGE_STATUSES,
  C2PA_GENERATED_ASSERTION_STATUSES,
  C2PA_GENERATION_READINESS_STATES,
  buildDisabledC2paSummary,
  buildNotPresentC2paFileResult,
  aggregateC2paFileResults,
  isC2paSupportedMediaType,
  buildDisabledRawManifestReference,
  buildDisabledGeneratedAssertion,
} from "./c2pa.js";
export type {
  C2paStatus,
  C2paValidationStatus,
  C2paProviderMode,
  C2paFailureReason,
  C2paWarningCode,
  C2paLimitationCode,
  C2paClaimSignatureStatus,
  C2paFileResult,
  C2paEvidenceSummary,
  C2paRawManifestStorageStatus,
  C2paRawManifestReference,
  C2paGeneratedAssertionStatus,
  C2paGeneratedAssertion,
  C2paGenerationReadinessState,
  C2paGenerationReadiness,
} from "./c2pa.js";

// Phase M3 — Insurance SIU bundle (vertical productization).
export {
  SIU_CLAIM_TYPES,
  SIU_INVESTIGATION_STATUSES,
  SIU_REVIEW_INDICATOR_CODES,
  SIU_EXPORT_READINESS_STATES,
  SIU_PREFLIGHT_CODES,
  SIU_FOLLOW_UP_STATUSES,
  SIU_CHECKLIST_ITEM_STATUSES,
  SIU_INTAKE_TEMPLATE_IDS,
  SIU_PROFILE_SCHEMA_VERSION,
  SIU_EXPORT_SCHEMA_VERSION,
  SIU_INTAKE_TEMPLATES,
  SIU_FORBIDDEN_PHRASES,
  SIU_STANDING_LIMITATIONS,
  SIU_PII_VISIBILITY_POLICIES,
  SIU_SAVED_VIEW_IDS,
  SIU_SAVED_VIEW_PRESETS,
  SIU_CAPABILITIES,
  SIU_EXPORT_STATUSES,
  SIU_SAVED_VIEW_VISIBILITY,
  SiuProfileUpsertInputSchema,
  buildEmptySiuChecklist,
  getSiuIntakeTemplate,
} from "./insurance-siu.js";
export type {
  SiuClaimType,
  SiuInvestigationStatus,
  SiuReviewIndicatorCode,
  SiuExportReadinessState,
  SiuPreflightCode,
  SiuFollowUpStatus,
  SiuChecklistItemStatus,
  SiuIntakeTemplateId,
  SiuChecklistItem,
  SiuReviewIndicator,
  SiuFollowUpRequest,
  SiuProfile,
  SiuPreflightFinding,
  SiuPreflightResult,
  SiuExportSummary,
  SiuIntakeTemplate,
  SiuStandingLimitationCode,
  SiuProfileUpsertInput,
  SiuPiiVisibilityPolicy,
  SiuSavedViewId,
  SiuSavedViewPreset,
  SiuCapability,
  SiuExportStatus,
  SiuSavedViewVisibility,
} from "./insurance-siu.js";

// Phase A2 — Report artifact + signature bounded vocabulary.
export {
  ARTIFACT_TYPES,
  PDF_SIGNATURE_STATUSES,
  VERIFICATION_PACKAGE_SIGNATURE_STATUSES,
  ARTIFACT_LABELS,
  PDF_UNSIGNED_OPT_OUT_WARNING_COPY,
  PDF_SIGNING_UNAVAILABLE_COPY,
  FORBIDDEN_ARTIFACT_PHRASES,
} from "./report-artifact.js";
export type {
  ArtifactType,
  PdfSignatureStatus,
  VerificationPackageSignatureStatus,
  ReportPdfSignatureProjection,
  VerificationPackageSignatureProjection,
  ArtifactLabel,
} from "./report-artifact.js";

// Phase A3 — Operational hardening bounded vocabularies.
export {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_REJECTION_REASONS,
  ANALYTICS_LIMITS,
  AI_CHAT_ABUSE_REASONS,
  AI_CHAT_LIMITS,
  WEBHOOK_SIGNATURE_FAILURE_REASONS,
  WEBHOOK_PROVIDERS,
  VERIFY_VIEWED_LIMITS,
} from "./operational-hardening.js";
export type {
  AnalyticsEventName,
  AnalyticsRejectionReason,
  AiChatAbuseReason,
  WebhookSignatureFailureReason,
  WebhookProvider,
} from "./operational-hardening.js";

export {
  isCompleteOtsAnchor,
  isValidOtsBitcoinTxid,
  normalizeOtsStatusValue,
  resolveEffectiveOtsStatus,
} from "./ots.js";

// -----------------------------------------------------------------------------
// Workflow engine (Phase 1: types and pure helpers only — inert at runtime)
// -----------------------------------------------------------------------------

export type {
  WorkflowAcceptedKind,
  WorkflowContext,
  WorkflowIdentityTier,
  WorkflowIntakeMode,
  WorkflowLocationRequirement,
  WorkflowPlanMode,
  WorkflowRule,
  WorkflowRuleAction,
  WorkflowRuleConditionValue,
  WorkflowRuleOp,
  WorkflowStep,
  WorkflowTemplate,
  WorkflowWorkspaceCategory,
  WorkflowWorkspaceRole,
} from "./workflow-types.js";

export {
  WORKFLOW_ACCEPTED_KINDS,
  WORKFLOW_IDENTITY_TIERS,
  WORKFLOW_INTAKE_MODES,
  WORKFLOW_LOCATION_REQUIREMENTS,
  WORKFLOW_PLAN_MODES,
  WORKFLOW_RULE_ACTIONS,
  WORKFLOW_RULE_OPS,
  WORKFLOW_WORKSPACE_CATEGORIES,
  WORKFLOW_WORKSPACE_ROLES,
  WorkflowAcceptedKindSchema,
  WorkflowContextSchema,
  WorkflowIdentityTierSchema,
  WorkflowIntakeModeSchema,
  WorkflowLocationRequirementSchema,
  WorkflowPlanModeSchema,
  WorkflowRuleActionSchema,
  WorkflowRuleConditionValueSchema,
  WorkflowRuleOpSchema,
  WorkflowRuleSchema,
  WorkflowStepSchema,
  WorkflowTemplateSchema,
  WorkflowWorkspaceCategorySchema,
  WorkflowWorkspaceRoleSchema,
  isExternalWorkflowIntakeMode,
  meetsWorkflowIdentityTier,
} from "./workflow-types.js";

export type {
  WorkflowAudience,
  WorkflowExportPolicy,
  WorkflowGpsPrecision,
  WorkflowReviewAutoAssignStrategy,
  WorkflowReviewPolicy,
  WorkflowReviewPriority,
  WorkflowVisibilityPolicy,
} from "./workflow-policy.js";

export {
  WORKFLOW_AUDIENCES,
  WORKFLOW_BASELINE_EXPORT_POLICY,
  WORKFLOW_BASELINE_REVIEW_POLICY,
  WORKFLOW_BASELINE_VISIBILITY_POLICY,
  WORKFLOW_GPS_PRECISIONS,
  WORKFLOW_REVIEW_AUTO_ASSIGN_STRATEGIES,
  WORKFLOW_REVIEW_PRIORITIES,
  WorkflowAudienceSchema,
  WorkflowExportPolicySchema,
  WorkflowGpsPrecisionSchema,
  WorkflowReviewAutoAssignStrategySchema,
  WorkflowReviewPolicySchema,
  WorkflowReviewPrioritySchema,
  WorkflowVisibilityPolicySchema,
} from "./workflow-policy.js";

export type {
  WorkflowDataClass,
  WorkflowSurface,
  WorkflowViewerContext,
  WorkflowViewerKind,
  WorkflowVisibilityDecision,
  WorkflowVisibilityDecisionSource,
  WorkflowVisibilityResolverInput,
  WorkflowVisibilityTransform,
} from "./workflow-visibility.js";

export {
  WORKFLOW_DATA_CLASSES,
  WORKFLOW_SURFACES,
  resolveVisibilityForViewer,
} from "./workflow-visibility.js";

export type {
  ResolveWorkflowContextInput,
  ResolveWorkflowContextResult,
  SafeParseWorkflowTemplateListResult,
  WorkflowRuleSanitizationWarning,
  WorkflowStepSanitizationWarning,
} from "./workflow-resolver.js";

export {
  resolveWorkflowContext,
  safeParseWorkflowTemplate,
  safeParseWorkflowTemplateList,
  sanitizeWorkflowRules,
  sanitizeWorkflowSteps,
  templateMatchesIntakeMode,
} from "./workflow-resolver.js";

// -----------------------------------------------------------------------------
// Phase 4: Workflow intake link primitives (canonical types, no I/O)
// -----------------------------------------------------------------------------

export type {
  WorkflowIntakeLinkStatus,
  WorkflowIntakeSessionStatus,
  WorkflowIntakeSessionTransitionResult,
  WorkflowIntakeTokenShape,
  WorkflowIntakeConsentSnapshot,
} from "./workflow-intake-link.js";

export {
  WORKFLOW_INTAKE_LINK_STATUSES,
  WORKFLOW_INTAKE_SESSION_STATUSES,
  WORKFLOW_INTAKE_TOKEN_PREFIX,
  WORKFLOW_INTAKE_TOKEN_VERSION,
  WORKFLOW_INTAKE_TOKEN_RANDOM_BYTES,
  WorkflowIntakeConsentSnapshotSchema,
  WorkflowIntakeLinkStatusSchema,
  WorkflowIntakeSessionStatusSchema,
  canTransitionWorkflowIntakeSession,
  formatWorkflowIntakeTokenWireValue,
  isTerminalWorkflowIntakeSessionStatus,
  parseWorkflowIntakeTokenShape,
} from "./workflow-intake-link.js";

// `isAnonymousWorkflowIntakeMode` is grouped semantically with the link
// types but lives in workflow-types.ts so it shares the IntakeMode universe.
export { isAnonymousWorkflowIntakeMode } from "./workflow-types.js";

// -----------------------------------------------------------------------------
// Phase 7: Evidence Request canonical types + state machine
// -----------------------------------------------------------------------------

export type {
  EvidenceRequestDeliverableInput,
  EvidenceRequestDeliverableStatus,
  EvidenceRequestInput,
  EvidenceRequestPriority,
  EvidenceRequestRecipientMode,
  EvidenceRequestResponseStatus,
  EvidenceRequestStatus,
  EvidenceRequestTransitionResult,
  EvidenceRequestType,
} from "./evidence-request.js";

// -----------------------------------------------------------------------------
// Phase 8: Notifications canonical types
// -----------------------------------------------------------------------------

export type {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationProvider,
} from "./notifications.js";

export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_PROVIDERS,
  NOTIFICATION_RETRY_MAX_ATTEMPTS,
  NotificationChannelSchema,
  NotificationDeliveryStatusSchema,
  NotificationEventTypeSchema,
  NotificationProviderSchema,
  classifyNotificationProviderError,
  isTerminalNotificationDeliveryStatus,
  notificationRetryDelaySeconds,
} from "./notifications.js";

// -----------------------------------------------------------------------------
// Phase 9: canonical RBAC permission model
// -----------------------------------------------------------------------------

export type {
  CanonicalRole,
  DbTeamRole,
  Permission,
} from "./permissions.js";

export {
  CANONICAL_ROLES,
  DB_TEAM_ROLES,
  PERMISSIONS,
  CanonicalRoleSchema,
  PermissionSchema,
  listRolePermissions,
  mapTeamRoleToCanonical,
  roleHasPermission,
} from "./permissions.js";

// -----------------------------------------------------------------------------
// Phase 18 — Enterprise communications & external outreach
// -----------------------------------------------------------------------------

export type {
  CommunicationChannel,
  CommunicationDirection,
  CommunicationProvider,
  CommunicationPurpose,
  CommunicationStatus,
  InboundCommand,
  VerificationAttemptStatus,
} from "./communications.js";

export {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_DIRECTIONS,
  COMMUNICATION_PROVIDERS,
  COMMUNICATION_PURPOSES,
  COMMUNICATION_RETRY_MAX_ATTEMPTS,
  COMMUNICATION_STATUSES,
  CommunicationChannelSchema,
  CommunicationDirectionSchema,
  CommunicationProviderSchema,
  CommunicationPurposeSchema,
  CommunicationStatusSchema,
  VERIFICATION_ATTEMPT_STATUSES,
  VerificationAttemptStatusSchema,
  appendStopFooter,
  classifyCommunicationProviderError,
  communicationRetryDelaySeconds,
  isCriticalCommunicationPurpose,
  isPhoneChannel,
  isRetryEligibleCommunicationPurpose,
  isTerminalCommunicationStatus,
  maskPhonePreview,
  normaliseToE164,
  parseInboundCommand,
  renderCollaborationMentionSmsBody,
  renderContributorClarificationSmsBody,
  renderEvidenceRequestSmsBody,
  renderGovernanceAlertSmsBody,
  renderIntakeLinkSmsBody,
  renderReviewEscalationSmsBody,
  renderReviewReminderSmsBody,
  renderSecurityAlertSmsBody,
} from "./communications.js";

// -----------------------------------------------------------------------------
// Phase 24 — Enterprise Evidence Discovery Platform
// -----------------------------------------------------------------------------

export type {
  SavedViewVisibility,
  SearchCursor,
  SearchDocumentType,
  SearchFallbackReason,
  SearchFilterInput,
  SearchMode,
  SearchResultRow,
  SearchSortMode,
} from "./search.js";

export {
  SAVED_VIEW_VISIBILITIES,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_FALLBACK_REASONS,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SEARCH_MODES,
  SEARCH_RESULT_ALLOWED_BADGES,
  SEARCH_SORT_MODES,
  SavedViewVisibilitySchema,
  SearchDocumentTypeSchema,
  SearchFilterSchema,
  SearchModeSchema,
  SearchSortModeSchema,
  decodeSearchCursor,
  encodeSearchCursor,
  isAllowedSearchBadge,
  stringContainsForbiddenOverclaim,
} from "./search.js";

// Phase 25 — reviewer queue priority scoring engine.
export {
  computeReviewerPriority,
  summarisePriorityReasons,
  PRIORITY_REASON_CODES,
  type PriorityFacts,
  type PriorityScoreResult,
  type PriorityReason,
  type PriorityReasonCode,
  type WorkflowSlaStatus,
  type EscalationSeverity,
  type EvidencePriorityHint,
} from "./reviewer-priority.js";

// Phase 25.5 — reviewer assignment intelligence (eligibility + ranking
// + throughput balancing).
export {
  evaluateReviewerEligibility,
  rankReviewerSuggestions,
  evaluateTeamBalance,
  ASSIGNMENT_INELIGIBILITY_CODES,
  ASSIGNMENT_RANK_REASON_CODES,
  ASSIGNMENT_RISK_FLAG_CODES,
  type WorkflowAssignmentFacts,
  type ReviewerCandidate,
  type EligibilityResult,
  type EligibilityReason,
  type ReviewerSuggestion,
  type AssignmentRankReason,
  type AssignmentRankReasonCode,
  type AssignmentRiskFlag,
  type AssignmentRiskFlagCode,
  type AssignmentIneligibilityCode,
  type RecommendationBand,
  type RankerResult,
  type TeamBalanceFacts,
  type TeamBalanceResult,
} from "./reviewer-assignment.js";

// Phase 25 — stuck workflow detection (pure deterministic).
export {
  detectStuckWorkflow,
  STUCK_REASON_CODES,
  STUCK_SUBMITTED_THRESHOLD_MS,
  STUCK_ASSIGNED_NEVER_OPENED_THRESHOLD_MS,
  STUCK_OPENED_NO_ACTION_THRESHOLD_MS,
  STUCK_NEEDS_INFO_THRESHOLD_MS,
  STUCK_ESCALATION_UNACK_THRESHOLD_MS,
  type StuckWorkflowFacts,
  type StuckClassification,
  type StuckReason,
  type StuckReasonCode,
  type WorkflowReviewStatus,
} from "./stuck-workflow-detector.js";

// Phase 25 — canonical search document projection engine (pure
// builders shared by the API indexer + the worker rebuilder).
export {
  sanitiseSearchString,
  sanitiseSearchBody,
  sanitiseSearchTags,
  safeMetadataSnapshot,
  buildEvidenceProjection,
  buildWorkflowInstanceProjection,
  isAllowedSearchDocumentType,
  SEARCH_TITLE_MAX_CHARS,
  SEARCH_SUBTITLE_MAX_CHARS,
  SEARCH_SUMMARY_MAX_CHARS,
  SEARCH_BODY_MAX_CHARS,
  SEARCH_TAG_MAX_COUNT,
  type SearchDocumentProjection,
  type ProjectionResult,
  type ProjectionFailureReason,
  type EvidenceProjectionInput,
  type WorkflowInstanceProjectionInput,
} from "./search-projection.js";

// -----------------------------------------------------------------------------
// Phase 22 — Evidence Workflow Engine (runtime instance + step layer)
// -----------------------------------------------------------------------------

export type {
  WorkflowActorRole,
  WorkflowErrorCode,
  WorkflowExportTarget,
  WorkflowInstanceStatus,
  WorkflowStepIdentityRequirement,
  WorkflowStepInstanceStatus,
  WorkflowStepUpAction,
  WorkflowTemplateStatus,
  WorkflowVisibilityTarget,
} from "./workflow-instance.js";

export {
  WORKFLOW_ACTOR_ROLES,
  WORKFLOW_ERROR_CODES,
  WORKFLOW_EXPORT_TARGETS,
  WORKFLOW_INSTANCE_STATUSES,
  WORKFLOW_STEP_IDENTITY_REQUIREMENTS,
  WORKFLOW_STEP_INSTANCE_STATUSES,
  WORKFLOW_STEP_UP_ACTIONS,
  WORKFLOW_TEMPLATE_STATUSES,
  WORKFLOW_VISIBILITY_TARGETS,
  WorkflowActorRoleSchema,
  WorkflowExportTargetSchema,
  WorkflowInstanceStatusSchema,
  WorkflowStepIdentityRequirementSchema,
  WorkflowStepInstanceStatusSchema,
  WorkflowTemplateStatusSchema,
  WorkflowVisibilityTargetSchema,
  isAllowedWorkflowInstanceTransition,
  isExternalActorRole,
  isReviewerOrAboveRole,
  isSatisfyingWorkflowStepStatus,
  isServiceAccountAllowedRole,
  isTerminalWorkflowInstanceStatus,
  isTerminalWorkflowStepStatus,
  listAllowedWorkflowInstanceTransitions,
} from "./workflow-instance.js";

// -----------------------------------------------------------------------------
// Phase 21 — Enterprise observability, incident response & resilience
// -----------------------------------------------------------------------------

export type {
  AlertCategory,
  IncidentCategory,
  IncidentSeverity,
  IncidentStatus,
} from "./observability.js";

export {
  ALERT_CATEGORIES,
  AlertCategorySchema,
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  IncidentCategorySchema,
  IncidentSeveritySchema,
  IncidentStatusSchema,
  REDACTED_KEY_SUBSTRINGS,
  clipSafeSummary,
  isAllowedIncidentStatusTransition,
  isSafeRequestId,
  isTerminalIncidentStatus,
  isValidIncidentFingerprint,
  shouldRedactKey,
} from "./observability.js";

// -----------------------------------------------------------------------------
// Phase 19 — Enterprise identity security & adaptive access control
// -----------------------------------------------------------------------------

export type {
  MfaPolicyLevel,
  RiskLevel,
  RiskScoreInput,
  RiskScoreResult,
  RiskSignalKind,
  SessionRevocationReason,
  StepUpChallengeStatus,
  StepUpPurpose,
  TrustedDeviceStatus,
} from "./identity-security.js";

export {
  MFA_POLICY_LEVELS,
  MfaPolicyLevelSchema,
  RISK_LEVELS,
  RISK_SIGNAL_KINDS,
  RiskLevelSchema,
  RiskSignalKindSchema,
  SESSION_REVOCATION_REASONS,
  SessionRevocationReasonSchema,
  STEP_UP_CHALLENGE_STATUSES,
  STEP_UP_PURPOSES,
  STEP_UP_TTL_DEFAULT_SECONDS,
  STEP_UP_TTL_MAX_SECONDS,
  StepUpChallengeStatusSchema,
  StepUpPurposeSchema,
  TRUSTED_DEVICE_STATUSES,
  TRUSTED_DEVICE_TTL_DAYS_DEFAULT,
  TRUSTED_DEVICE_TTL_DAYS_MAX,
  TrustedDeviceStatusSchema,
  computeRiskScore,
  isTerminalStepUpStatus,
  isValidDeviceCookieValue,
  legacyAliasesForStoredPurpose,
  maskIpPreview,
  mfaRequiredForRole,
  purposeSatisfies,
  riskBlocksAction,
  riskRequiresStepUp,
  riskSignalWeight,
  summariseUserAgent,
} from "./identity-security.js";

// -----------------------------------------------------------------------------
// Phase 17 — Enterprise identity & access platform
// -----------------------------------------------------------------------------

export type {
  AccessReviewKind,
  AccessReviewStatus,
  AccessReviewSubjectKind,
  DelegatedAdminScopeKind,
  ExternalIdentityProvider,
  OrgSecurityPolicy,
  PermissionAuditEventType,
  TeamMemberStatus,
} from "./identity.js";

export {
  ACCESS_REVIEW_KINDS,
  ACCESS_REVIEW_STATUSES,
  ACCESS_REVIEW_SUBJECT_KINDS,
  AccessReviewKindSchema,
  AccessReviewStatusSchema,
  AccessReviewSubjectKindSchema,
  DELEGATED_ADMIN_SCOPE_KINDS,
  DelegatedAdminScopeKindSchema,
  EXPIRING_ACCESS_WINDOW_DAYS_DEFAULT,
  EXTERNAL_IDENTITY_PROVIDERS,
  ExternalIdentityProviderSchema,
  ORG_SECURITY_POLICY_DEFAULTS,
  OrgSecurityPolicySchema,
  PERMISSION_AUDIT_EVENT_TYPES,
  PermissionAuditEventTypeSchema,
  STALE_ACCESS_DAYS_DEFAULT,
  TEAM_MEMBER_STATUSES,
  TeamMemberStatusSchema,
  UNUSED_SERVICE_ACCOUNT_DAYS_DEFAULT,
  isAllowedAccessReviewTransition,
  isAllowedTeamMemberStatusTransition,
  isEmailDomainAllowed,
  isIpAddressAllowed,
  isTerminalAccessReviewStatus,
  listAllowedTeamMemberStatusTransitions,
  listPermissionsForDelegatedAdminScope,
  teamMemberStatusGrantsAccess,
} from "./identity.js";

// -----------------------------------------------------------------------------
// Phase 10: Integration platform types
// -----------------------------------------------------------------------------

export type {
  ApiCredentialStatus,
  WebhookDeliveryStatus,
  WebhookEndpointStatus,
  WebhookEventType,
  WebhookUrlValidation,
} from "./integrations.js";

export {
  API_CREDENTIAL_STATUSES,
  API_KEY_PREFIX,
  API_KEY_RANDOM_BYTES,
  API_KEY_VERSION,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_ENDPOINT_STATUSES,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_EVENT_ID,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  WEBHOOK_RETRY_MAX_ATTEMPTS,
  WebhookEventTypeSchema,
  buildWebhookSignatureBase,
  classifyWebhookHttpError,
  deriveApiKeyDisplayPrefix,
  formatApiKeyValue,
  parseApiKeyShape,
  validateWebhookUrl,
  webhookRetryDelaySeconds,
} from "./integrations.js";

// Phase 11 — security hardening canonical types
export type {
  FileSecurityScanStatus,
  FileValidationFindings,
  MimeMismatchSeverity,
  SecurityEventSeverity,
  SecurityEventType,
  SniffedFileType,
} from "./security.js";

export {
  DEFAULT_MAX_ARCHIVE_COMPRESSION_RATIO,
  DEFAULT_MAX_ARCHIVE_ENTRY_COUNT,
  DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES,
  FILE_SECURITY_SCAN_STATUSES,
  SECURITY_EVENT_SEVERITIES,
  SECURITY_EVENT_TYPES,
  classifyFileValidation,
  hasDoubleExtension,
  isDangerousExtension,
  isDangerousMimeType,
  sniffFileType,
} from "./security.js";

// Phase 16 — enterprise collaboration canonical types
export type {
  DiscussionMessageAuthorKind,
  DiscussionParticipantRole,
  DiscussionThreadKind,
  DiscussionThreadStatus,
  DiscussionThreadVisibility,
} from "./collaboration.js";

export {
  DISCUSSION_BODY_MAX_BYTES,
  DISCUSSION_MESSAGE_AUTHOR_KINDS,
  DISCUSSION_PARTICIPANT_ROLES,
  DISCUSSION_THREAD_KINDS,
  DISCUSSION_THREAD_STATUSES,
  DISCUSSION_THREAD_TERMINAL_STATUSES,
  DISCUSSION_THREAD_VISIBILITIES,
  isAllowedDiscussionThreadTransition,
  isDiscussionThreadTerminal,
  listAllowedDiscussionThreadTransitions,
  parseMentionTokens,
  sanitiseDiscussionBody,
} from "./collaboration.js";

// Phase 15 — enterprise intelligence canonical types
export type {
  EvidenceEntityKind,
  EvidenceEntitySource,
  EvidenceSimilarityKind,
  ExtractedTextKind,
  ExtractedTextStatus,
  IntelligenceJobKind,
  IntelligenceJobStatus,
  RegexEntityMatch,
} from "./intelligence.js";

export {
  AI_ADVISORY_DISCLAIMER,
  EVIDENCE_ENTITY_KINDS,
  EVIDENCE_ENTITY_SOURCES,
  EVIDENCE_SIMILARITY_KINDS,
  EXTRACTED_TEXT_KINDS,
  EXTRACTED_TEXT_STATUSES,
  FORBIDDEN_AI_PHRASES,
  INTELLIGENCE_ADVISORY_DISCLAIMER,
  INTELLIGENCE_JOB_KINDS,
  INTELLIGENCE_JOB_STATUSES,
  aiResponseContainsForbiddenPhrase,
  extractRegexEntities,
  filenameTokens,
  jaccardSimilarity,
  normaliseEmail,
  normalisePhone,
  normaliseUrl,
  similaritySummaryFor,
  textSimilarity,
  textTokens,
} from "./intelligence.js";

// Phase 14 — enterprise governance canonical types
export type {
  CaseLegalHoldStatus,
  PublicVerifyState,
  RedactionField,
  RedactionMode,
  RedactionPolicy,
  RedactionPolicyOverride,
  RedactionScope,
  RetentionPolicySource,
} from "./governance.js";

export {
  CASE_LEGAL_HOLD_STATUSES,
  DEFAULT_REDACTION_POLICY,
  PUBLIC_VERIFY_STATES,
  REDACTION_FIELDS,
  REDACTION_MODES,
  REDACTION_SCOPES,
  RETENTION_POLICY_SOURCES,
  applyRedaction,
  maskEmail,
  maskGpsCoordinate,
  maskPhone,
  publicVerifyStateAllowsAccess,
  resolveRedactionPolicy,
} from "./governance.js";

// Phase 13 — review operations canonical types
export type {
  ReviewDecisionType,
  ReviewSlaStatus,
  ReviewStage,
  SlaComputationInput,
} from "./review-operations.js";

export {
  REVIEW_DECISIONS_REQUIRING_NOTE,
  REVIEW_DECISION_TYPES,
  REVIEW_SLA_STATUSES,
  REVIEW_STAGES,
  REVIEW_STAGE_TERMINAL,
  computeReviewSlaStatus,
  decisionRequiresNote,
  decisionTargetStage,
  isAllowedReviewStageTransition,
  isTerminalReviewStage,
  listAllowedReviewStageTransitions,
  mapDbStatusToReviewStage,
  reviewStageSatisfiesGovernanceGate,
} from "./review-operations.js";

// -----------------------------------------------------------------------------
// Phase 25 — Reviewer Operations Intelligence + SLA Engine
// -----------------------------------------------------------------------------

export type {
  ReviewSlaComputationInput,
  ReviewSlaDimension,
  ReviewSlaDimensionSnapshot,
  ReviewerOpsAction,
  ReviewerOpsErrorCode,
  ReviewerOpsLifecycleState,
  ReviewerOpsQueueType,
  ReviewerOpsSlaPolicy,
  ReviewerOpsSlaState,
  ReviewerWorkloadCountsInput,
  ReviewEscalationReason,
  ReviewEscalationStatus,
} from "./reviewer-ops.js";

export {
  REVIEWER_OPS_ACTIONS,
  REVIEWER_OPS_ALLOWED_LABELS,
  REVIEWER_OPS_DEFAULT_SLA_POLICY,
  REVIEWER_OPS_ERROR_CODES,
  REVIEWER_OPS_LIFECYCLE_STATES,
  REVIEWER_OPS_QUEUE_TYPES,
  REVIEWER_OPS_SLA_STATES,
  REVIEW_ESCALATION_REASONS,
  REVIEW_ESCALATION_STATUSES,
  REVIEW_ESCALATION_TERMINAL,
  REVIEW_SLA_DIMENSIONS,
  ReviewEscalationReasonSchema,
  ReviewEscalationStatusSchema,
  ReviewerOpsLifecycleStateSchema,
  ReviewerOpsQueueTypeSchema,
  ReviewerOpsSlaStateSchema,
  computeReviewerCapacityScore,
  computeReviewerOpsSlaSnapshot,
  deriveLifecycleState,
  isAllowedEscalationStatusTransition,
  isAllowedLifecycleTransition,
  isAllowedReviewerOpsLabel,
  isTerminalReviewEscalationStatus,
  lifecycleTransitionPassesStageGate,
  listAllowedEscalationStatusTransitions,
  listAllowedLifecycleTransitions,
  rollupReviewerOpsSlaState,
} from "./reviewer-ops.js";

// -----------------------------------------------------------------------------
// Phase 26 — Enterprise RBAC engine
// -----------------------------------------------------------------------------

export type {
  RbacDecision,
  RbacDecisionOutcome,
  RbacDecisionSource,
  RbacMemberSnapshot,
  RbacPermissionDomain,
  RbacPermissionRow,
  RbacPermissionVerb,
  TemporaryElevationInput,
} from "./rbac.js";

export {
  RBAC_DECISION_OUTCOMES,
  RBAC_DECISION_SOURCES,
  RBAC_PERMISSION_DOMAINS,
  RBAC_PERMISSION_VERBS,
  RBAC_SOURCE_LABELS,
  TEMPORARY_ELEVATION_DEFAULT_SECONDS,
  TEMPORARY_ELEVATION_MAX_SECONDS,
  TEMPORARY_ELEVATION_MIN_SECONDS,
  TemporaryElevationSchema,
  applyInheritanceChain,
  rbacPermissionDomain,
  rbacSourceLabel,
} from "./rbac.js";

// -----------------------------------------------------------------------------
// Phase 27 — Enterprise Retention + Legal Hold + Compliance Lifecycle
// -----------------------------------------------------------------------------

export type {
  DestructionReviewReason,
  DestructionReviewStatus,
  EvidenceLifecycleState,
  ExportEligibilityOutcome,
  ExportEligibilityResult,
  LifecycleEventType,
  RetentionPolicyCreateInput,
  RetentionPolicyScope,
  RetentionPolicyStatus,
  RetentionPolicyUpdateInput,
} from "./governance-lifecycle.js";

export {
  DESTRUCTION_REVIEW_LABELS,
  DESTRUCTION_REVIEW_REASONS,
  DESTRUCTION_REVIEW_STATUSES,
  DESTRUCTION_REVIEW_TERMINAL_STATUSES,
  DestructionReviewStatusSchema,
  EVIDENCE_LIFECYCLE_STATES,
  EVIDENCE_LIFECYCLE_TERMINAL_STATES,
  EXPORT_ELIGIBILITY_OUTCOMES,
  EvidenceLifecycleStateSchema,
  LIFECYCLE_EVENT_TYPES,
  LIFECYCLE_STATE_LABELS,
  RETENTION_POLICY_MAX_DAYS,
  RETENTION_POLICY_MIN_DAYS,
  RETENTION_POLICY_SCOPES,
  RETENTION_POLICY_STATUSES,
  RETENTION_PRECEDENCE_ORDER,
  RetentionPolicyCreateInputSchema,
  RetentionPolicyScopeSchema,
  RetentionPolicyStatusSchema,
  RetentionPolicyUpdateInputSchema,
  canEnterPendingDestruction,
  isAllowedDestructionReviewTransition,
  isAllowedEvidenceLifecycleTransition,
  isAllowedRetentionPolicyTransition,
  isTerminalDestructionReviewStatus,
  isTerminalLifecycleState,
  listAllowedEvidenceLifecycleTransitions,
  pickHighestPrecedencePolicy,
} from "./governance-lifecycle.js";

// -----------------------------------------------------------------------------
// Phase 27.5 — Governance operationalization (reconciliation workers,
// destruction execution lifecycle, immutable storage drift outcomes,
// notification engine, export lineage snapshots, analytics catalog)
// -----------------------------------------------------------------------------

export type {
  AnalyticsWindow,
  DestructionExecutionPhase,
  DestructionExecutionStatus,
  GovernanceAnalyticsMetric,
  GovernanceExportSnapshotInput,
  GovernanceExportSnapshotKind,
  GovernanceNotificationChannel,
  GovernanceNotificationDeliveryStatus,
  GovernanceNotificationKind,
  GovernanceNotificationSeverity,
  GovernanceReconciliationKind,
  GovernanceReconciliationStatus,
  GovernanceReconciliationTrigger,
  ImmutableStorageCheckOutcome,
} from "./governance-operations.js";

export {
  ANALYTICS_WINDOWS,
  DEDUPE_KEY_MAX_LEN,
  DEFAULT_NOTIFICATION_CHANNELS,
  DESTRUCTION_EXECUTION_PHASES,
  DESTRUCTION_EXECUTION_STATUS_LABELS,
  DESTRUCTION_EXECUTION_STATUSES,
  GOVERNANCE_ANALYTICS_METRICS,
  GOVERNANCE_EXPORT_SNAPSHOT_KINDS,
  GOVERNANCE_NOTIFICATION_CHANNELS,
  GOVERNANCE_NOTIFICATION_DELIVERY_STATUSES,
  GOVERNANCE_NOTIFICATION_KIND_LABELS,
  GOVERNANCE_NOTIFICATION_KINDS,
  GOVERNANCE_NOTIFICATION_SEVERITIES,
  GOVERNANCE_RECONCILIATION_KINDS,
  GOVERNANCE_RECONCILIATION_STATUSES,
  GOVERNANCE_RECONCILIATION_TRIGGERS,
  GovernanceExportSnapshotInputSchema,
  IMMUTABLE_STORAGE_CHECK_OUTCOMES,
  IMMUTABLE_STORAGE_DRIFT_OUTCOMES,
  IMMUTABLE_STORAGE_OUTCOME_LABELS,
  NOTIFICATION_SUMMARY_MAX_LEN,
  NOTIFICATION_THROTTLE_SECONDS,
  NOTIFICATION_TITLE_MAX_LEN,
  NOTIFICATION_TO_INCIDENT_SEVERITY,
  analyticsWindowToMilliseconds,
  isDriftOutcome,
  isTerminalDestructionExecutionStatus,
  isValidDedupeKey,
} from "./governance-operations.js";

// -----------------------------------------------------------------------------
// Phase 26.75 — Identity runtime (quarantine, geo, privileged action
// catalog, runtime risk recompute, trust decay)
// -----------------------------------------------------------------------------

export type {
  GeoLookupResult,
  GeoProvider,
  PrivilegedAction,
  PrivilegedSessionAgeingInput,
  RuntimeAdaptiveDecision,
  SessionQuarantineReason,
  TrustDecayInput,
} from "./identity-runtime.js";

export {
  FORCED_REAUTH_COOLDOWN_DEFAULT_MINUTES,
  GEO_CACHE_NEGATIVE_TTL_HOURS,
  GEO_CACHE_TTL_DAYS,
  GEO_LOOKUP_DEFAULT_TIMEOUT_MS,
  GEO_LOOKUP_MAX_TIMEOUT_MS,
  GEO_PROVIDERS,
  GeoProviderSchema,
  HIGH_RISK_INCIDENT_DEDUP_HOURS,
  HIGH_RISK_INCIDENT_DEFAULT_THRESHOLD,
  PRIVILEGED_ACTIONS,
  PRIVILEGED_ACTION_REQUIRES_FRESH_AUTH_HOURS,
  PRIVILEGED_SESSION_MAX_AGE_DEFAULT_HOURS,
  PrivilegedActionSchema,
  RUNTIME_RISK_RECOMPUTE_DEFAULT_MINUTES,
  RUNTIME_RISK_RECOMPUTE_MAX_MINUTES,
  RUNTIME_RISK_RECOMPUTE_MIN_MINUTES,
  SESSION_QUARANTINE_DEFAULT_HOURS,
  SESSION_QUARANTINE_MAX_HOURS,
  SESSION_QUARANTINE_REASONS,
  SessionQuarantineReasonSchema,
  TRUST_DECAY_DEFAULT_MAX,
  TRUST_DECAY_RISKY_INCREMENT,
  TRUST_DECAY_STALE_DAYS,
  computeTrustDecay,
  isForcedReauthAllowed,
  isSessionDueForRiskRecompute,
  privilegedActionRequiresFreshAuth,
} from "./identity-runtime.js";

// -----------------------------------------------------------------------------
// Phase 26.5 — Identity hardening (suspicious sessions, adaptive auth,
// SCIM Groups, identity event timeline, sampled heartbeat)
// -----------------------------------------------------------------------------

export type {
  AdaptiveAuthDecision,
  AdaptiveAuthInput,
  AdaptiveAuthResult,
  IdentityTimelineEvent,
  IdentityTimelineEventKind,
  ScimGroupInput,
  ScimGroupMappedRole,
  ScimGroupMember,
  ScimGroupPatchOpInput,
  ScimGroupResource,
  ScimGroupStatus,
  SessionRiskLevel,
  SsoCallbackAttemptStatus,
  SuspiciousSessionSignal,
  SuspiciousSessionSignalKind,
} from "./identity-hardening.js";

export {
  ADAPTIVE_AUTH_DECISIONS,
  IDENTITY_TIMELINE_EVENT_KINDS,
  SCIM_GROUP_MAPPED_ROLES,
  SCIM_GROUP_SCHEMA_URI,
  SCIM_GROUP_STATUSES,
  SESSION_HEARTBEAT_DEFAULT_SAMPLE_SECONDS,
  SESSION_HEARTBEAT_MAX_SAMPLE_SECONDS,
  SESSION_HEARTBEAT_MIN_SAMPLE_SECONDS,
  SESSION_RISK_HIGH_THRESHOLD,
  SESSION_RISK_LEVELS,
  SESSION_RISK_MEDIUM_THRESHOLD,
  SESSION_STALE_DEFAULT_MINUTES,
  SSO_CALLBACK_ATTEMPT_STATUSES,
  SSO_CALLBACK_STATE_TTL_SECONDS,
  SUSPICIOUS_SESSION_SIGNAL_KINDS,
  SUSPICIOUS_SESSION_SIGNAL_WEIGHTS,
  ScimGroupPatchOpSchema,
  ScimGroupSchema,
  SuspiciousSessionSignalKindSchema,
  computeSuspiciousSessionRisk,
  evaluateAdaptiveAuth,
  isSafeRedirectAfter,
  isSessionStale,
  sessionRiskLevel,
  shouldWriteHeartbeat,
} from "./identity-hardening.js";

// -----------------------------------------------------------------------------
// Phase 26 — Identity providers (SSO + SCIM)
// -----------------------------------------------------------------------------

export type {
  JitProvisioningDecision,
  JitProvisioningPolicy,
  ScimEmail,
  ScimError,
  ScimPatchOpInput,
  ScimScope,
  ScimUserInput,
  ScimUserName,
  ScimUserResource,
  SsoConnectionCreateInput,
  SsoConnectionStatus,
  SsoProvider,
} from "./identity-providers.js";

export {
  SCIM_ERROR_SCHEMA_URI,
  SCIM_LIST_RESPONSE_SCHEMA_URI,
  SCIM_PATCH_OP_SCHEMA_URI,
  SCIM_SCOPES,
  SCIM_TOKEN_BYTES,
  SCIM_TOKEN_PREFIX,
  SCIM_TOKEN_PREFIX_LENGTH,
  SCIM_USER_SCHEMA_URI,
  SSO_CONNECTION_STATUSES,
  SSO_PROVIDERS,
  SSO_PROVIDER_LABELS,
  ScimPatchOpSchema,
  ScimScopeSchema,
  ScimUserSchema,
  SsoConnectionCreateInputSchema,
  SsoConnectionStatusSchema,
  SsoProviderSchema,
  emailMatchesAllowedDomains,
  evaluateJitProvisioning,
  isAllowedSsoConnectionTransition,
  normaliseEmailDomain,
  scimError,
  ssoProviderLabel,
  ssoProviderProtocol,
} from "./identity-providers.js";

// -----------------------------------------------------------------------------
// Phase 25.5 — Reviewer Operations Hardening additions
// -----------------------------------------------------------------------------

export type {
  EscalationAnalyticsBucket,
  EscalationAnalyticsHotspot,
  EscalationAnalyticsProjection,
  ReviewerOpsBulkAction,
  ReviewerOpsBulkInput,
  ReviewerOpsBulkItemResult,
  ReviewerOpsReminderKind,
  ReviewerOpsReminderStatus,
  ReviewerOpsSavedViewFilter,
  ReviewerOpsSlaPolicyOverride,
  ReviewerPerformanceProjection,
  ReviewerPerformanceRow,
  SavedViewScope,
  SlaPolicyResolutionInput,
} from "./reviewer-ops.js";

export {
  REVIEWER_OPS_BULK_ACTIONS,
  REVIEWER_OPS_BULK_HIGH_RISK_ACTIONS,
  REVIEWER_OPS_BULK_MAX_ITEMS,
  REVIEWER_OPS_INACTIVITY_DEFAULT_HOURS,
  REVIEWER_OPS_INACTIVITY_MAX_HOURS,
  REVIEWER_OPS_REMINDER_KINDS,
  REVIEWER_OPS_REMINDER_STATUSES,
  REVIEWER_OPS_SAVED_VIEW_SCOPE,
  REVIEWER_OPS_SLA_POLICY_HOURS_MAX,
  REVIEWER_OPS_SLA_POLICY_HOURS_MIN,
  ReviewerOpsBulkActionSchema,
  ReviewerOpsBulkInputSchema,
  ReviewerOpsReminderKindSchema,
  ReviewerOpsSavedViewFilterSchema,
  ReviewerOpsSlaPolicySchema,
  SAVED_VIEW_SCOPES,
  SEARCH_SAVED_VIEW_SCOPE,
  isReviewerInactive,
  resolveReviewerOpsSlaPolicy,
} from "./reviewer-ops.js";

// Phase 12 — reliability canonical types
export type { UploadSessionStatus } from "./reliability.js";

export {
  DEFAULT_MAX_UPLOAD_FILE_SIZE_BYTES,
  DEFAULT_MULTIPART_PART_SIZE_BYTES,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_UPLOAD_ABANDONED_HOURS,
  DEFAULT_UPLOAD_STALLED_MINUTES,
  MULTIPART_PART_SIZE_MAX_BYTES,
  MULTIPART_PART_SIZE_MIN_BYTES,
  UPLOAD_ABANDONED_HOURS_MAX,
  UPLOAD_ABANDONED_HOURS_MIN,
  UPLOAD_SESSION_STATUSES,
  UPLOAD_SESSION_TERMINAL_STATUSES,
  UPLOAD_STALLED_MINUTES_MAX,
  UPLOAD_STALLED_MINUTES_MIN,
  isAllowedUploadSessionTransition,
  isTerminalUploadSessionStatus,
  listAllowedUploadSessionTransitions,
} from "./reliability.js";

export {
  EVIDENCE_REQUEST_DELIVERABLE_STATUSES,
  EVIDENCE_REQUEST_DELIVERABLE_STATUS_LABEL,
  EVIDENCE_REQUEST_PRIORITIES,
  EVIDENCE_REQUEST_RECIPIENT_MODES,
  EVIDENCE_REQUEST_RESPONSE_STATUSES,
  EVIDENCE_REQUEST_RESPONSE_STATUS_LABEL,
  EVIDENCE_REQUEST_STATUSES,
  EVIDENCE_REQUEST_STATUS_LABEL,
  EVIDENCE_REQUEST_TYPES,
  EvidenceRequestDeliverableInputSchema,
  EvidenceRequestDeliverableStatusSchema,
  EvidenceRequestInputSchema,
  EvidenceRequestPrioritySchema,
  EvidenceRequestRecipientModeSchema,
  EvidenceRequestResponseStatusSchema,
  EvidenceRequestStatusSchema,
  EvidenceRequestTypeSchema,
  canTransitionEvidenceRequest,
  isExternalRecipientMode,
  isTerminalEvidenceRequestStatus,
} from "./evidence-request.js";

// -----------------------------------------------------------------------------
// Phase X — Canonical decision contracts (single source of truth for
// the pure formulas the api and worker runtimes both consume).
// -----------------------------------------------------------------------------

export type {
  CanonicalDecision,
  CanonicalDecisionReason,
  CanonicalDestructionFacts,
  CanonicalDomain,
  CanonicalExportFacts,
  CanonicalExportOutcome,
  CanonicalLifecycleTransitionFacts,
  CanonicalPolicyPick,
  RuntimeOwner,
  RuntimeOwnershipEntry,
} from "./canonical-decisions.js";
export {
  canonicalCanEnterPendingDestruction,
  canonicalEvaluateExportEligibility,
  canonicalEvaluateLifecycleTransition,
  canonicalIsAllowedDestructionReviewTransition,
  canonicalIsAllowedEvidenceLifecycleTransition,
  canonicalIsAllowedRetentionPolicyTransition,
  canonicalIsTerminalDestructionReviewStatus,
  canonicalIsTerminalLifecycleState,
  canonicalListAllowedEvidenceLifecycleTransitions,
  canonicalPickHighestPrecedencePolicy,
  decisionAllow,
  decisionDeny,
  findRuntimeOwners,
  RUNTIME_OWNERSHIP_MAP,
} from "./canonical-decisions.js";

// -----------------------------------------------------------------------------
// Phase X — Operational contracts (typed queue payloads, worker
// execution context, correlation IDs, retry profiles).
// -----------------------------------------------------------------------------

export type {
  AuditEventEmission,
  GovernanceNotificationEmission,
  LifecycleTransitionEmission,
  QueuePayloadEnvelope,
  QueueRetryConfig,
  QueueRetryProfile,
  WorkerExecutionContext,
  WorkerExecutionTrigger,
} from "./operational-contracts.js";
export {
  QUEUE_RETRY_PROFILES,
  WORKER_EXECUTION_TRIGGERS,
  ingestCorrelationId,
  isQueuePayloadEnvelope,
  isValidCorrelationId,
  newCorrelationId,
  newQueuePayloadEnvelope,
  newWorkerExecutionContext,
  parseQueueEnvelope,
} from "./operational-contracts.js";

// -----------------------------------------------------------------------------
// Phase Y — Observability runtime primitives (Prometheus exporter,
// trace context, withSpan helper, alert threshold catalog).
// -----------------------------------------------------------------------------

export type {
  OperationalAlertSeverity,
  OperationalAlertThreshold,
  PromLabel,
  PromMetric,
  PromMetricKind,
  PromSnapshot,
  SpanOutcome,
  SpanSink,
  TraceContext,
} from "./observability-runtime.js";

export {
  OPERATIONAL_ALERT_THRESHOLDS,
  evaluateAlerts,
  formatPrometheusExposition,
  newTraceContext,
  parseTraceParentHeader,
  safeLabelSet,
  sanitizePromLabelValue,
  traceParentHeader,
  withSpan,
} from "./observability-runtime.js";

// -----------------------------------------------------------------------------
// Phase Z — Failure-mode audit map (canonical catalog of the failure
// modes the platform must survive). Used by the Phase Z hardening test
// suite and operator runbooks.
// -----------------------------------------------------------------------------

export type {
  FailureDomain,
  FailureModeEntry,
  FailureSeverity,
  ValidationStrategy,
} from "./failure-mode-audit.js";
export {
  FAILURE_MODE_AUDIT,
  failureModesByDomain,
  failureModesBySeverity,
  findFailureMode,
} from "./failure-mode-audit.js";

// -----------------------------------------------------------------------------
// Phase 28-D — Canonical package-eligibility helper. Same shape as
// canonicalEvaluateExportEligibility; both gates share a single
// precedence ladder so the operator always sees the most-restrictive
// blocker first. Package adds an extra BLOCKED_BY_IMMUTABLE_DRIFT
// outcome that fires when the immutable-storage reconciliation worker
// has an open incident for the evidence.
// -----------------------------------------------------------------------------

export type {
  CanonicalPackageDecision,
  CanonicalPackageFacts,
  PackageEligibilityOutcome,
} from "./governance-package-eligibility.js";
export {
  PACKAGE_ELIGIBILITY_OUTCOMES,
  canonicalEvaluatePackageEligibility,
  exportEligibilityLabel,
  packageEligibilityLabel,
} from "./governance-package-eligibility.js";

// -----------------------------------------------------------------------------
// Phase 28-E — External review lifecycle + privacy-filter primitives.
// -----------------------------------------------------------------------------

export type {
  ExternalReviewAccessDecision,
  ExternalReviewAccessFacts,
  ExternalReviewAccessState,
  ExternalReviewEvidenceProjection,
} from "./external-review.js";
export {
  EXTERNAL_REVIEW_ACCESS_STATES,
  EXTERNAL_REVIEW_EVIDENCE_FORBIDDEN_FIELDS,
  EXTERNAL_REVIEW_EVIDENCE_SAFE_FIELDS,
  ExternalReviewAccessStateSchema,
  evaluateExternalReviewAccess,
  isActiveExternalReviewState,
  isAllowedExternalReviewTransition,
  isTerminalExternalReviewState,
  projectEvidenceForExternalReview,
} from "./external-review.js";

// -----------------------------------------------------------------------------
// Phase 3B Enterprise Closure — intelligence-closure contracts
// (executive metrics ranges, trend math, lifecycle audit codes, quality projections)
// -----------------------------------------------------------------------------

export type {
  AuditEventsManifestEntry,
  BudgetBreachProjection,
  BudgetBreachRow,
  BudgetGovernanceManifestEntry,
  BudgetSpendProjection,
  BudgetSpendRow,
  CorrectionVersionChainManifestEntry,
  CorrectionVersionChainProjection,
  CorrectionVersionRow,
  ExecutiveAiTrend,
  ExecutiveCaptureTrend,
  ExecutiveCostTrend,
  ExecutiveCorrectionTrend,
  ExecutiveEvidenceTrend,
  ExecutiveMetricsRange,
  ExecutiveReviewTrend,
  ExecutiveSlaTrend,
  ExecutiveTrendsProjection,
  ExecutiveVerificationTrend,
  IntelligenceLifecycleCategory,
  IntelligenceLifecycleCode,
  ProviderQualityManifestEntry,
  ProviderQualityProjection,
  ProviderQualityRow,
  ReviewerQualityProjection,
  ReviewerQualityRow,
  TeamQualityProjection,
  TeamQualityRow,
  TrendDirection,
  TrendMetric,
} from "./intelligence-closure.js";

export {
  EXECUTIVE_METRICS_RANGES,
  EXECUTIVE_TRENDS_SCHEMA_VERSION,
  INTELLIGENCE_LIFECYCLE_CATEGORIES,
  INTELLIGENCE_LIFECYCLE_CODES,
  TREND_DIRECTIONS,
  buildTrendMetric,
  classifyLifecycleCategory,
  classifyTrend,
  rangeWindowMs,
} from "./intelligence-closure.js";

// -----------------------------------------------------------------------------
// Phase 1B Closure — canonical-JSON + capture-trust contracts
// (shared cross-runtime canonical serialiser + capture trust primitives)
// -----------------------------------------------------------------------------

export {
  canonicalize as canonicalJson,
  canonicalUtf8Length,
  CanonicalJsonError,
} from "./canonical-json.js";

// -----------------------------------------------------------------------------
// Phase 4B — Product Packaging & Lifecycle contracts
// (product lines, entitlements, exchange, webhooks, retention,
//  legal hold, archive tiers, destruction governance, lifecycle dashboard)
// -----------------------------------------------------------------------------

export type {
  ArchiveTier,
  ArchiveManifestEntry,
  ArchiveTransitionProjection,
  ChainTransferProjection,
  ChainTransferState,
  DestructionCertificateProjection,
  DestructionLifecycleCode,
  DestructionManifestEntry,
  DestructionRequestProjection,
  DestructionState,
  EntitlementKey,
  EntitlementProjection,
  ExchangeManifestEntry,
  ExchangePackageKind,
  ExchangePackageProjection,
  ExchangePackageState,
  LegalHoldKind,
  LegalHoldLifecycleCode,
  LegalHoldManifestEntry,
  LegalHoldProjection,
  LegalHoldState,
  LifecycleCapabilityState,
  LifecycleCapabilityStatus,
  LifecycleDashboardCapabilities,
  LifecycleDashboardProjection,
  LifecycleManifestEntry,
  ProductAndLifecycleLimitation,
  ProductLine,
  ProductLineProjection,
  RetentionManifestEntry,
  RetentionPolicyProjection,
  RetentionPolicyTemplate,
  TransferManifestEntry,
  WebhookDeliveryState,
  WebhookEventKind,
} from "./product-and-lifecycle.js";

export {
  ARCHIVE_TIERS,
  CHAIN_TRANSFER_STATES,
  DESTRUCTION_LIFECYCLE_CODES,
  DESTRUCTION_STATES,
  ENTITLEMENT_KEYS,
  EXCHANGE_PACKAGE_KINDS,
  EXCHANGE_PACKAGE_STATES,
  LEGAL_HOLD_KINDS,
  LEGAL_HOLD_LIFECYCLE_CODES,
  LEGAL_HOLD_STATES,
  LIFECYCLE_CAPABILITY_STATUSES,
  LIFECYCLE_DASHBOARD_SCHEMA_VERSION,
  PRODUCT_AND_LIFECYCLE_LIMITATIONS,
  PRODUCT_LINES,
  RETENTION_POLICY_TEMPLATES,
  WEBHOOK_DELIVERY_STATES,
  WEBHOOK_EVENT_KINDS,
} from "./product-and-lifecycle.js";

// -----------------------------------------------------------------------------
// Phase 28-E — Enterprise discovery foundation. Architecture
// primitives only; no engine.
// -----------------------------------------------------------------------------

export type {
  DiscoveryFilterDecision,
  DiscoveryFilterFacts,
  DiscoveryForbiddenField,
  IndexingEvent,
  IndexingEventKind,
  IndexingEventSink,
  SafeCaseDocument,
  SafeDocumentEnvelope,
  SafeEscalationDocument,
  SafeEvidenceDocument,
  SafeExternalReviewShareDocument,
  SafeIncidentDocument,
  SafeOperationalEventDocument,
  SafeReviewTaskDocument,
  SafeSearchableDocument,
  SafeVerificationPackageDocument,
  SearchableEntityKind,
} from "./discovery-foundation.js";
export {
  DISCOVERY_FORBIDDEN_FIELDS,
  INDEXING_EVENT_KINDS,
  SEARCHABLE_ENTITY_KINDS,
  SearchableEntityKindSchema,
  applyDiscoveryFilter,
  emitIndexingEvent,
  registerIndexingEventSink,
} from "./discovery-foundation.js";

// -----------------------------------------------------------------------------
// Phase 1B — Capture Trust contracts
// (provenance classes, trust event codes, device attestation, capture signature)
// -----------------------------------------------------------------------------
export {
  CAPTURE_PROVENANCE_CLASSES,
  PROVENANCE_CHAIN_SCHEMA_VERSION,
  CAPTURE_TRUST_EVENT_CODES,
  DEVICE_ATTESTATION_PROVIDERS,
  DEVICE_ATTESTATION_FAILURE_REASONS,
  CAPTURE_SIGNATURE_ALGORITHMS,
  CAPTURE_MODES,
  CAPTURE_SIGNATURE_VERDICTS,
  DEVICE_ATTESTATION_VERDICTS,
  STANDING_PROVENANCE_LIMITATIONS,
  PROVENANCE_LIMITATION_CODES,
  CAPTURE_INGEST_WARNINGS,
  CAPTURE_INGEST_DENIAL_REASONS,
  provenanceClassLabel,
  clampProvenanceClass,
  demoteToClassC,
  attestationVerdictKeepsClassA,
  signatureVerdictIsFatal,
} from "./capture-trust.js";
export type {
  CaptureProvenanceClass,
  CaptureSignaturePayload,
  ProvenanceChain,
  CaptureTrustEventCode,
  DeviceAttestationProvider,
  DeviceAttestationFailureReason,
  CaptureSignatureAlgorithm,
  CaptureMode,
  CaptureSignatureVerdict,
  DeviceAttestationVerdict,
  CaptureIngestReceipt,
  CaptureIngestWarning,
  CaptureIngestDenialReason,
  ProvenanceLimitationCode,
} from "./capture-trust.js";

// -----------------------------------------------------------------------------
// Phase 1B — Capture SDK Foundation contracts
// (abstract interfaces for cross-runtime capture + provenance + trust)
// -----------------------------------------------------------------------------
export type {
  CaptureSource,
  CaptureContext,
  CaptureResult,
  ProvenanceSigner,
  ProvenanceProof,
  DeviceAttestationAssertion,
  TrustEnvelope,
  CaptureSdkConformance,
} from "./capture-sdk-foundation.js";

// -----------------------------------------------------------------------------
// Phase 2B Closure — External portal closure contracts
// (auth methods, delivery statuses, bulk invitation shapes)
// -----------------------------------------------------------------------------
export {
  PORTAL_AUTH_METHODS,
  INVITATION_DELIVERY_STATUSES,
  BULK_INVITATION_ROW_OUTCOMES,
  BULK_INVITATION_MAX_ROWS,
  EXTERNAL_REVIEWER_ROLES,
  EXTERNAL_PORTAL_ACTIVITY_CODES,
  EXTERNAL_PORTAL_CAPABILITIES,
  EXTERNAL_PORTAL_CAPABILITY_MATRIX,
  EXTERNAL_DECISION_VERDICTS,
  WATERMARK_POLICIES,
  externalPortalCapabilitiesForRole,
} from "./external-review-portal.js";
export type {
  PortalAuthMethod,
  InvitationDeliveryStatus,
  BulkInvitationRowOutcome,
  BulkInvitationResultRow,
  ExternalReviewerRole,
  ExternalPortalActivityCode,
  ExternalPortalCapability,
  ExternalDecisionVerdict,
  WatermarkPolicy,
} from "./external-review-portal.js";

// -----------------------------------------------------------------------------
// Phase 3A Elite Closure — Redaction elite contracts
// (policy version states, assignment precedence, video intelligence)
// -----------------------------------------------------------------------------
export {
  REDACTION_POLICY_VERSION_STATES,
  REDACTION_POLICY_VERSION_TRANSITIONS,
  POLICY_ASSIGNMENT_SCOPES,
  POLICY_ASSIGNMENT_PRECEDENCE,
  POLICY_DETECTION_RULE_ACTIONS,
  REDACTION_POLICY_DOCUMENT_SCHEMA_VERSION,
  REDACTION_POLICY_ACTIVITY_CODES,
  VIDEO_TRACK_KINDS,
  VIDEO_TRACK_STATES,
  VIDEO_FRAME_EXTRACTORS,
  VIDEO_TIMELINE_LAYERS,
  isAllowedPolicyVersionTransition,
} from "./redaction-elite.js";
export type {
  RedactionPolicyVersionState,
  PolicyAssignmentScope,
  PolicyDetectionRuleAction,
  PolicyCustomRegexRule,
  RedactionPolicyDocument,
  RedactionPolicyActivityCode,
  EffectivePolicy,
  VideoTrackKind,
  VideoTrackState,
  VideoFrameExtractor,
  VideoTimelineLayer,
  VideoTrackingVerificationManifestEntry,
  PolicyVerificationManifestEntry,
} from "./redaction-elite.js";

// -----------------------------------------------------------------------------
// Phase 1B — Capture SDK foundation
// (typed interfaces: CaptureContext, CaptureResult, TrustEnvelope, etc.)
// -----------------------------------------------------------------------------
export type * from "./capture-sdk-foundation.js";

// -----------------------------------------------------------------------------
// Phase 2A — Reviewer Workspace contracts
// (roles, capabilities, coding field types, verdicts, QC states, disagreements, hotkeys)
// -----------------------------------------------------------------------------
// Wildcard re-export preserves every export (back-compat). Explicit named
// re-exports below give source-grep contract tests + IDE jump-to-def a
// stable target. Definitions remain in the canonical module — these are
// pure re-exports, no duplication.
export * from "./reviewer-workspace.js";
export {
  REVIEWER_ROLES,
  CODING_FIELD_TYPES,
  DISAGREEMENT_STATES,
  REVIEWER_HOTKEY_CODES,
} from "./reviewer-workspace.js";
export type { ReviewerWorkspaceProjection } from "./reviewer-workspace.js";

// -----------------------------------------------------------------------------
// Phase 2B — External Reviewer Portal contracts
// (reviewer roles, auth methods, activity codes, watermark, bulk invitation)
// -----------------------------------------------------------------------------
export * from "./external-review-portal.js";
// Note: EXTERNAL_REVIEWER_ROLES, EXTERNAL_PORTAL_CAPABILITIES,
// EXTERNAL_DECISION_VERDICTS, WATERMARK_POLICIES are explicit-named-exported
// in the Phase 2B Closure block above. Only EXTERNAL_PORTAL_LIMITATIONS
// needs to be added here for grep-visibility.
export { EXTERNAL_PORTAL_LIMITATIONS } from "./external-review-portal.js";

// -----------------------------------------------------------------------------
// Phase 3A — Enterprise Redaction Platform contracts
// (artifact kinds, region kinds, detection, decision, approval, derivative,
//  roles, capabilities, activity codes, denial reasons, projection types)
// -----------------------------------------------------------------------------
export * from "./redaction.js";
export {
  REDACTION_ARTIFACT_KINDS,
  REDACTION_VERSION_TRANSITIONS,
  REDACTION_CAPABILITY_MATRIX,
  classifyConfidence,
  isValidRegionGeometry,
} from "./redaction.js";
export type {
  RedactionProjectProjection,
  PortalRedactionExposure,
  RedactionVerificationManifestEntry,
} from "./redaction.js";

// -----------------------------------------------------------------------------
// Phase 3A Elite Closure — Policy + Video Intelligence contracts
// (policy version states, assignment scopes, video track/frame/timeline types)
// -----------------------------------------------------------------------------
export * from "./redaction-elite.js";

// -----------------------------------------------------------------------------
// Phase 3B — Enterprise Intelligence Platform contracts
// (modalities, record kinds, providers, confidence bands, cost units, budgets,
//  audit transparency, executive metrics schema)
// -----------------------------------------------------------------------------
export * from "./media-intelligence-platform.js";
export {
  MEDIA_INTELLIGENCE_PROVIDERS,
  PROVIDER_ADAPTER_OPERATIONS,
  EXECUTIVE_METRICS_SCHEMA_VERSION,
  AUDIT_TRANSPARENCY_CATEGORIES,
} from "./media-intelligence-platform.js";
export type {
  MediaIntelligenceRecordProjection,
  ExecutiveMetricsProjection,
  ProviderBudgetGateResult,
} from "./media-intelligence-platform.js";

// -----------------------------------------------------------------------------
// Phase 4A — Trust Center + Enterprise Governance contracts
// (trust articles, subprocessors, status page, org/dept/delegated-admin,
//  governance policy, access review campaign, cross-org review, manifests)
// -----------------------------------------------------------------------------
export * from "./trust-and-governance.js";

// -----------------------------------------------------------------------------
// Canonical evidence digest policy — single source of truth for the
// 5 digests (content, fingerprint, signature, tsa, ots) + invariants.
// Browser-safe: pure functions only, no node:crypto.
// -----------------------------------------------------------------------------
export * from "./evidence-digest-policy.js";

// -----------------------------------------------------------------------------
// Custody hash helpers (canonicalJsonValue + buildCustodyEventHash)
//
// NOT re-exported from this barrel. `custody-hash.ts` imports `node:crypto`,
// which Webpack cannot resolve in the browser bundle (UnhandledSchemeError).
// Every real consumer (worker + api custody-events services) already imports
// directly from the `@proovra/shared/custody-hash` subpath, so removing the
// barrel re-export is non-breaking for those callers and stops the Node-only
// graph from being dragged into the Next.js client bundle whenever any web
// file touches `@proovra/shared`.
//
// To use the custody hash helpers:
//   import { buildCustodyEventHash, canonicalJsonValue } from "@proovra/shared/custody-hash";
// -----------------------------------------------------------------------------
