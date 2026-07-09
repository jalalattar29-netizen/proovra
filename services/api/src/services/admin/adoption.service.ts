/**
 * Platform Control Center — Feature Usage / Adoption aggregate (item H).
 *
 * READ-ONLY, GLOBAL, cross-tenant aggregation. Adoption is DERIVED from real
 * entity counts — there is NO explicit "adoption model" in the schema, and this
 * service does NOT invent one. There is deliberately NO composite / weighted
 * "adoption score" — a fabricated single number would be dishonest. Each
 * capability is reported independently from its REAL backing table.
 *
 * HONESTY CONTRACT
 * ================
 * For every capability we report ONLY what is genuinely derivable from the
 * schema:
 *   - enabled       count of orgs/teams (or rows) that have the capability
 *                   configured/active. null when "enabled" is not a meaningful
 *                   distinct concept for that capability.
 *   - used          whether the capability has ever produced real rows.
 *   - neverUsed     true when used === false (i.e. usageCount === 0). null when
 *                   usage is not measured.
 *   - firstUsedAt   earliest real row timestamp, or null.
 *   - lastUsedAt    latest real row timestamp, or null.
 *   - usageCount    real COUNT of backing rows, or null when not measured.
 *   - measured      false ONLY when the capability has no clear backing model;
 *                   then every metric is null and `reason` explains why.
 *   - reason        populated ONLY when measured === false.
 *
 * Capabilities with NO clear backing model (redaction, in-product search) are
 * returned with measured=false and every metric null — never faked.
 *
 * This service performs ZERO writes. It issues only count/aggregate/findFirst
 * reads over EXISTING tables.
 */

import { prisma } from "../../db.js";

export type CapabilityKey =
  | "sso"
  | "scim"
  | "domainsVerified"
  | "mfaPolicy"
  | "mfaEnrollment"
  | "legalHold"
  | "retentionPolicy"
  | "evidenceCaptured"
  | "casesUsed"
  | "reportsGenerated"
  | "packagesGenerated"
  | "externalReviewer"
  | "apiIntegrations"
  | "aiUsed"
  | "reviewQueues"
  | "redaction"
  | "search";

export type CapabilityAdoption = {
  key: CapabilityKey;
  /** Operator-readable capability label. */
  label: string;
  /**
   * How the numbers were derived (which real table + which predicate). Kept
   * short + honest so an operator can audit the claim.
   */
  source: string;
  /**
   * Count of orgs/teams/rows with the capability enabled/configured/active.
   * null when "enabled" is not a distinct concept for this capability.
   */
  enabled: number | null;
  /** Whether the capability has ever produced real rows. null when not measured. */
  used: boolean | null;
  /** true when usageCount === 0. null when not measured. */
  neverUsed: boolean | null;
  /** Earliest real row timestamp (ISO), or null. */
  firstUsedAt: string | null;
  /** Latest real row timestamp (ISO), or null. */
  lastUsedAt: string | null;
  /** Real COUNT of backing rows, or null when not measured. */
  usageCount: number | null;
  /** false ONLY when there is no clear backing model. */
  measured: boolean;
  /** Populated ONLY when measured === false. */
  reason: string | null;
};

export type AdoptionReport = {
  generatedAt: string;
  /**
   * Explicit honesty flag consumed by the UI + contract test. There is NO
   * composite adoption score by design.
   */
  hasCompositeScore: false;
  capabilities: CapabilityAdoption[];
};

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Build a "measured" capability from a real usageCount + optional first/last
 * timestamps + optional enabled count. Derives used / neverUsed honestly.
 */
function measured(input: {
  key: CapabilityKey;
  label: string;
  source: string;
  enabled: number | null;
  usageCount: number;
  firstUsedAt: Date | null;
  lastUsedAt: Date | null;
}): CapabilityAdoption {
  return {
    key: input.key,
    label: input.label,
    source: input.source,
    enabled: input.enabled,
    used: input.usageCount > 0,
    neverUsed: input.usageCount === 0,
    firstUsedAt: iso(input.firstUsedAt),
    lastUsedAt: iso(input.lastUsedAt),
    usageCount: input.usageCount,
    measured: true,
    reason: null,
  };
}

/** Build a "not measured" capability — every metric honestly null. */
function notMeasured(input: {
  key: CapabilityKey;
  label: string;
  source: string;
  reason: string;
}): CapabilityAdoption {
  return {
    key: input.key,
    label: input.label,
    source: input.source,
    enabled: null,
    used: null,
    neverUsed: null,
    firstUsedAt: null,
    lastUsedAt: null,
    usageCount: null,
    measured: false,
    reason: input.reason,
  };
}

/**
 * Compute the platform-wide adoption report from REAL entity counts.
 *
 * Every branch reads an EXISTING table. No writes. No fabricated numbers. The
 * `firstUsedAt` / `lastUsedAt` come from the min/max of the real timestamp
 * column on each backing table.
 */
