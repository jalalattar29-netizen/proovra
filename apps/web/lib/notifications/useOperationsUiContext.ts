"use client";

/**
 * ONE canonical UI-context resolver for the Operations Center and
 * Notification Preferences surfaces.
 *
 * A THIN projection of the existing platform-context envelope — no new
 * role system, no fetches, no label- or plan-name-derived permissions.
 * It controls UI RELEVANCE only; every data decision stays backend-
 * enforced (creation gates + aggregation recipient scoping + the
 * preference/policy routes 403 on their own).
 *
 * ENTITLEMENT + PARTICIPATION AWARENESS (2026-07-15): the flags project
 * from `envelope.operationalEligibility` (backend-derived from plan +
 * workspace type + real role/capability + real participation) and
 * `envelope.planFeatures` (canonical PLAN_CAPABILITIES for the pure
 * plan-gated own-workflow surfaces — reports / packages / intake). The
 * frontend never imports the billing package nor duplicates commercial
 * numbers, and never reconstructs participation from untrusted labels —
 * there is one backend source of truth, consumed through the envelope.
 *
 * The resolver answers STATIC relevance ("can this user ever receive /
 * create this class"). It is combined in `operationsFilterPolicy` with
 * the aggregation's filter-independent `scopeSummary.byCategory`
 * actual-item signal, so an authorized item can always REVEAL its
 * category even when static relevance would hide it (an incoming Team
 * invitee, a downgraded user's historical assignment). Visibility of an
 * existing item is never the same as product ownership entitlement.
 *
 * Distinctions the model preserves:
 *   - PLAN-GATED own-workflow (reports/packages/intake): the plan
 *     includes the feature — its OWN items can only exist when included.
 *   - PARTICIPATION-GATED (collaboration/mentions/reviews/assignments):
 *     a real membership / capability / assignment must exist. Owning a
 *     plan that COULD collaborate is not enough — the user must actually
 *     participate (or hold a real incoming item).
 *   - ROLE-GATED (admin): OWNER/ADMIN of an organization.
 *   - CAPABILITY-GATED (governance): GOVERNANCE_VIEW. Pro Personal is
 *     FALSE (Outcome B — governance controls live in Settings, not an
 *     Operations Center queue).
 */

import { useCan } from "../platform-context";
import {
  useActiveSpace,
  useOrganizations,
  usePersonalSpace,
  usePlatformContext,
} from "../platform-context";
import type { PlatformContextOperationalEligibility } from "../platform-context/types";

export type OperationsUiContext = {
  /** Active space id (personal team id or organization workspace id). */
  workspaceId: string | null;
  isPersonalWorkspace: boolean;
  /** True when the user belongs to ≥1 ACTIVE organization workspace. */
  hasOrganizations: boolean;
  canViewAdminAttention: boolean;
  canReceiveGovernance: boolean;
  // Plan-gated own-workflow availability (pure plan — no participation
  // required to CREATE these; from canonical PLAN_CAPABILITIES).
  canUseReports: boolean;
  canUseVerificationPackages: boolean;
  canUseIntake: boolean;
  // Participation-aware relevance (real membership / capability / plan).
  /** Active member of ≥1 shared space (org OR collaboration team) — the
   *  precondition for mentions / collaboration / assigned threads. */
  canCollaborate: boolean;
  /** A still-actionable incoming invitation exists (org or collaboration). */
  hasPendingInvitation: boolean;
  /** Plan includes Collaboration Teams (maxCollaborationTeamsPerWorkspace > 0). */
  canOwnTeamCollaboration: boolean;
  /** Writer-level reviewer participation (REVIEWER_OPS_ACT) — not every
   *  Team/Enterprise member. */
  canParticipateInReviews: boolean;
  /** A valid assignment source can assign work (case / review / shared-space). */
  canReceiveAssignments: boolean;
  /** ≥1 deadline-producing workflow is reachable (intake / cases / reviews /
   *  shared-space participation). */
  hasEligibleDeadlineSource: boolean;
};

/** Envelope facts the pure derivation consumes. */
export type OperationsUiContextInput = {
  activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  activeSpaceId: string | null;
  personalSpaceId: string | null;
  organizations: ReadonlyArray<{
    membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  }>;
  /** Canonical capability-map verdict for GOVERNANCE_VIEW (degraded fallback). */
  hasGovernanceCapability: boolean;
  /** Pure plan feature flags from envelope.planFeatures (own-workflow gates). */
  planFeatures?: {
    reportsIncluded: boolean;
    verificationPackageIncluded: boolean;
    intakeIncluded: boolean;
    casesIncluded: boolean;
    reviewerOperationsIncluded: boolean;
    reviewQueuesIncluded: boolean;
    teamCollaborationIncluded: boolean;
  } | null;
  /** Backend-derived participation/role/capability eligibility. */
  operationalEligibility?: PlatformContextOperationalEligibility | null;
};

