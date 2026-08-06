/**
 * PROOVRA Phase 4A — Trust Center + Enterprise Governance Platform.
 *
 * Single source of truth for the bounded vocabulary the Trust &
 * Governance layer consumes:
 *
 *   * Trust Center sections + methodology + AI disclosure + security
 *     section catalogs.
 *   * Subprocessor registry shapes.
 *   * Status page component vocabulary + incident severities + states.
 *   * Organization / department / delegated admin tiered roles.
 *   * Governance policy kinds + assignment scopes + enforcement modes.
 *   * Access review states + decision verdicts.
 *   * Cross-org review controls.
 *   * Verification-package manifest extensions.
 *
 * Hard rules:
 *   * Append-only enums.
 *   * NEVER PII in bounded payloads.
 *   * Workspace-anchored at every read path.
 *   * Re-exported via `packages/shared/src/index.ts`.
 */

// ===========================================================================
// 1. Trust Center sections (15 required, append-only)
// ===========================================================================

export const TRUST_CENTER_SECTIONS = [
  "PLATFORM_TRUST",
  "VERIFICATION_METHODOLOGY",
  "EVIDENCE_INTEGRITY",
  "TRUSTED_TIMESTAMPING",
  "OPEN_TIMESTAMPS",
  "CHAIN_OF_CUSTODY",
  "PROVENANCE",
  "SECURITY_CONTROLS",
  "AI_GOVERNANCE",
  "RELIABILITY",
  "DATA_PROCESSING",
  "PRIVACY",
  "SUBPROCESSORS",
  "GOVERNANCE",
  "TRANSPARENCY",
] as const;
export type TrustCenterSection = (typeof TRUST_CENTER_SECTIONS)[number];

export const METHODOLOGY_SECTIONS = [
  "HOW_VERIFICATION_WORKS",
  "HOW_HASHING_WORKS",
  "HOW_TRUSTED_TIMESTAMPS_WORK",
  "HOW_OTS_WORKS",
  "HOW_PROVENANCE_WORKS",
  "HOW_VERIFICATION_PACKAGES_WORK",
  "HOW_TRUST_DECISIONS_WORK",
  "HOW_REDACTION_WORKS",
  "HOW_INTELLIGENCE_WORKS",
] as const;
export type MethodologySection = (typeof METHODOLOGY_SECTIONS)[number];

export const AI_DISCLOSURE_SECTIONS = [
  "MODELS_USED",
  "PROVIDERS_USED",
  "DATA_SENT",
  "DATA_NOT_SENT",
  "CONFIDENCE_MODEL",
  "HUMAN_REVIEW_MODEL",
  "CORRECTION_MODEL",
  "LIMITATIONS",
  "KNOWN_RISKS",
  "PROVIDER_STATUS",
  "AI_ACTIVITY_TRANSPARENCY",
  "COST_TRANSPARENCY",
] as const;
export type AiDisclosureSection = (typeof AI_DISCLOSURE_SECTIONS)[number];

export const SECURITY_SECTIONS = [
  "AUTHENTICATION",
  "AUTHORIZATION",
  "RBAC",
  "MFA",
  "SAML",
  "SCIM",
  "ENCRYPTION",
  "KMS",
  "AUDIT_LOGGING",
  "EVIDENCE_IMMUTABILITY",
  "OBJECT_LOCK",
  "ACCESS_CONTROLS",
  "MONITORING",
  "INCIDENT_RESPONSE",
  "DISASTER_RECOVERY",
  "RETENTION",
  "DELETION",
  "SECURITY_CONTACTS",
] as const;
export type SecuritySection = (typeof SECURITY_SECTIONS)[number];

export const TRUST_ARTICLE_KINDS = [
  "TRUST_CENTER",
  "METHODOLOGY",
  "AI_DISCLOSURE",
  "SECURITY",
] as const;
export type TrustArticleKind = (typeof TRUST_ARTICLE_KINDS)[number];

export const TRUST_ARTICLE_STATES = [
  "DRAFT",
  "PUBLISHED",
  "DEPRECATED",
] as const;
export type TrustArticleState = (typeof TRUST_ARTICLE_STATES)[number];

