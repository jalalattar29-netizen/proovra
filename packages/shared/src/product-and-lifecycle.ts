// =============================================================================
// PROOVRA Phase 4B — Product Lines, Entitlements, Exchange, Webhooks,
// Retention, Legal Hold, Archive, Destruction & Lifecycle Dashboard contracts.
// =============================================================================

// -----------------------------------------------------------------------------
// Product Lines
// -----------------------------------------------------------------------------

export const PRODUCT_LINES = [
  'CAPTURE_AND_VERIFY',
  'INVESTIGATIONS',
  'ENTERPRISE',
] as const;

export type ProductLine = (typeof PRODUCT_LINES)[number];

export type ProductLineProjection = {
  line: ProductLine;
  label: string;
  summary: string;
  monthlyPriceUsdMicros: number;
  features: ReadonlyArray<string>;
  entitlementsIncluded: ReadonlyArray<EntitlementKey>;
};

// -----------------------------------------------------------------------------
// Entitlement Keys
// -----------------------------------------------------------------------------

export const ENTITLEMENT_KEYS = [
  // PLATFORM COMMERCIAL AUTHORITY CLOSURE (2026-09-07) — four more keys are
  // REMOVED from the vocabulary, following QUOTA_EVIDENCE_COUNT,
  // QUOTA_STORAGE_BYTES, QUOTA_USERS, QUOTA_WORKSPACES and
  // QUOTA_REVIEWER_SEATS out for the identical reason. Each was a SECOND
  // commercial authority over a question the plan catalog already owns, keyed
  // on ProductLine rather than on the purchased plan, resolved from a grants
  // table whose only writer is an operator-only route — so the answer for
  // every workspace that merely BOUGHT a plan was the hard-coded default:
  //
  //   FEATURE_EXTERNAL_PORTAL       default false. Gated external-review grant
  //                                 issuance and external-portal invitations.
  //                                 Pricing sells External Review on PRO and
  //                                 above; no purchase path could turn it on,
  //                                 so a paying customer was refused a
  //                                 capability they had bought. Canonical
  //                                 authority: PlanCapabilities
  //                                 .externalReviewIncluded, read through
  //                                 resolveEffectiveExternalReviewIncluded.
  //
  //   FEATURE_INTELLIGENCE          default false. Gated every provider call
  //                                 (OCR, transcription), so media
  //                                 intelligence was commercially unreachable
  //                                 on every self-serve plan. The canonical
  //                                 statement of "this plan has no AI" is
  //                                 aiAdvisoryMonthlyOperations <= 0; a
  //                                 separate boolean could only ever disagree
  //                                 with it. The workspace AI opt-out is
  //                                 WorkspaceAiPolicy and is untouched.
  //
  //   FEATURE_REVIEWER_WORKSPACE    default TRUE — the mirror-image failure.
  //                                 It granted the reviewer workspace to every
  //                                 plan including FREE, while the canonical
  //                                 PlanCapabilities.reviewerOperationsIncluded
  //                                 says TEAM and above. Two authorities over
  //                                 one question, disagreeing in opposite
  //                                 directions on the same route family.
  //
  //   QUOTA_AI_OPERATIONS_PER_MONTH default 25, on its own usage counter. A
  //                                 TEAM workspace sold 500 AI operations was
  //                                 refused at 25, and neither counter held
  //                                 the month's real total. Canonical
  //                                 authority: resolveEffectiveContractAiCap
  //                                 over aiAdvisoryMonthlyOperations, counted
  //                                 once on 'ai_advisory_operations'.
  //
  // Deleting the KEYS rather than only the call sites is the point: a key that
  // still exists can be granted by POST /v1/packaging/entitlements/grant and
  // read back by a future gate. Historical entitlement_grants rows carrying
  // them are untouched and simply never read again.
  'FEATURE_REDACTION',
  'FEATURE_TRUST_CENTER',
  'FEATURE_GOVERNANCE_PLATFORM',
  'FEATURE_EVIDENCE_EXCHANGE',
  'FEATURE_WEBHOOKS',
  'FEATURE_CHAIN_TRANSFER',
  'FEATURE_LEGAL_HOLD',
  'FEATURE_ARCHIVE_TIERS',
  'FEATURE_DESTRUCTION_GOVERNANCE',
  'FEATURE_LIFECYCLE_DASHBOARD',
  'FEATURE_DELEGATED_ADMIN',
  'FEATURE_DEPARTMENT_ISOLATION',
  'FEATURE_CROSS_ORG_REVIEW',
  // WCR-01 (2026-09-07) — `QUOTA_USERS`, `QUOTA_WORKSPACES` and
  // `QUOTA_REVIEWER_SEATS` are REMOVED from the vocabulary, following
  // `QUOTA_EVIDENCE_COUNT` / `QUOTA_STORAGE_BYTES` out for the same reason:
  // each was a second commercial authority over a quantity the plan catalog
  // already owns, keyed on ProductLine rather than on the purchased plan,
  // with an unprovisioned default that refused what the plan sells.
  //
  // Deleting the KEYS (not just the call sites) is the point: a key that
  // still exists can be granted by `POST /v1/packaging/entitlements/grant`
  // and read back by a future gate, which is how the first sweep left a live
  // authority behind. Historical `entitlement_grants` rows carrying these
  // keys are untouched and simply never read again.
  //
  // Canonical replacements: workspace seats → `resolveWorkspaceSeatState`;
  // additional workspaces → not sold; reviewer operations →
  // `PlanCapabilities.reviewerOperationsIncluded`.
  'QUOTA_API_REQUESTS_PER_DAY',
  'QUOTA_WEBHOOK_DELIVERIES_PER_DAY',
  'QUOTA_EXPORT_PACKAGES_PER_MONTH',
  'RETENTION_MAX_YEARS',
  // LEGAL_HOLD_MAX_ACTIVE retired 2026-09-08 — an invented numeric ceiling.
  //
  // Its three values were 0 unprovisioned, 25 on INVESTIGATIONS and 1000 on
  // ENTERPRISE, and not one of them was ever a contract term. The default of 0
  // would have refused every workspace the Enterprise contract had just
  // entitled, so the gate could only ever be wrong in one direction or the
  // other. Legal Hold admission is a CAPABILITY question, answered by
  // FEATURE_LEGAL_HOLD from plan + ACTIVE Enterprise contract. If a contracted
  // ceiling is ever sold it belongs on the contract beside seats and storage,
  // resolved by the same authority — not as a catalog constant here.
  'INTEGRATION_API_KEYS_MAX',
  'INTEGRATION_WEBHOOK_ENDPOINTS_MAX',
] as const;

