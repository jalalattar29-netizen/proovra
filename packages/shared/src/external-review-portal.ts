/**
 * PROOVRA Phase 2B — External Reviewer Portal shared contracts.
 *
 * Single source of truth for the bounded vocabulary the External
 * Reviewer Portal shares between API, web, and worker:
 *
 *   * External role catalog + capability matrix
 *   * Portal activity codes (audit timeline)
 *   * Decision verdicts (separate from internal verdicts)
 *   * Watermark policy + signed-payload shape
 *   * Bounded denial reasons
 *   * Session timeout
 *
 * Hard rules:
 *   1. Append-only enums (renaming is breaking).
 *   2. Rationale strings bounded ≤ 600 chars at use sites.
 *   3. NEVER asserts authenticity / admissibility of content. External
 *      decisions record what the external reviewer said, not truth.
 *   4. External reviewers are NEVER granted internal-only capabilities
 *      (review.adjudicate, review.schema.author, review.qc.verdict,
 *      review.bulk).
 */

// =============================================================================
// 1. External role catalog
// =============================================================================

export const EXTERNAL_REVIEWER_ROLES = [
  "EXTERNAL_VIEWER",
  "EXTERNAL_REVIEWER",
  "EXTERNAL_LEGAL_REVIEWER",
  "EXTERNAL_INSURANCE_REVIEWER",
  "EXTERNAL_OBSERVER",
  "EXTERNAL_APPROVER",
] as const;
export type ExternalReviewerRole = (typeof EXTERNAL_REVIEWER_ROLES)[number];

/**
 * Bounded external capability matrix.
 *
 *   portal.view              — open assigned reviews
 *   portal.annotate          — add annotations to assigned evidence
 *   portal.comment           — post / reply to review comments
 *   portal.decide            — submit a decision (approve/reject/…)
 *   portal.history.read      — read own activity history
 *   portal.download_package  — download verification package (when grant permits)
 */
export const EXTERNAL_PORTAL_CAPABILITIES = [
  "portal.view",
  "portal.annotate",
  "portal.comment",
  "portal.decide",
  "portal.history.read",
  "portal.download_package",
] as const;
export type ExternalPortalCapability =
  (typeof EXTERNAL_PORTAL_CAPABILITIES)[number];

export const EXTERNAL_PORTAL_CAPABILITY_MATRIX: Readonly<
  Record<ExternalReviewerRole, ReadonlyArray<ExternalPortalCapability>>
> = {
  // Observer — read-only.
  EXTERNAL_OBSERVER: ["portal.view", "portal.history.read"],
  // Viewer — read-only + comment.
  EXTERNAL_VIEWER: ["portal.view", "portal.history.read", "portal.comment"],
  // Reviewer — full review (annotate + comment + decide).
  EXTERNAL_REVIEWER: [
    "portal.view",
    "portal.annotate",
    "portal.comment",
    "portal.decide",
    "portal.history.read",
  ],
  EXTERNAL_LEGAL_REVIEWER: [
    "portal.view",
    "portal.annotate",
    "portal.comment",
    "portal.decide",
    "portal.history.read",
  ],
  EXTERNAL_INSURANCE_REVIEWER: [
    "portal.view",
    "portal.annotate",
    "portal.comment",
    "portal.decide",
    "portal.history.read",
  ],
  // Approver — view + decide; no annotation.
  EXTERNAL_APPROVER: [
    "portal.view",
    "portal.decide",
    "portal.comment",
    "portal.history.read",
  ],
};

export function externalPortalCapabilitiesForRole(
  role: ExternalReviewerRole,
): ReadonlySet<ExternalPortalCapability> {
  return new Set(EXTERNAL_PORTAL_CAPABILITY_MATRIX[role]);
}

// =============================================================================
// 2. Portal activity codes (audit timeline)
// =============================================================================