export type TrustArticleProjection = {
  id: string;
  kind: TrustArticleKind;
  section: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  state: TrustArticleState;
  version: number;
  publishedAtUtc: string | null;
  updatedAtUtc: string;
  implementationReferences: ReadonlyArray<string>;
  policyTags: ReadonlyArray<string>;
  /**
   * Phase 4A Enterprise Closure — bounded drift verdict from
   * `trust-drift.service.ts`. Optional so older consumers stay
   * compatible; new UI surfaces render a chip when present.
   */
  driftState?: TrustArticleDriftState;
};

export type TrustArticleVersionProjection = {
  id: string;
  articleId: string;
  version: number;
  title: string;
  summary: string;
  body: string;
  state: TrustArticleState;
  authoredByUserId: string;
  createdAtUtc: string;
  publishedAtUtc: string | null;
};

// ===========================================================================
// 2. Subprocessor registry
// ===========================================================================

export const SUBPROCESSOR_STATES = [
  "ACTIVE",
  "PROPOSED",
  "DEPRECATED",
  "REMOVED",
] as const;
export type SubprocessorState = (typeof SUBPROCESSOR_STATES)[number];

export const SUBPROCESSOR_DATA_CATEGORIES = [
  "EVIDENCE_BYTES",
  "METADATA",
  "OCR_TEXT",
  "TRANSCRIPT_TEXT",
  "IMAGE_PIXELS",
  "USER_IDENTIFIERS",
  "AUDIT_LOGS",
  "ERROR_TELEMETRY",
  "STATUS_PROBES",
] as const;
export type SubprocessorDataCategory =
  (typeof SUBPROCESSOR_DATA_CATEGORIES)[number];

export type SubprocessorProjection = {
  id: string;
  name: string;
  slug: string;
  vendor: string;
  purpose: string;
  region: string;
  dataCategories: ReadonlyArray<SubprocessorDataCategory>;
  state: SubprocessorState;
  effectiveAtUtc: string;
  documentationUrl: string | null;
  contractRef: string | null;
  version: number;
  changeHistorySummary: string;
};

// ===========================================================================
// 3. Status Page
// ===========================================================================

export const STATUS_COMPONENT_KEYS = [
  "API",
  "VERIFICATION",
  "CAPTURE",
  "REPORTS",
  "AI_SERVICES",
  "AZURE_DI",
  "DEEPGRAM",
  "AWS_REKOGNITION",
  "AWS_S3",
  "BACKGROUND_WORKERS",
  "QUEUE_HEALTH",
  "STORAGE_HEALTH",
  "DEPENDENCY_HEALTH",
] as const;
export type StatusComponentKey = (typeof STATUS_COMPONENT_KEYS)[number];

export const STATUS_COMPONENT_HEALTHS = [
  "OPERATIONAL",
  "DEGRADED",
  "PARTIAL_OUTAGE",
  "MAJOR_OUTAGE",
  "MAINTENANCE",
  "UNKNOWN",
] as const;
export type StatusComponentHealth = (typeof STATUS_COMPONENT_HEALTHS)[number];

export const STATUS_INCIDENT_SEVERITIES = [
  "INFO",
  "MINOR",
  "MAJOR",
  "CRITICAL",
] as const;
export type StatusIncidentSeverity =
  (typeof STATUS_INCIDENT_SEVERITIES)[number];

export const STATUS_INCIDENT_STATES = [
  "INVESTIGATING",
  "IDENTIFIED",
  "MONITORING",
  "RESOLVED",
  "POSTMORTEM_DRAFT",
  "POSTMORTEM_PUBLISHED",
] as const;
export type StatusIncidentState = (typeof STATUS_INCIDENT_STATES)[number];

export type StatusComponentProjection = {
  key: StatusComponentKey;
  label: string;
  health: StatusComponentHealth;
  description: string;
  lastUpdatedUtc: string;
  upstreamSource: string;
  upstreamReference: string | null;
};