export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export type EntitlementProjection = {
  key: EntitlementKey;
  kind: 'FEATURE' | 'QUOTA' | 'LIMIT';
  value: boolean | number;
  source: 'PLAN' | 'CUSTOM' | 'PROMO' | 'DEFAULT';
  updatedAtUtc: string;
  expiresAtUtc?: string | null;
};

// -----------------------------------------------------------------------------
// Evidence Exchange Packages
// -----------------------------------------------------------------------------

export const EXCHANGE_PACKAGE_KINDS = [
  'EVIDENCE',
  'CASE',
  'REVIEW',
  'REDACTION',
  'INTELLIGENCE',
  'GOVERNANCE',
  'AUDIT',
  'VERIFICATION',
  'REPORT',
] as const;

export const EXCHANGE_PACKAGE_STATES = [
  'DRAFT',
  'BUILDING',
  'READY',
  'DELIVERED',
  'EXPIRED',
  'REVOKED',
] as const;

export type ExchangePackageKind = (typeof EXCHANGE_PACKAGE_KINDS)[number];
export type ExchangePackageState = (typeof EXCHANGE_PACKAGE_STATES)[number];

export type ExchangePackageProjection = {
  id: string;
  teamId: string;
  kind: ExchangePackageKind;
  state: ExchangePackageState;
  evidenceIds: ReadonlyArray<string>;
  caseId?: string | null;
  scopeNote?: string | null;
  signedUrl?: string | null;
  signedUrlExpiresAtUtc?: string | null;
  packageSha256?: string | null;
  packageSizeBytes?: number | null;
  createdByUserId: string;
  createdAt: string;
  readyAtUtc?: string | null;
  deliveredAtUtc?: string | null;
  expiredAtUtc?: string | null;
  revokedAtUtc?: string | null;
  deliveryCount: number;
};

// -----------------------------------------------------------------------------
// Chain Transfers
// -----------------------------------------------------------------------------