export const EXTERNAL_PORTAL_ACTIVITY_CODES = [
  // Grant lifecycle
  "GRANT_ISSUED",
  "GRANT_RESENT",
  "GRANT_REVOKED",
  "GRANT_ACCEPTED",
  "GRANT_EXPIRED",
  "GRANT_DENIED_ATTEMPT",
  // Session
  "LOGIN",
  "LOGOUT",
  "MFA_CHALLENGE_PASSED",
  "MFA_CHALLENGE_FAILED",
  "INACTIVITY_TIMEOUT",
  // Review
  "REVIEW_OPENED",
  "EVIDENCE_VIEWED",
  "ANNOTATION_CREATED",
  "COMMENT_POSTED",
  "DECISION_SUBMITTED",
  // Watermark / download attempts
  "WATERMARK_RENDERED",
  "DOWNLOAD_ATTEMPTED",
  "DOWNLOAD_PERMITTED",
  "DOWNLOAD_REFUSED",
  // Phase 2B Closure — invitation delivery
  "INVITATION_EMAIL_SENT",
  "INVITATION_EMAIL_FAILED",
  "INVITATION_RESENT",
  // Phase 2B Closure — bulk operations
  "BULK_INVITATION_STARTED",
  "BULK_INVITATION_COMPLETED",
  "BULK_INVITATION_ROW_FAILED",
  "BULK_REVOKE_STARTED",
  "BULK_REVOKE_COMPLETED",
  // Phase 2B Closure — SSO federation
  "EXTERNAL_SSO_STARTED",
  "EXTERNAL_SSO_SUCCEEDED",
  "EXTERNAL_SSO_FAILED",
  "EXTERNAL_SSO_IDENTITY_MISMATCH",
  // Phase 2B Closure — bounded session lifecycle events
  "PORTAL_SESSION_EXPIRED",
  "PORTAL_SESSION_REVOKED",
] as const;
export type ExternalPortalActivityCode =
  (typeof EXTERNAL_PORTAL_ACTIVITY_CODES)[number];

// =============================================================================
// Phase 2B Closure — portal authentication methods
// =============================================================================

export const PORTAL_AUTH_METHODS = ["TOKEN", "SSO"] as const;
export type PortalAuthMethod = (typeof PORTAL_AUTH_METHODS)[number];

// =============================================================================
// Phase 2B Closure — bounded invitation delivery status
// =============================================================================

export const INVITATION_DELIVERY_STATUSES = [
  "PENDING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "FAILED",
  "REVOKED",
  "EXPIRED",
] as const;
export type InvitationDeliveryStatus =
  (typeof INVITATION_DELIVERY_STATUSES)[number];

// =============================================================================
// Phase 2B Closure — bulk invitation per-row outcome
// =============================================================================

export const BULK_INVITATION_ROW_OUTCOMES = [
  "INVITED",
  "FAILED",
  "DUPLICATE",
  "INVALID_EMAIL",
  "POLICY_DENIED",
] as const;
export type BulkInvitationRowOutcome =
  (typeof BULK_INVITATION_ROW_OUTCOMES)[number];

export type BulkInvitationResultRow = {
  inviteEmail: string;
  outcome: BulkInvitationRowOutcome;
  grantId: string | null;
  /** Bounded denial reason when the outcome is FAILED / POLICY_DENIED. */
  denial: string | null;
};

export const BULK_INVITATION_MAX_ROWS = 100;

// =============================================================================
// 3. External decision verdicts
//
// Distinct from internal REVIEWER_VERDICTS. External decisions feed back
// into the internal disagreement / approval workflows.
// =============================================================================

export const EXTERNAL_DECISION_VERDICTS = [
  "APPROVE",
  "REJECT",
  "REQUEST_CHANGES",
  "ABSTAIN",
  "ESCALATE",
] as const;
export type ExternalDecisionVerdict =
  (typeof EXTERNAL_DECISION_VERDICTS)[number];

// =============================================================================
// 4. Watermark policy + signed-payload shape
// =============================================================================

export const WATERMARK_POLICIES = [
  "ALWAYS",
  "BYTES_ONLY",
  "NEVER",
] as const;
export type WatermarkPolicy = (typeof WATERMARK_POLICIES)[number];

/**
 * Bounded signed watermark payload. Rendered as a translucent CSS
 * overlay on top of the evidence viewer. The HMAC signature lets the
 * server prove a watermark token came from PROOVRA without exposing
 * the signing key.
 *
 * Hard rules:
 *   * NEVER include sensitive PII beyond the bounded fields below.
 *   * The token is single-use against a (grantId, evidenceId) pair —
 *     replaying it after the session ends fails closed.
 */