export type StatusIncidentUpdateProjection = {
  id: string;
  body: string;
  state: StatusIncidentState;
  createdAtUtc: string;
};

export type StatusIncidentProjection = {
  id: string;
  externalRef: string | null;
  title: string;
  severity: StatusIncidentSeverity;
  state: StatusIncidentState;
  componentKeys: ReadonlyArray<StatusComponentKey>;
  startedAtUtc: string;
  resolvedAtUtc: string | null;
  postmortemUrl: string | null;
  updates: ReadonlyArray<StatusIncidentUpdateProjection>;
};

export type MaintenanceWindowProjection = {
  id: string;
  title: string;
  description: string;
  componentKeys: ReadonlyArray<StatusComponentKey>;
  startsAtUtc: string;
  endsAtUtc: string;
  state: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
};

export const STATUS_PAGE_SCHEMA_VERSION = "PROOVRA_STATUS_PAGE_V1" as const;

export type StatusPageProjection = {
  schemaVersion: typeof STATUS_PAGE_SCHEMA_VERSION;
  generatedAtUtc: string;
  upstreamProvider: "BETTER_STACK" | "LOCAL";
  overallHealth: StatusComponentHealth;
  components: ReadonlyArray<StatusComponentProjection>;
  activeIncidents: ReadonlyArray<StatusIncidentProjection>;
  recentIncidents: ReadonlyArray<StatusIncidentProjection>;
  maintenanceWindows: ReadonlyArray<MaintenanceWindowProjection>;
  limitations: ReadonlyArray<string>;
};

// ===========================================================================
// 4. Organization governance — orgs, departments, delegated admin tiers
// ===========================================================================

export const ORGANIZATION_STATES = ["ACTIVE", "SUSPENDED", "ARCHIVED"] as const;
export type OrganizationState = (typeof ORGANIZATION_STATES)[number];

export const DEPARTMENT_STATES = ["ACTIVE", "ARCHIVED"] as const;
export type DepartmentState = (typeof DEPARTMENT_STATES)[number];

export const DELEGATED_ADMIN_TIERS = [
  "GLOBAL_ADMIN",
  "ORG_ADMIN",
  "DEPARTMENT_ADMIN",
  "WORKSPACE_ADMIN",
  "REVIEWER_LEAD",
  "SECURITY_OFFICER",
  "COMPLIANCE_OFFICER",
] as const;
export type DelegatedAdminTier = (typeof DELEGATED_ADMIN_TIERS)[number];

export const DELEGATED_ADMIN_GRANT_STATES = [
  "ACTIVE",
  "REVOKED",
  "EXPIRED",
] as const;
export type DelegatedAdminGrantState =
  (typeof DELEGATED_ADMIN_GRANT_STATES)[number];

export type OrganizationProjection = {
  id: string;
  teamId: string;
  name: string;
  slug: string;
  state: OrganizationState;
  createdAtUtc: string;
  departmentCount: number;
  workspaceCount: number;
};

export type DepartmentProjection = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  state: DepartmentState;
  workspaceCount: number;
  reviewerCount: number;
  createdAtUtc: string;
};

export type DelegatedAdminGrantProjection = {
  id: string;
  organizationId: string;
  departmentId: string | null;
  workspaceId: string | null;
  granteeUserId: string;
  tier: DelegatedAdminTier;
  state: DelegatedAdminGrantState;
  grantedByUserId: string;
  grantedAtUtc: string;
  revokedAtUtc: string | null;
  expiresAtUtc: string | null;
};

// ===========================================================================
// 5. Governance policies — registry + scoping + enforcement
// ===========================================================================

export const GOVERNANCE_POLICY_KINDS = [
  "SECURITY",
  "REVIEW",
  "RETENTION",
  "REDACTION",
  "INTELLIGENCE",
  "VERIFICATION",
] as const;
export type GovernancePolicyKind = (typeof GOVERNANCE_POLICY_KINDS)[number];

export const GOVERNANCE_POLICY_SCOPES = [
  "ORGANIZATION",
  "DEPARTMENT",
  "WORKSPACE",
] as const;
export type GovernancePolicyScope =
  (typeof GOVERNANCE_POLICY_SCOPES)[number];