export const CHAIN_TRANSFER_STATES = [
  'INITIATED',
  'PENDING_ACCEPTANCE',
  'ACCEPTED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
  'COMPLETED',
] as const;

export type ChainTransferState = (typeof CHAIN_TRANSFER_STATES)[number];

export type ChainTransferProjection = {
  id: string;
  teamId: string;
  fromOrganizationId: string;
  toOrganizationSlug: string;
  toOrganizationId?: string | null;
  evidenceIds: ReadonlyArray<string>;
  caseId?: string | null;
  state: ChainTransferState;
  packageId?: string | null;
  reasonNote?: string | null;
  expiresAtUtc?: string | null;
  initiatedByUserId: string;
  acceptedByUserId?: string | null;
  rejectedByUserId?: string | null;
  createdAt: string;
  respondedAtUtc?: string | null;
  completedAtUtc?: string | null;
};

// -----------------------------------------------------------------------------
// Webhooks
// -----------------------------------------------------------------------------

export const WEBHOOK_EVENT_KINDS = [
  'EVIDENCE_CREATED',
  'EVIDENCE_VERIFIED',
  'REVIEW_COMPLETED',
  'REPORT_GENERATED',
  'PACKAGE_CREATED',
  // PHASE 12B — truthful download audit semantics. Authorising a delivery
  // and minting a short-lived link is NOT evidence that bytes transferred.
  // `PACKAGE_DOWNLOAD_AUTHORIZED` is emitted when the server authorises the
  // delivery and issues a link; `PACKAGE_DOWNLOADED` is reserved for a real
  // transfer-completion signal (server streaming/proxy completion or a
  // verified storage-access event) and must never be emitted merely because
  // a URL was requested. Both remain in the vocabulary: subscribers of the
  // completion event keep their contract, and no historical event is renamed.
  'PACKAGE_DOWNLOAD_AUTHORIZED',
  'PACKAGE_DOWNLOADED',
  'LEGAL_HOLD_APPLIED',
  'LEGAL_HOLD_RELEASED',
  'ARCHIVE_TIER_CHANGED',
  'ARCHIVE_COMPLETED',
  'DESTRUCTION_REQUESTED',
  'DESTRUCTION_APPROVED',
  'DESTRUCTION_COMPLETED',
  'CHAIN_TRANSFER_INITIATED',
  'CHAIN_TRANSFER_ACCEPTED',
  'RETENTION_EXPIRED',
] as const;

export const WEBHOOK_DELIVERY_STATES = [
  'PENDING',
  'DELIVERED',
  'FAILED',
  'RETRYING',
  'DEAD_LETTERED',
] as const;

export type WebhookEventKind = (typeof WEBHOOK_EVENT_KINDS)[number];
export type WebhookDeliveryState = (typeof WEBHOOK_DELIVERY_STATES)[number];

// -----------------------------------------------------------------------------
// Retention Policies
// -----------------------------------------------------------------------------

export const RETENTION_POLICY_TEMPLATES = [
  'INSURANCE_7Y',
  'JOURNALISM_10Y',
  'CORPORATE_5Y',
  'CUSTOM',
] as const;

export type RetentionPolicyTemplate = (typeof RETENTION_POLICY_TEMPLATES)[number];

export type RetentionPolicyProjection = {
  id: string;
  name: string;
  template: RetentionPolicyTemplate;
  years: number;
  appliesTo: string;
  inheritsFrom?: string | null;
  isOverride: boolean;
  exceptions: ReadonlyArray<string>;
};

// -----------------------------------------------------------------------------
// Legal Holds
// -----------------------------------------------------------------------------

export const LEGAL_HOLD_KINDS = [
  'EVIDENCE',
  'CASE',
  'WORKSPACE',
  'ORGANIZATION',
] as const;

export const LEGAL_HOLD_STATES = [
  'ACTIVE',
  'RELEASED',
  'EXPIRED',
] as const;

export type LegalHoldKind = (typeof LEGAL_HOLD_KINDS)[number];
export type LegalHoldState = (typeof LEGAL_HOLD_STATES)[number];

export type LegalHoldProjection = {
  id: string;
  teamId: string;
  kind: LegalHoldKind;
  scopeTargetId?: string | null;
  name: string;
  reason: string;
  state: LegalHoldState;
  createdByUserId: string;
  createdAt: string;
  releasedByUserId?: string | null;
  releasedAtUtc?: string | null;
  expiresAtUtc?: string | null;
};

