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
  SearchFilterInput,
  SearchResultRow,
  SearchSortMode,
} from "./search.js";

export {
  SAVED_VIEW_VISIBILITIES,
  SEARCH_DOCUMENT_TYPES,
  SEARCH_FORBIDDEN_OVERCLAIM_PHRASES,
  SEARCH_RESULT_ALLOWED_BADGES,
  SEARCH_SORT_MODES,
  SavedViewVisibilitySchema,
  SearchDocumentTypeSchema,
  SearchFilterSchema,
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
  maskIpPreview,
  mfaRequiredForRole,
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