export const GOVERNANCE_POLICY_ENFORCEMENT_MODES = [
  "BLOCK",
  "WARN",
  "AUDIT_ONLY",
] as const;
export type GovernancePolicyEnforcementMode =
  (typeof GOVERNANCE_POLICY_ENFORCEMENT_MODES)[number];

export const GOVERNANCE_POLICY_STATES = [
  "DRAFT",
  "ACTIVE",
  "DEPRECATED",
] as const;
export type GovernancePolicyState =
  (typeof GOVERNANCE_POLICY_STATES)[number];

export type GovernancePolicyProjection = {
  id: string;
  kind: GovernancePolicyKind;
  slug: string;
  name: string;
  summary: string;
  state: GovernancePolicyState;
  enforcementMode: GovernancePolicyEnforcementMode;
  rule: Record<string, unknown>;
  version: number;
  createdByUserId: string;
  createdAtUtc: string;
};

export type GovernancePolicyAssignmentProjection = {
  id: string;
  policyId: string;
  scope: GovernancePolicyScope;
  scopeTargetId: string;
  inheritFromParent: boolean;
  isOverride: boolean;
  assignedByUserId: string;
  assignedAtUtc: string;
};

export type GovernancePolicyAuditRow = {
  id: string;
  policyId: string;
  code: string;
  actorUserId: string | null;
  reason: string | null;
  occurredAtUtc: string;
};

// ===========================================================================
// 6. Access reviews
// ===========================================================================

export const ACCESS_REVIEW_CAMPAIGN_KINDS = [
  "PERIODIC",
  "MANAGER",
  "SECURITY",
  "ROLE_CERTIFICATION",
  "ACCESS_CERTIFICATION",
] as const;
export type AccessReviewCampaignKind =
  (typeof ACCESS_REVIEW_CAMPAIGN_KINDS)[number];

export const ACCESS_REVIEW_CAMPAIGN_STATES = [
  "DRAFT",
  "OPEN",
  "CLOSED",
  "CANCELLED",
] as const;
export type AccessReviewCampaignState =
  (typeof ACCESS_REVIEW_CAMPAIGN_STATES)[number];

export const ACCESS_REVIEW_ITEM_DECISIONS = [
  "PENDING",
  "APPROVED",
  "REVOKED",
  "ESCALATED",
] as const;
export type AccessReviewItemDecision =
  (typeof ACCESS_REVIEW_ITEM_DECISIONS)[number];

export type AccessReviewCampaignProjection = {
  id: string;
  kind: AccessReviewCampaignKind;
  name: string;
  state: AccessReviewCampaignState;
  organizationId: string | null;
  departmentId: string | null;
  workspaceId: string | null;
  scheduledStartUtc: string;
  scheduledEndUtc: string;
  createdByUserId: string;
  totalItems: number;
  pendingItems: number;
  approvedItems: number;
  revokedItems: number;
  escalatedItems: number;
};

export type AccessReviewItemProjection = {
  id: string;
  campaignId: string;
  subjectUserId: string;
  /** Bounded reference to the grant being reviewed (e.g. delegated_admin:<id>). */
  grantRef: string;
  decision: AccessReviewItemDecision;
  reviewerUserId: string | null;
  reviewedAtUtc: string | null;
  notes: string | null;
};

// ===========================================================================
// 7. Cross-org review grants
// ===========================================================================

export const CROSS_ORG_REVIEW_STATES = [
  "INVITED",
  "ACCEPTED",
  "DECLINED",
  "REVOKED",
  "EXPIRED",
] as const;
export type CrossOrgReviewState = (typeof CROSS_ORG_REVIEW_STATES)[number];

export type CrossOrgReviewGrantProjection = {
  id: string;
  invitingOrganizationId: string;
  invitedOrganizationId: string | null;
  invitedOrgSlug: string;
  externalReviewGrantId: string | null;
  state: CrossOrgReviewState;
  scope: string;
  expiresAtUtc: string | null;
  createdByUserId: string;
  createdAtUtc: string;
};