export const LEGAL_HOLD_LIFECYCLE_CODES = [
  'LEGAL_HOLD_CREATED',
  'LEGAL_HOLD_UPDATED',
  'LEGAL_HOLD_RELEASED',
  'LEGAL_HOLD_VIOLATION',
] as const;

export type LegalHoldLifecycleCode = (typeof LEGAL_HOLD_LIFECYCLE_CODES)[number];

// -----------------------------------------------------------------------------
// Archive Tiers
// -----------------------------------------------------------------------------

export const ARCHIVE_TIERS = [
  'HOT',
  'WARM',
  'COLD',
  'DEEP_ARCHIVE',
] as const;

export type ArchiveTier = (typeof ARCHIVE_TIERS)[number];

export type ArchiveTransitionProjection = {
  evidenceId: string;
  fromTier: ArchiveTier;
  toTier: ArchiveTier;
  transitionedAtUtc: string;
  reason?: string | null;
  costEstimateUsdMicros: number;
};

// -----------------------------------------------------------------------------
// Destruction Governance
// -----------------------------------------------------------------------------

export const DESTRUCTION_STATES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'COMPLETED',
  'CERTIFIED',
  'FAILED',
] as const;

export const DESTRUCTION_LIFECYCLE_CODES = [
  'DESTRUCTION_REQUESTED',
  'DESTRUCTION_APPROVED',
  'DESTRUCTION_REJECTED',
  'DESTRUCTION_EXECUTED',
  'DESTRUCTION_CERTIFIED',
  'DESTRUCTION_FAILED',
] as const;

export type DestructionState = (typeof DESTRUCTION_STATES)[number];
export type DestructionLifecycleCode = (typeof DESTRUCTION_LIFECYCLE_CODES)[number];

export type DestructionRequestProjection = {
  id: string;
  teamId: string;
  state: DestructionState;
  evidenceIds: ReadonlyArray<string>;
  reason: string;
  policyRef?: string | null;
  requestedByUserId: string;
  approverUserIds: ReadonlyArray<string>;
  executedAtUtc?: string | null;
  certifiedAtUtc?: string | null;
  createdAt: string;
  certificate?: DestructionCertificateProjection | null;
};

export type DestructionCertificateProjection = {
  id: string;
  requestId: string;
  evidenceCount: number;
  executedAtUtc: string;
  certifiedAtUtc: string;
  approvalChainUserIds: ReadonlyArray<string>;
  certificateHash: string;
  certificateUri?: string | null;
};

// -----------------------------------------------------------------------------
// Lifecycle Dashboard
// -----------------------------------------------------------------------------

export const LIFECYCLE_DASHBOARD_SCHEMA_VERSION = 'PROOVRA_LIFECYCLE_DASHBOARD_V1';

export type LifecycleDashboardProjection = {
  schemaVersion: typeof LIFECYCLE_DASHBOARD_SCHEMA_VERSION;
  generatedAtUtc: string;
  teamId: string;
  retention: {
    totalPolicies: number;
    activePolicies: number;
    overridePolicies: number;
    templateBreakdown: Record<string, number>;
  };
  legalHolds: {
    totalActive: number;
    totalReleased: number;
    totalExpired: number;
    byKind: Record<string, number>;
  };
  archive: {
    countByTier: Record<ArchiveTier, number>;
    costMicrosByTier: Record<ArchiveTier, number>;
    totalTransitions: number;
  };
  destruction: {
    totalRequested: number;
    totalApproved: number;
    totalRejected: number;
    totalCertified: number;
  };
  upcomingExpirations: {
    within30Days: number;
    within90Days: number;
  };
  violations: {
    totalLegalHoldViolations: number;
    totalRetentionViolations: number;
    /** Phase 4B Final Closure C7 — per-code breakdown from bounded POLICY_VIOLATION_* stream. */
    byCode: {
      POLICY_VIOLATION_ENTITLEMENT: number;
      POLICY_VIOLATION_LEGAL_HOLD: number;
      POLICY_VIOLATION_RETENTION: number;
      POLICY_VIOLATION_QUOTA: number;
    };
    totalBounded: number;
  };
  compliance: {
    overallScore: number;
    retentionCoverage: number;
    holdCoverage: number;
  };
  limitations: ReadonlyArray<string>;
  /**
   * Lifecycle Consolidation — capability enforcement status per capability.
   * Optional for backward compatibility with prior consumers.
   */
  capabilities?: LifecycleDashboardCapabilities;
};