export type WatermarkPayload = {
  schemaVersion: "PROOVRA_WATERMARK_V1";
  grantId: string;
  sessionId: string;
  reviewerEmail: string;
  reviewerDisplayName: string | null;
  organization: string | null;
  evidenceId: string | null;
  issuedAtUtc: string;
  ttlSeconds: number;
};

export type SignedWatermark = {
  payload: WatermarkPayload;
  /** Hex HMAC-SHA256 over canonical-JSON(payload). */
  signatureHex: string;
};

// =============================================================================
// 5. Bounded denial reasons
// =============================================================================

export const EXTERNAL_PORTAL_DENIAL_REASONS = [
  "TOKEN_INVALID",
  "TOKEN_EXPIRED",
  "TOKEN_REVOKED",
  "MFA_REQUIRED",
  "MFA_INVALID",
  "INACTIVITY_TIMEOUT",
  "NOT_PERMITTED",
  "OUT_OF_SCOPE",
  "WORKFLOW_NOT_FOUND",
  "RATE_LIMITED",
  "POLICY_REJECTED",
  "DECISION_ALREADY_RECORDED",
  "COMMENT_BODY_INVALID",
  "INVITE_NOT_FOUND",
  "INVITE_ALREADY_ACCEPTED",
  "INVITE_ALREADY_REVOKED",
] as const;
export type ExternalPortalDenialReason =
  (typeof EXTERNAL_PORTAL_DENIAL_REASONS)[number];

// =============================================================================
// 6. Bounded session timeout
// =============================================================================

/** Inactivity timeout. Re-authentication required after this many ms. */
export const EXTERNAL_PORTAL_INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
/** Maximum portal session lifetime regardless of activity. */
export const EXTERNAL_PORTAL_MAX_SESSION_MS = 8 * 60 * 60 * 1000; // 8h

// =============================================================================
// 7. Portal projection shape
// =============================================================================

export const EXTERNAL_PORTAL_SCHEMA_VERSION =
  "PROOVRA_EXTERNAL_PORTAL_V1" as const;

export type ExternalPortalProjection = {
  schemaVersion: typeof EXTERNAL_PORTAL_SCHEMA_VERSION;
  generatedAtUtc: string;

  reviewer: {
    grantId: string;
    email: string;
    displayName: string | null;
    organization: string | null;
    role: ExternalReviewerRole;
    capabilities: ReadonlyArray<ExternalPortalCapability>;
  };

  scope: {
    kind: "EVIDENCE" | "CASE" | "PACKAGE";
    label: string;
    expiresAtUtc: string;
  };

  /** Bounded list of assigned reviews. */
  assigned: ReadonlyArray<{
    workflowId: string;
    evidenceId: string;
    title: string | null;
    dueAt: string | null;
    submittedDecisionAtUtc: string | null;
  }>;

  completedCount: number;
  pendingCount: number;
  totalCount: number;

  watermark: {
    policy: WatermarkPolicy;
    signedToken: SignedWatermark | null;
  };

  session: {
    sessionId: string;
    inactivityTimeoutMs: number;
    maxSessionMs: number;
    /**
     * Phase 2B Closure — federation + adaptive auth surface for the
     * portal UI. `authMethod` is bounded by PORTAL_AUTH_METHODS;
     * `ssoConnectionId` is non-null when the grant is federation-bound;
     * `ssoSubjectHash` is non-null once SSO has been bound at least
     * once; `mfaSatisfied` and `mfaRequired` drive the bounded chips
     * the dashboard ribbon shows the reviewer.
     */
    authMethod: PortalAuthMethod;
    ssoConnectionId: string | null;
    ssoSubjectHash: string | null;
    mfaRequired: boolean;
    mfaSatisfied: boolean;
  };

  /** Standing limitations — always surfaced in the portal footer. */
  limitations: ReadonlyArray<string>;
};

export const EXTERNAL_PORTAL_LIMITATIONS: ReadonlyArray<string> = [
  "PORTAL_NOT_A_LEGAL_OPINION",
  "PORTAL_NEVER_ASSERTS_AUTHENTICITY",
  "PORTAL_ACCESS_ENDS_AT_GRANT_EXPIRY",
  "PORTAL_ACTIVITY_IS_AUDITED",
];