// ===========================================================================
// 8. Governance dashboard projection
// ===========================================================================

export const GOVERNANCE_DASHBOARD_SCHEMA_VERSION =
  "PROOVRA_GOVERNANCE_DASHBOARD_V1" as const;

export type GovernanceDashboardProjection = {
  schemaVersion: typeof GOVERNANCE_DASHBOARD_SCHEMA_VERSION;
  generatedAtUtc: string;
  teamId: string;
  compliance: {
    policyCount: number;
    policiesActive: number;
    policiesDraft: number;
    policiesDeprecated: number;
    policiesPerKind: Record<GovernancePolicyKind, number>;
  };
  accessReviews: {
    totalCampaigns: number;
    openCampaigns: number;
    pendingItems: number;
    approvedItems: number;
    revokedItems: number;
    escalatedItems: number;
  };
  delegatedAdminActivity: {
    activeGrants: number;
    revokedLast30d: number;
    grantsPerTier: Record<DelegatedAdminTier, number>;
  };
  departments: {
    total: number;
    workspaces: number;
    reviewers: number;
  };
  crossOrg: {
    activeGrants: number;
    pendingInvitations: number;
  };
  policyViolations: {
    totalLast30d: number;
    blockingLast30d: number;
  };
  auditHealth: {
    activityEventsLast24h: number;
    activityEventsLast30d: number;
  };
  securityHealth: {
    mfaCoveragePct: number;
    samlEnabled: boolean;
    scimEnabled: boolean;
  };
  trustHealth: {
    publishedTrustArticles: number;
    publishedMethodologyArticles: number;
    publishedAiDisclosureArticles: number;
    publishedSecurityArticles: number;
    activeSubprocessors: number;
  };
  limitations: ReadonlyArray<string>;
};

// ===========================================================================
// 9. Verification-package manifest extensions
// ===========================================================================

export type TrustManifestEntry = {
  schemaVersion: "PROOVRA_TRUST_MANIFEST_V1";
  generatedAtUtc: string;
  trustArticles: ReadonlyArray<{
    section: string;
    slug: string;
    title: string;
    version: number;
    publishedAtUtc: string | null;
  }>;
  activeSubprocessorCount: number;
};

export type GovernanceManifestEntry = {
  schemaVersion: "PROOVRA_GOVERNANCE_MANIFEST_V1";
  generatedAtUtc: string;
  policyCount: number;
  policiesActive: number;
  policiesPerKind: Record<GovernancePolicyKind, number>;
  accessReviewCampaignCount: number;
  delegatedAdminActiveGrants: number;
  crossOrgActiveGrants: number;
};

export type MethodologyManifestEntry = {
  schemaVersion: "PROOVRA_METHODOLOGY_MANIFEST_V1";
  generatedAtUtc: string;
  sections: ReadonlyArray<{
    section: MethodologySection;
    slug: string;
    version: number;
    publishedAtUtc: string | null;
  }>;
};

export type AiDisclosureManifestEntry = {
  schemaVersion: "PROOVRA_AI_DISCLOSURE_MANIFEST_V1";
  generatedAtUtc: string;
  sections: ReadonlyArray<{
    section: AiDisclosureSection;
    slug: string;
    version: number;
    publishedAtUtc: string | null;
  }>;
};

export type SubprocessorManifestEntry = {
  schemaVersion: "PROOVRA_SUBPROCESSOR_MANIFEST_V1";
  generatedAtUtc: string;
  subprocessors: ReadonlyArray<{
    slug: string;
    name: string;
    vendor: string;
    region: string;
    purpose: string;
    dataCategories: ReadonlyArray<SubprocessorDataCategory>;
    state: SubprocessorState;
    version: number;
    effectiveAtUtc: string;
  }>;
};

// ===========================================================================
// 10. Standing limitations
// ===========================================================================