export async function computeAdoptionReport(): Promise<AdoptionReport> {
  const [
    // --- SSO (SsoConnection status ACTIVE) -----------------------------------
    ssoActiveTeams,
    ssoUsage,
    // --- SCIM (ScimProvisioningToken status ACTIVE) --------------------------
    scimActiveTeams,
    scimUsage,
    // --- Domains verified (OrganizationDomain verifiedAt not null) -----------
    domainsVerifiedOrgs,
    domainsUsage,
    // --- MFA policy (Team.mfaPolicyLevel != OFF) -----------------------------
    mfaPolicyTeams,
    // --- MFA enrollment (MfaFactor status ACTIVE) ----------------------------
    mfaEnrolledUsers,
    mfaEnrolledUsage,
    // --- Legal hold (EvidenceLegalHold) --------------------------------------
    legalHoldUsage,
    // --- Retention policy (EvidenceRetentionPolicy) --------------------------
    retentionUsage,
    // --- Evidence captured (Evidence) ----------------------------------------
    evidenceUsage,
    // --- Cases used (Case) ---------------------------------------------------
    caseUsage,
    // --- Reports generated (Report) ------------------------------------------
    reportUsage,
    // --- Packages generated (VerificationPackage) ----------------------------
    packageUsage,
    // --- External reviewer (ExternalReviewerRoleAssignment) ------------------
    externalReviewerUsage,
    // --- API keys / integrations (ApiCredential status ACTIVE) ---------------
    apiActiveTeams,
    apiUsage,
    // --- AI used (ProviderUsageEvent) ----------------------------------------
    aiUsage,
    // --- Review queues (EvidenceReviewWorkflow) ------------------------------
    reviewQueueUsage,
  ] = await Promise.all([
    prisma.ssoConnection.findMany({
      where: { status: "ACTIVE" },
      distinct: ["teamId"],
      select: { teamId: true },
    }),
    prisma.ssoConnection.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.scimProvisioningToken.findMany({
      where: { status: "ACTIVE" },
      distinct: ["teamId"],
      select: { teamId: true },
    }),
    prisma.scimProvisioningToken.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.organizationDomain.findMany({
      where: { verifiedAt: { not: null } },
      distinct: ["organizationId"],
      select: { organizationId: true },
    }),
    prisma.organizationDomain.aggregate({
      where: { verifiedAt: { not: null } },
      _count: { _all: true },
      _min: { verifiedAt: true },
      _max: { verifiedAt: true },
    }),
    // MFA policy is a real OrganizationSecurityPolicy column (mfaPolicyLevel,
    // keyed by teamId, default "OFF"). Non-OFF = an enforced policy exists.
    prisma.organizationSecurityPolicy.count({
      where: { mfaPolicyLevel: { not: "OFF" } },
    }),
    prisma.mfaFactor.findMany({
      where: { status: "ACTIVE" },
      distinct: ["userId"],
      select: { userId: true },
    }),
    prisma.mfaFactor.aggregate({
      where: { status: "ACTIVE" },
      _count: { _all: true },
      _min: { enrolledAt: true },
      _max: { enrolledAt: true },
    }),
    prisma.evidenceLegalHold.aggregate({
      _count: { _all: true },
      _min: { placedAtUtc: true },
      _max: { placedAtUtc: true },
    }),
    prisma.evidenceRetentionPolicy.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.evidence.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.case.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    // Report has no createdAt; generatedAtUtc is the real creation timestamp.
    prisma.report.aggregate({
      _count: { _all: true },
      _min: { generatedAtUtc: true },
      _max: { generatedAtUtc: true },
    }),
    prisma.verificationPackage.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.externalReviewerRoleAssignment.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.apiCredential.findMany({
      where: { status: "ACTIVE" },
      distinct: ["teamId"],
      select: { teamId: true },
    }),
    prisma.apiCredential.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
    prisma.providerUsageEvent.aggregate({
      _count: { _all: true },
      _min: { occurredAtUtc: true },
      _max: { occurredAtUtc: true },
    }),
    prisma.evidenceReviewWorkflow.aggregate({
      _count: { _all: true },
      _min: { createdAt: true },
      _max: { createdAt: true },
    }),
  ]);

  const capabilities: CapabilityAdoption[] = [
    measured({
      key: "sso",
      label: "SSO (single sign-on)",
      source: "SsoConnection · status=ACTIVE (enabled = distinct teams)",
      enabled: ssoActiveTeams.length,
      usageCount: ssoUsage._count._all,
      firstUsedAt: ssoUsage._min.createdAt,
      lastUsedAt: ssoUsage._max.createdAt,
    }),
    measured({
      key: "scim",
      label: "SCIM provisioning",
      source: "ScimProvisioningToken · status=ACTIVE (enabled = distinct teams)",
      enabled: scimActiveTeams.length,
      usageCount: scimUsage._count._all,
      firstUsedAt: scimUsage._min.createdAt,
      lastUsedAt: scimUsage._max.createdAt,
    }),
    measured({
      key: "domainsVerified",
      label: "Verified domains",
      source:
        "OrganizationDomain · verifiedAt not null (enabled = distinct orgs)",
      enabled: domainsVerifiedOrgs.length,
      usageCount: domainsUsage._count._all,
      firstUsedAt: domainsUsage._min.verifiedAt,
      lastUsedAt: domainsUsage._max.verifiedAt,
    }),
    // MFA policy: enabled = teams with a non-OFF policy. There is no per-policy
    // "usage" timestamp on the Team row, so usage timing is not derivable — we
    // report enabled honestly and leave first/last null (usageCount == enabled).
    {
      key: "mfaPolicy",
      label: "MFA policy enforced",
      source: "Team.mfaPolicyLevel != OFF (enabled = teams with a policy)",
      enabled: mfaPolicyTeams,
      used: mfaPolicyTeams > 0,
      neverUsed: mfaPolicyTeams === 0,
      firstUsedAt: null,
      lastUsedAt: null,
      usageCount: mfaPolicyTeams,
      measured: true,
      reason: null,
    },
    measured({
      key: "mfaEnrollment",
      label: "MFA factors enrolled",
      source: "MfaFactor · status=ACTIVE (enabled = distinct users enrolled)",
      enabled: mfaEnrolledUsers.length,
      usageCount: mfaEnrolledUsage._count._all,
      firstUsedAt: mfaEnrolledUsage._min.enrolledAt,
      lastUsedAt: mfaEnrolledUsage._max.enrolledAt,
    }),
    measured({
      key: "legalHold",
      label: "Legal hold",
      source: "EvidenceLegalHold (all rows)",
      enabled: null,
      usageCount: legalHoldUsage._count._all,
      firstUsedAt: legalHoldUsage._min.placedAtUtc,
      lastUsedAt: legalHoldUsage._max.placedAtUtc,
    }),
    measured({
      key: "retentionPolicy",
      label: "Retention policy configured",
      source: "EvidenceRetentionPolicy (all rows)",
      enabled: null,
      usageCount: retentionUsage._count._all,
      firstUsedAt: retentionUsage._min.createdAt,
      lastUsedAt: retentionUsage._max.createdAt,
    }),
    measured({
      key: "evidenceCaptured",
      label: "Evidence captured",
      source: "Evidence (all rows)",
      enabled: null,
      usageCount: evidenceUsage._count._all,
      firstUsedAt: evidenceUsage._min.createdAt,
      lastUsedAt: evidenceUsage._max.createdAt,
    }),
    measured({
      key: "casesUsed",
      label: "Cases used",
      source: "Case (all rows)",
      enabled: null,
      usageCount: caseUsage._count._all,
      firstUsedAt: caseUsage._min.createdAt,
      lastUsedAt: caseUsage._max.createdAt,
    }),
    measured({
      key: "reportsGenerated",
      label: "Reports generated",
      source: "Report (all rows)",
      enabled: null,
      usageCount: reportUsage._count._all,
      firstUsedAt: reportUsage._min.generatedAtUtc,
      lastUsedAt: reportUsage._max.generatedAtUtc,
    }),
    measured({
      key: "packagesGenerated",
      label: "Verification packages generated",
      source: "VerificationPackage (all rows)",
      enabled: null,
      usageCount: packageUsage._count._all,
      firstUsedAt: packageUsage._min.createdAt,
      lastUsedAt: packageUsage._max.createdAt,
    }),
    measured({
      key: "externalReviewer",
      label: "External reviewer",
      source: "ExternalReviewerRoleAssignment (all rows)",
      enabled: null,
      usageCount: externalReviewerUsage._count._all,
      firstUsedAt: externalReviewerUsage._min.createdAt,
      lastUsedAt: externalReviewerUsage._max.createdAt,
    }),
    measured({
      key: "apiIntegrations",
      label: "API keys / integrations",
      source: "ApiCredential · status=ACTIVE (enabled = distinct teams)",
      enabled: apiActiveTeams.length,
      usageCount: apiUsage._count._all,
      firstUsedAt: apiUsage._min.createdAt,
      lastUsedAt: apiUsage._max.createdAt,
    }),
    measured({
      key: "aiUsed",
      label: "AI / intelligence used",
      source: "ProviderUsageEvent (all rows)",
      enabled: null,
      usageCount: aiUsage._count._all,
      firstUsedAt: aiUsage._min.occurredAtUtc,
      lastUsedAt: aiUsage._max.occurredAtUtc,
    }),
    measured({
      key: "reviewQueues",
      label: "Review queues / workflows",
      source: "EvidenceReviewWorkflow (all rows)",
      enabled: null,
      usageCount: reviewQueueUsage._count._all,
      firstUsedAt: reviewQueueUsage._min.createdAt,
      lastUsedAt: reviewQueueUsage._max.createdAt,
    }),
    // --- Capabilities with NO clear backing model — honestly not measured ----
    notMeasured({
      key: "redaction",
      label: "Redaction",
      source: "No dedicated redaction-usage table in the schema",
      reason:
        "Not measured — there is no dedicated redaction model whose row count would honestly represent redaction adoption.",
    }),
    notMeasured({
      key: "search",
      label: "In-product search",
      source: "No search-usage / query-log table in the schema",
      reason:
        "Not measured — search is not persisted to a queryable usage table, so adoption cannot be derived without fabricating it.",
    }),
  ];

  return {
    generatedAt: new Date().toISOString(),
    hasCompositeScore: false,
    capabilities,
  };
}