const NO_PLAN_FEATURES = {
  reportsIncluded: false,
  verificationPackageIncluded: false,
  intakeIncluded: false,
  casesIncluded: false,
  reviewerOperationsIncluded: false,
  reviewQueuesIncluded: false,
  teamCollaborationIncluded: false,
};

/**
 * Pure derivation — exported so behavior is unit-testable without a
 * rendered React tree.
 */
export function deriveOperationsUiContext(
  input: OperationsUiContextInput,
): OperationsUiContext {
  const activeOrgs = input.organizations.filter(
    (o) => o.membershipStatus === "ACTIVE",
  );
  const workspaceId = input.activeSpaceId ?? input.personalSpaceId ?? null;
  const isPersonalWorkspace = input.activeSpaceType
    ? input.activeSpaceType === "PERSONAL"
    : true;
  // Missing planFeatures (degraded envelope) → conservative FALSE: hide
  // plan-gated surfaces rather than overexpose.
  const pf = input.planFeatures ?? NO_PLAN_FEATURES;
  const elig = input.operationalEligibility ?? null;

  // Backend eligibility is authoritative when present. Its absence — the
  // envelope has not loaded, or a request failed — collapses
  // participation-gated surfaces to FALSE. This is a fail-closed safety
  // property, NOT backend-version compatibility: the API projects
  // `operationalEligibility` on every envelope build (Phase 12 Point 4,
  // Pass E). Universal + incoming categories are unaffected,
  // and a real item still reveals its category via the actual-item
  // override. Governance falls back to the capability verdict so it stays
  // correct even without the eligibility block.
  const canReceiveGovernance = elig
    ? elig.governance.canViewOperational
    : input.hasGovernanceCapability;
  // PHASE 12 POINT 4 PASS C5 — the server decides who has an admin surface.
  //
  // This used to fall back to `activeOrgs.some(role === OWNER || ADMIN)`: on
  // a missing projection the BROWSER decided admin visibility
  // from raw organization roles, which is exactly the client-side role
  // authority this pass removes — and it contradicted the file's own stated
  // posture two blocks above (missing projection → conservative FALSE).
  // Absence of the projection now hides the surface until the server answers.
  const canViewAdminAttention = elig ? elig.security.hasAdminSurface : false;
  const canCollaborate = elig?.collaboration.hasActiveMembership ?? false;
  const hasPendingInvitation = elig?.collaboration.hasPendingInvitation ?? false;
  const canOwnTeamCollaboration =
    elig?.collaboration.canOwnTeams ?? pf.teamCollaborationIncluded;
  const canParticipateInReviews = elig?.reviews.canParticipate ?? false;
  const canReceiveAssignments = elig
    ? elig.assignments.hasCaseAssignmentCapability ||
      elig.assignments.hasReviewAssignmentCapability ||
      elig.assignments.hasCollaborationAssignmentCapability
    : false;
  const hasEligibleDeadlineSource = elig?.deadlines.hasEligibleSource ?? false;

  return {
    workspaceId,
    isPersonalWorkspace,
    hasOrganizations: activeOrgs.length > 0,
    canViewAdminAttention,
    canReceiveGovernance,
    canUseReports: pf.reportsIncluded,
    canUseVerificationPackages: pf.verificationPackageIncluded,
    canUseIntake: pf.intakeIncluded,
    canCollaborate,
    hasPendingInvitation,
    canOwnTeamCollaboration,
    canParticipateInReviews,
    canReceiveAssignments,
    hasEligibleDeadlineSource,
  };
}

export function useOperationsUiContext(): OperationsUiContext {
  const activeSpace = useActiveSpace();
  const personalSpace = usePersonalSpace();
  const organizations = useOrganizations();
  const hasGovernanceCapability = useCan("GOVERNANCE_VIEW");
  const { envelope } = usePlatformContext();

  return deriveOperationsUiContext({
    activeSpaceType: activeSpace?.type ?? null,
    activeSpaceId: activeSpace?.id ?? null,
    personalSpaceId: personalSpace?.id ?? null,
    organizations,
    hasGovernanceCapability,
    planFeatures: envelope?.planFeatures ?? null,
    operationalEligibility: envelope?.operationalEligibility ?? null,
  });
}