// -----------------------------------------------------------------------------
// Lifecycle Consolidation — Capability enforcement status (Surface A honesty)
//
// Bounded vocabulary that tells the operator whether each lifecycle
// capability is actually enforced end-to-end, only writes are landing
// (but no worker enforces), or the capability is disabled at this team.
// -----------------------------------------------------------------------------

export const LIFECYCLE_CAPABILITY_STATUSES = [
  'FULLY_OPERATIONAL',
  'READ_ONLY',
  'CONFIGURATION_ONLY',
  'WRITES_BUT_NOT_ENFORCED',
  'DISABLED',
] as const;

export type LifecycleCapabilityStatus =
  (typeof LIFECYCLE_CAPABILITY_STATUSES)[number];

export type LifecycleCapabilityState = {
  status: LifecycleCapabilityStatus;
  reason?: string;
};

export type LifecycleDashboardCapabilities = {
  retention: LifecycleCapabilityState;
  legalHolds: LifecycleCapabilityState;
  archive: LifecycleCapabilityState;
  destruction: LifecycleCapabilityState;
  webhooks: LifecycleCapabilityState;
  chainTransfers: LifecycleCapabilityState;
};

// -----------------------------------------------------------------------------
// Manifest Entries (Verification Package)
// -----------------------------------------------------------------------------

export type LifecycleManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  teamId: string;
  totalPolicies: number;
  totalLegalHolds: number;
  totalArchiveTransitions: number;
  totalDestructionRequests: number;
};

export type RetentionManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  policyId: string;
  policyName: string;
  template: RetentionPolicyTemplate;
  years: number;
  appliesTo: string;
  isOverride: boolean;
};

export type LegalHoldManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  holdId: string;
  kind: LegalHoldKind;
  state: LegalHoldState;
  scopeTargetId?: string | null;
  createdAt: string;
  releasedAtUtc?: string | null;
};

export type ArchiveManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  evidenceId: string;
  fromTier: ArchiveTier;
  toTier: ArchiveTier;
  transitionedAtUtc: string;
  costEstimateUsdMicros: number;
};

export type DestructionManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  requestId: string;
  state: DestructionState;
  evidenceCount: number;
  certifiedAtUtc?: string | null;
  certificateHash?: string | null;
};

export type ExchangeManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  packageId: string;
  kind: ExchangePackageKind;
  state: ExchangePackageState;
  evidenceCount: number;
  packageSha256?: string | null;
  createdAt: string;
};

export type TransferManifestEntry = {
  schemaVersion: string;
  generatedAtUtc: string;
  transferId: string;
  fromOrganizationId: string;
  toOrganizationSlug: string;
  state: ChainTransferState;
  evidenceCount: number;
  createdAt: string;
  completedAtUtc?: string | null;
};

// -----------------------------------------------------------------------------
// Standing Limitations
// -----------------------------------------------------------------------------

export const PRODUCT_AND_LIFECYCLE_LIMITATIONS = [
  'ENTITLEMENTS_ENFORCED_SERVER_SIDE',
  'CHAIN_TRANSFER_REQUIRES_ACCEPTANCE_BY_RECIPIENT_ORG',
  'LEGAL_HOLD_BLOCKS_DELETE_AND_DESTROY_UNTIL_RELEASED',
  'ARCHIVE_TIER_TRANSITIONS_ARE_AUDIT_LOGGED',
  'DESTRUCTION_REQUIRES_DUAL_APPROVAL_BY_DEFAULT',
  'DESTRUCTION_CERTIFICATE_IS_IMMUTABLE_AND_SIGNED',
  'WEBHOOK_DELIVERY_IS_AT_LEAST_ONCE_WITH_BOUNDED_RETRIES',
  'EVIDENCE_EXPORT_PACKAGES_ARE_SIGNED_AND_TIME_LIMITED',
] as const;

export type ProductAndLifecycleLimitation = (typeof PRODUCT_AND_LIFECYCLE_LIMITATIONS)[number];
