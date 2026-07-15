/**
 * Canonical operational-eligibility derivation (2026-07-15).
 *
 * PURE function so the participation/role/capability rules are runtime-
 * unit-testable without a live envelope or DB. The service supplies the
 * already-authorized inputs (reused envelope data + two tenant-scoped
 * existence checks); this file owns the RULES that turn them into the
 * `PlatformContextOperationalEligibility` projection.
 *
 * It is NOT authorization — the inbox aggregation still enforces every
 * data decision by per-source membership/role scoping. This projection
 * controls UI relevance only, and is combined on the client with the
 * aggregation's actual-item signal (an authorized item can always reveal
 * its category).
 */

import type {
  CapabilityMap,
  PlatformContextOperationalEligibility,
  WorkspaceRole,
} from "./types.js";

export type OperationalEligibilityInput = {
  /** Resolved capability map for the ACTIVE workspace. */
  capabilities: Pick<CapabilityMap, "REVIEWER_OPS_ACT" | "GOVERNANCE_VIEW">;
  /** Active workspace role (drives review-oversight/adjudication). */
  activeRole: WorkspaceRole | null;
  /** Active-workspace admin (OWNER/ADMIN). */
  isActiveAdmin: boolean;
  /** ACTIVE organization memberships (non-personal). */
  organizations: ReadonlyArray<{
    membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
    role: WorkspaceRole | null;
  }>;
  /** Active member of ≥1 collaboration team (tenant-scoped count > 0). */
  collaborationMemberActive: boolean;
  /** A still-actionable incoming invitation exists (org or collaboration). */
  hasPendingInvitation: boolean;
  /** Canonical plan feature flags (own-workflow gates). */
  planFeatures: {
    intakeIncluded: boolean;
    casesIncluded: boolean;
    teamCollaborationIncluded: boolean;
  };
};

export function deriveOperationalEligibility(
  input: OperationalEligibilityInput,
): PlatformContextOperationalEligibility {
  const activeOrgs = input.organizations.filter(
    (o) => o.membershipStatus === "ACTIVE",
  );
  const activeOrgAdmin = activeOrgs.some(
    (o) => o.role === "OWNER" || o.role === "ADMIN",
  );
  const activeOrgMembership = activeOrgs.length > 0;
  const hasActiveMembership =
    activeOrgMembership || input.collaborationMemberActive;

  // Reviewer participation reuses the resolved capability (REVIEWER_OPS_ACT
  // is granted to WRITERS in a review-capable workspace — excludes VIEWER
  // and non-review scopes). No invented reviewer role.
  const reviewsCanParticipate = input.capabilities.REVIEWER_OPS_ACT === true;
  const reviewsCanManage = reviewsCanParticipate && input.isActiveAdmin === true;

  return {
    collaboration: {
      hasActiveMembership,
      hasPendingInvitation: input.hasPendingInvitation,
      canOwnTeams: input.planFeatures.teamCollaborationIncluded,
    },
    reviews: {
      canParticipate: reviewsCanParticipate,
      canManage: reviewsCanManage,
    },
    assignments: {
      hasCaseAssignmentCapability: input.planFeatures.casesIncluded,
      hasReviewAssignmentCapability: reviewsCanParticipate,
      hasCollaborationAssignmentCapability: hasActiveMembership,
    },
    deadlines: {
      // Deadline-producing sources: intake (3 categories), personal cases,
      // review SLAs, and access reviews (org participation). A standalone
      // Free personal user reaches none → no permanent empty due filters.
      hasEligibleSource:
        input.planFeatures.intakeIncluded ||
        input.planFeatures.casesIncluded ||
        reviewsCanParticipate ||
        hasActiveMembership,
    },
    security: {
      hasPersonalSurface: true,
      hasAdminSurface: activeOrgAdmin,
    },
    governance: {
      // Outcome B: GOVERNANCE_VIEW is not granted to Personal scope, so Pro
      // Personal is false (governance controls live in Settings, not an
      // Operations Center queue). A real personal-team governance item still
      // reveals the category client-side via the actual-item override.
      canViewOperational: input.capabilities.GOVERNANCE_VIEW === true,
    },
  };
}