export const TRUST_AND_GOVERNANCE_LIMITATIONS: ReadonlyArray<string> = [
  "TRUST_ARTICLES_ARE_PROVENANCE_NEVER_GROUND_TRUTH",
  "STATUS_PAGE_REFLECTS_UPSTREAM_PROBE_LAG_UP_TO_60S",
  "SUBPROCESSOR_REGISTRY_IS_AUTHORITATIVE_BUT_PER_TENANT_CONTRACT_OVERRIDES_APPLY",
  "DELEGATED_ADMIN_TIERS_ARE_ENFORCED_SERVER_SIDE",
  "GOVERNANCE_POLICIES_ENFORCEMENT_MODE_BLOCK_WARN_OR_AUDIT_ONLY",
  "ACCESS_REVIEW_DECISIONS_ARE_APPEND_ONLY",
];

// ===========================================================================
// Phase 4A Enterprise Closure — additions.
// ===========================================================================

/**
 * Trust article drift state. CURRENT = every implementation
 * reference exists; STALE = at least one missing; NEEDS_REVIEW =
 * operator-flagged for human re-validation.
 */
export const TRUST_ARTICLE_DRIFT_STATES = [
  "CURRENT",
  "STALE",
  "NEEDS_REVIEW",
] as const;
export type TrustArticleDriftState =
  (typeof TRUST_ARTICLE_DRIFT_STATES)[number];

/**
 * Bounded grant kinds the access-review item `grantRef` field
 * supports. The propagation engine parses the prefix and routes
 * REVOKED decisions to the right service.
 */
export const ACCESS_REVIEW_GRANT_KINDS = [
  "DELEGATED_ADMIN",
  "EXTERNAL_REVIEW",
  "DEPARTMENT_MEMBERSHIP",
] as const;
export type AccessReviewGrantKind =
  (typeof ACCESS_REVIEW_GRANT_KINDS)[number];

/**
 * Bounded policy evaluation decisions. Mirrors the redaction policy
 * engine vocabulary so consumers can compose decisions across phases.
 */
export const POLICY_EVALUATION_DECISIONS = [
  "ALLOW",
  "WARN",
  "BLOCK",
] as const;
export type PolicyEvaluationDecision =
  (typeof POLICY_EVALUATION_DECISIONS)[number];

export type PolicyEvaluationResult = {
  decision: PolicyEvaluationDecision;
  /** Bounded reason chip — never PII. */
  reason: string | null;
  /** Policy id that produced the strictest decision. */
  policyId: string | null;
};

/**
 * Status component probe verdicts. Bounded; honest. UNKNOWN is the
 * default when a probe is not configured or its upstream is
 * unreachable — we NEVER report OPERATIONAL by default.
 */
export const STATUS_PROBE_VERDICTS = [
  "OPERATIONAL",
  "DEGRADED",
  "DOWN",
  "UNKNOWN",
] as const;
export type StatusProbeVerdict = (typeof STATUS_PROBE_VERDICTS)[number];

export type StatusProbeReport = {
  componentKey: StatusComponentKey;
  source: "INTERNAL" | "BETTER_STACK";
  verdict: StatusProbeVerdict;
  latencyMs: number | null;
  detail: string | null;
  probedAtUtc: string;
};

/**
 * Security claim check projection — drives the per-control "evidence
 * verified" badges in the Security Documentation Center.
 */
export const SECURITY_CONTROL_CONFIDENCE = [
  "IMPLEMENTED",
  "PARTIAL",
  "PLANNED",
  "UNAVAILABLE",
] as const;
export type SecurityControlConfidence =
  (typeof SECURITY_CONTROL_CONFIDENCE)[number];

export type SecurityClaimCheckProjection = {
  controlKey: SecuritySection;
  documented: boolean;
  implemented: boolean;
  implementationReferencesOk: boolean;
  confidence: SecurityControlConfidence;
  evidencePaths: ReadonlyArray<string>;
  limitation: string | null;
  ownerUserId: string | null;
  lastVerifiedAtUtc: string;
};

/**
 * Department membership projection. Bounded role within the
 * department: MEMBER / LEAD / ADMIN.
 */
export const DEPARTMENT_MEMBERSHIP_ROLES = [
  "MEMBER",
  "LEAD",
  "ADMIN",
] as const;
export type DepartmentMembershipRole =
  (typeof DEPARTMENT_MEMBERSHIP_ROLES)[number];

