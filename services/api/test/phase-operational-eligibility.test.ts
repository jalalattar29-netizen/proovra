/**
 * Operational-eligibility derivation — RUNTIME behavior across the real
 * persona matrix (2026-07-15). Exercises the pure canonical projection
 * (`deriveOperationalEligibility`) that the platform-context envelope
 * serializes, so the participation/role/capability rules are proven by
 * execution, not source grep.
 */

import { describe, it, expect } from "vitest";

import { deriveOperationalEligibility } from "../src/services/platform-context/operational-eligibility.js";

type Caps = { REVIEWER_OPS_ACT: boolean; GOVERNANCE_VIEW: boolean };

function input(over: {
  caps?: Partial<Caps>;
  activeRole?: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  isActiveAdmin?: boolean;
  organizations?: Array<{
    membershipStatus: "ACTIVE" | "PENDING" | "INACTIVE";
    role: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
  }>;
  collaborationMemberActive?: boolean;
  hasPendingInvitation?: boolean;
  plan?: Partial<{
    intakeIncluded: boolean;
    casesIncluded: boolean;
    teamCollaborationIncluded: boolean;
  }>;
}) {
  return {
    capabilities: {
      REVIEWER_OPS_ACT: false,
      GOVERNANCE_VIEW: false,
      ...over.caps,
    },
    activeRole: over.activeRole ?? null,
    isActiveAdmin: over.isActiveAdmin ?? false,
    organizations: over.organizations ?? [],
    collaborationMemberActive: over.collaborationMemberActive ?? false,
    hasPendingInvitation: over.hasPendingInvitation ?? false,
    planFeatures: {
      intakeIncluded: false,
      casesIncluded: false,
      teamCollaborationIncluded: false,
      ...over.plan,
    },
  };
}

describe("deriveOperationalEligibility — collaboration participation (§1)", () => {
  it("FREE standalone: no membership, no invite, no ownership", () => {
    const e = deriveOperationalEligibility(input({}));
    expect(e.collaboration.hasActiveMembership).toBe(false);
    expect(e.collaboration.hasPendingInvitation).toBe(false);
    expect(e.collaboration.canOwnTeams).toBe(false);
    expect(e.assignments.hasCollaborationAssignmentCapability).toBe(false);
  });

  it("active collaboration-team member: membership true", () => {
    const e = deriveOperationalEligibility(
      input({ collaborationMemberActive: true }),
    );
    expect(e.collaboration.hasActiveMembership).toBe(true);
    expect(e.assignments.hasCollaborationAssignmentCapability).toBe(true);
    expect(e.deadlines.hasEligibleSource).toBe(true); // membership → access reviews
  });

  it("active ORG member (non-personal): membership true", () => {
    const e = deriveOperationalEligibility(
      input({ organizations: [{ membershipStatus: "ACTIVE", role: "MEMBER" }] }),
    );
    expect(e.collaboration.hasActiveMembership).toBe(true);
  });

  it("PENDING org membership does NOT count as active", () => {
    const e = deriveOperationalEligibility(
      input({ organizations: [{ membershipStatus: "PENDING", role: "MEMBER" }] }),
    );
    expect(e.collaboration.hasActiveMembership).toBe(false);
  });

  it("pending invitation surfaces without membership", () => {
    const e = deriveOperationalEligibility(input({ hasPendingInvitation: true }));
    expect(e.collaboration.hasPendingInvitation).toBe(true);
    expect(e.collaboration.hasActiveMembership).toBe(false);
  });
});

describe("deriveOperationalEligibility — reviewer (§2)", () => {
  it("no REVIEWER_OPS_ACT capability: cannot participate or manage", () => {
    const e = deriveOperationalEligibility(input({}));
    expect(e.reviews.canParticipate).toBe(false);
    expect(e.reviews.canManage).toBe(false);
    expect(e.assignments.hasReviewAssignmentCapability).toBe(false);
  });

  it("REVIEWER_OPS_ACT writer: participates, but only manages when admin", () => {
    const member = deriveOperationalEligibility(
      input({ caps: { REVIEWER_OPS_ACT: true }, isActiveAdmin: false }),
    );
    expect(member.reviews.canParticipate).toBe(true);
    expect(member.reviews.canManage).toBe(false);

    const admin = deriveOperationalEligibility(
      input({ caps: { REVIEWER_OPS_ACT: true }, isActiveAdmin: true }),
    );
    expect(admin.reviews.canParticipate).toBe(true);
    expect(admin.reviews.canManage).toBe(true);
  });
});

describe("deriveOperationalEligibility — assignments (§3)", () => {
  it("casesIncluded plan grants case-assignment capability", () => {
    const e = deriveOperationalEligibility(input({ plan: { casesIncluded: true } }));
    expect(e.assignments.hasCaseAssignmentCapability).toBe(true);
  });

  it("standalone no-plan user has no assignment source", () => {
    const e = deriveOperationalEligibility(input({}));
    expect(e.assignments.hasCaseAssignmentCapability).toBe(false);
    expect(e.assignments.hasReviewAssignmentCapability).toBe(false);
    expect(e.assignments.hasCollaborationAssignmentCapability).toBe(false);
  });
});

describe("deriveOperationalEligibility — deadlines (§4)", () => {
  it("no eligible source for a standalone Free user", () => {
    expect(deriveOperationalEligibility(input({})).deadlines.hasEligibleSource).toBe(
      false,
    );
  });
  it("intake plan is an eligible deadline source", () => {
    expect(
      deriveOperationalEligibility(input({ plan: { intakeIncluded: true } }))
        .deadlines.hasEligibleSource,
    ).toBe(true);
  });
  it("cases plan is an eligible deadline source", () => {
    expect(
      deriveOperationalEligibility(input({ plan: { casesIncluded: true } }))
        .deadlines.hasEligibleSource,
    ).toBe(true);
  });
});

describe("deriveOperationalEligibility — security separation (§5)", () => {
  it("personal security surface is universal", () => {
    expect(deriveOperationalEligibility(input({})).security.hasPersonalSurface).toBe(
      true,
    );
  });
  it("admin security surface requires org OWNER/ADMIN", () => {
    const member = deriveOperationalEligibility(
      input({ organizations: [{ membershipStatus: "ACTIVE", role: "MEMBER" }] }),
    );
    expect(member.security.hasAdminSurface).toBe(false);
    const admin = deriveOperationalEligibility(
      input({ organizations: [{ membershipStatus: "ACTIVE", role: "ADMIN" }] }),
    );
    expect(admin.security.hasAdminSurface).toBe(true);
  });
});

describe("deriveOperationalEligibility — Pro personal governance (§6, Outcome B)", () => {
  it("no GOVERNANCE_VIEW capability → no operational governance queue (Pro Personal)", () => {
    const proPersonal = deriveOperationalEligibility(
      input({ caps: { GOVERNANCE_VIEW: false }, plan: { casesIncluded: true } }),
    );
    expect(proPersonal.governance.canViewOperational).toBe(false);
  });
  it("GOVERNANCE_VIEW capability → operational governance queue", () => {
    const orgMember = deriveOperationalEligibility(
      input({ caps: { GOVERNANCE_VIEW: true } }),
    );
    expect(orgMember.governance.canViewOperational).toBe(true);
  });
});