export const DEPARTMENT_MEMBERSHIP_STATES = ["ACTIVE", "REVOKED"] as const;
export type DepartmentMembershipState =
  (typeof DEPARTMENT_MEMBERSHIP_STATES)[number];

export type DepartmentMembershipProjection = {
  id: string;
  departmentId: string;
  userId: string;
  role: DepartmentMembershipRole;
  state: DepartmentMembershipState;
  grantedByUserId: string | null;
  createdAtUtc: string;
  revokedAtUtc: string | null;
};

/**
 * Department scope envelope returned by `resolveUserDepartmentScope`.
 * Consumers narrow their `where` clauses against this.
 *
 *   * `unrestricted = true` → the user holds GLOBAL_ADMIN or
 *     ORG_ADMIN; no department filter applies (the query may see
 *     all departments in the workspace).
 *   * `unrestricted = false` → the user only sees evidence whose
 *     `departmentId IS NULL` or `departmentId IN allowedDepartmentIds`.
 *     The empty-set case means the user sees ONLY records with
 *     `departmentId IS NULL`.
 */
export type DepartmentScopeEnvelope = {
  teamId: string;
  userId: string;
  unrestricted: boolean;
  allowedDepartmentIds: ReadonlyArray<string>;
};

/**
 * Extended lifecycle codes for the Phase 4A audit stream. These
 * are emitted alongside the Phase 3B codes via the existing
 * `intelligence-activity.service.ts` emitter.
 */
export const TRUST_LIFECYCLE_CODES = [
  "TRUST_ARTICLE_CREATED",
  "TRUST_ARTICLE_UPDATED",
  "TRUST_ARTICLE_PUBLISHED",
  "TRUST_ARTICLE_SUPERSEDED",
  "TRUST_ARTICLE_REVIEWED",
  "TRUST_ARTICLE_MARKED_STALE",
  "SUBPROCESSOR_CREATED",
  "SUBPROCESSOR_UPDATED",
  "SUBPROCESSOR_DEPRECATED",
  "STATUS_INCIDENT_CREATED",
  "STATUS_INCIDENT_UPDATED",
  "STATUS_MAINTENANCE_SCHEDULED",
  "ACCESS_REVIEW_DECIDED",
  "ACCESS_REVIEW_GRANT_REVOKED",
  "CROSS_ORG_REVIEW_CREATED",
  "CROSS_ORG_REVIEW_ACCEPTED",
  "CROSS_ORG_REVIEW_DECLINED",
  "CROSS_ORG_REVIEW_REVOKED",
  "DELEGATED_ADMIN_GRANTED",
  "DELEGATED_ADMIN_REVOKED",
  "DEPARTMENT_CREATED",
  "DEPARTMENT_ARCHIVED",
  // PHASE 12B CLUSTER 14 — department membership governance. These are the
  // canonical audit codes for the grant / revoke writes behind
  // `resolveUserDepartmentScope`; both classify as GOVERNANCE_LIFECYCLE.
  "DEPARTMENT_MEMBERSHIP_GRANTED",
  "DEPARTMENT_MEMBERSHIP_REVOKED",
  "POLICY_EVALUATED",
  "POLICY_WARNING",
  "POLICY_BLOCK",
  "POLICY_VIOLATION",
] as const;
export type TrustLifecycleCode = (typeof TRUST_LIFECYCLE_CODES)[number];

export const TRUST_LIFECYCLE_CATEGORIES = [
  "TRUST_LIFECYCLE",
  "GOVERNANCE_LIFECYCLE",
] as const;
export type TrustLifecycleCategory =
  (typeof TRUST_LIFECYCLE_CATEGORIES)[number];

export function classifyTrustLifecycleCategory(
  code: TrustLifecycleCode,
): TrustLifecycleCategory {
  if (code.startsWith("TRUST_") || code.startsWith("SUBPROCESSOR_") || code.startsWith("STATUS_")) {
    return "TRUST_LIFECYCLE";
  }
  return "GOVERNANCE_LIFECYCLE";
}
