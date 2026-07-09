/**
 * Platform Control Center — Customer Lifecycle (item B/C/F) contract.
 *
 * Locks the PURE lifecycle derivation and the honest not-modelled fields:
 *
 *   1. deriveCustomerLifecycle returns the correct stage for representative
 *      inputs across the full precedence ladder (terminal → risk → active →
 *      onboarding → provisioned → lead).
 *   2. It returns UNKNOWN — never a fabricated ACTIVE — when the signals
 *      cannot prove a stage.
 *   3. LIFECYCLE_STAGES enumerates exactly the union members.
 *   4. In the org detail, the not-modelled fields (accountManager /
 *      supportContact / renewalDate / supportTickets / onboardingCompletion)
 *      are null, and the customerSuccess/workspaces/lifecycle blocks exist.
 *
 * DB-free: pure function calls + the same in-memory prisma double shape the
 * sibling admin-organizations suite uses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/security/sso-health.service.js", () => ({
  buildSsoHealthSnapshot: vi.fn(async ({ teamId }: { teamId: string }) => ({
    teamId,
    generatedAtUtc: new Date().toISOString(),
    overallStatus: "HEALTHY",
    connections: [],
  })),
}));
vi.mock("../src/db.js", () => ({ prisma: {} }));

import {
  deriveCustomerLifecycle,
  LIFECYCLE_STAGES,
  type LifecycleStage,
} from "../src/services/admin/customer-lifecycle.js";
import { getAdminOrganizationDetail } from "../src/services/organization/admin-organizations.service.js";

// ---------------------------------------------------------------------------
// Pure derivation.
// ---------------------------------------------------------------------------

describe("deriveCustomerLifecycle", () => {
  it("enumerates exactly the eleven stages", () => {
    expect([...LIFECYCLE_STAGES].sort()).toEqual(
      [
        "ACTIVE",
        "ARCHIVED",
        "AT_RISK",
        "CANCELLED",
        "CONTACT_SALES",
        "DEMO_REQUESTED",
        "LEAD",
        "ONBOARDING",
        "PROVISIONED",
        "SUSPENDED",
        "UNKNOWN",
      ].sort(),
    );
  });

  it("ARCHIVED wins from Organization.status", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ARCHIVED",
      billingStatus: "ACTIVE",
      hasEvidenceActivity: true,
    });
    expect(r.stage).toBe("ARCHIVED");
    expect(r.reasons.join(" ")).toMatch(/ARCHIVED/i);
  });

  it("SUSPENDED wins from Organization.status", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "SUSPENDED",
      billingStatus: "ACTIVE",
      hasEvidenceActivity: true,
    });
    expect(r.stage).toBe("SUSPENDED");
  });

  it("CANCELLED from billingStatus CANCELED", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      billingStatus: "CANCELED",
    });
    expect(r.stage).toBe("CANCELLED");
  });

  it("CANCELLED from billingCanceledAt even with no CANCELED status", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      billingStatus: "INACTIVE",
      billingCanceledAt: new Date(),
    });
    expect(r.stage).toBe("CANCELLED");
  });

  it("AT_RISK from PAST_DUE", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      billingStatus: "PAST_DUE",
      hasEvidenceActivity: true,
    });
    expect(r.stage).toBe("AT_RISK");
  });

  it("AT_RISK from an SSO outage even when billing is ACTIVE", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      billingStatus: "ACTIVE",
      hasEvidenceActivity: true,
      ssoOutage: true,
    });
    expect(r.stage).toBe("AT_RISK");
  });

  it("AT_RISK from a recent failed payment", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      billingStatus: "ACTIVE",
      hasEvidenceActivity: true,
      recentFailedPayment: true,
    });
    expect(r.stage).toBe("AT_RISK");
  });

  it("ACTIVE requires healthy billing AND evidence activity", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      hasWorkspace: true,
      onPaidPlan: true,
      billingStatus: "ACTIVE",
      hasEvidenceActivity: true,
    });
    expect(r.stage).toBe("ACTIVE");
  });

  it("ONBOARDING when activated but no first evidence yet", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      hasWorkspace: true,
      onPaidPlan: true,
      billingStatus: "ACTIVE",
      hasEvidenceActivity: false,
    });
    expect(r.stage).toBe("ONBOARDING");
  });

  it("PROVISIONED when org+workspace on a paid plan with no activation/activity", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      hasWorkspace: true,
      onPaidPlan: true,
      billingStatus: "INACTIVE",
      hasEvidenceActivity: false,
    });
    expect(r.stage).toBe("PROVISIONED");
  });

  it("CONTACT_SALES / DEMO_REQUESTED / LEAD when only a lead exists (no org)", () => {
    expect(
      deriveCustomerLifecycle({
        hasOrganization: false,
        hasContactSalesRequest: true,
      }).stage,
    ).toBe("CONTACT_SALES");
    expect(
      deriveCustomerLifecycle({
        hasOrganization: false,
        hasDemoRequest: true,
      }).stage,
    ).toBe("DEMO_REQUESTED");
    expect(
      deriveCustomerLifecycle({
        hasOrganization: false,
        hasDemoRequest: false,
        hasContactSalesRequest: false,
      }).stage,
    ).toBe("LEAD");
  });

  it("returns UNKNOWN (NOT a fabricated ACTIVE) when nothing is provable", () => {
    const r = deriveCustomerLifecycle({
      hasOrganization: true,
      organizationStatus: "ACTIVE",
      hasWorkspace: false,
      onPaidPlan: false,
      billingStatus: null,
      hasEvidenceActivity: false,
    });
    expect(r.stage).toBe("UNKNOWN");
    expect(r.stage).not.toBe("ACTIVE");
    expect(r.reasons.join(" ")).toMatch(/not guessing ACTIVE/i);
  });

  it("every returned stage is a member of LIFECYCLE_STAGES", () => {
    const stages: LifecycleStage[] = [
      deriveCustomerLifecycle({}).stage,
      deriveCustomerLifecycle({ hasOrganization: true, organizationStatus: "ACTIVE", billingStatus: "ACTIVE", hasEvidenceActivity: true }).stage,
    ];
    for (const s of stages) expect(LIFECYCLE_STAGES).toContain(s);
  });
});

// ---------------------------------------------------------------------------
// Detail — not-modelled fields are null + new blocks are present.
// ---------------------------------------------------------------------------

function makeDetailClient() {
  const orgId = "org-a";
  const teams = [
    {
      id: "t1",
      organizationId: orgId,
      name: "Legal WS",
      billingPlan: "ENTERPRISE",
      billingStatus: "ACTIVE",
      billingActivatedAt: new Date("2026-02-01T00:00:00Z"),
      billingCanceledAt: null as Date | null,
      includedSeats: 10,
      members: 4,
      isPersonal: false,
    },
  ];
  return {
    organization: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === orgId
          ? {
              id: orgId,
              name: "Acme",
              legalName: null,
              status: "ACTIVE",
              createdAt: new Date("2026-01-01T00:00:00Z"),
              billingOwnerUserId: null,
            }
          : null,
      ),
    },
    team: {
      findMany: vi.fn(async () =>
        teams.map((t) => ({
          id: t.id,
          name: t.name,
          billingPlan: t.billingPlan,
          billingStatus: t.billingStatus,
          billingActivatedAt: t.billingActivatedAt,
          billingCanceledAt: t.billingCanceledAt,
          includedSeats: t.includedSeats,
          _count: { members: t.members },
        })),
      ),
    },
    organizationMembership: {
      findMany: vi.fn(async ({ where }: any) => {
        // owner+admin query filters by role.in; the member-ids query does not.
        if (where.role?.in) {
          return [
            {
              userId: "u1",
              role: "ORG_OWNER",
              createdAt: new Date(),
              user: { email: "owner@acme.test", displayName: "Owner" },
            },
          ];
        }
        return [{ userId: "u1" }, { userId: "u2" }];
      }),
    },
    organizationDomain: {
      findMany: vi.fn(async () => [
        { domain: "acme.test", verifiedAt: new Date("2026-01-15T00:00:00Z") },
      ]),
    },
    scimProvisioningToken: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
    },
    evidence: {
      count: vi.fn(async () => 3),
      findFirst: vi.fn(async ({ orderBy }: any) => ({
        createdAt:
          orderBy?.createdAt === "asc"
            ? new Date("2026-02-05T00:00:00Z")
            : new Date("2026-03-10T00:00:00Z"),
      })),
    },
    report: {
      count: vi.fn(async () => 2),
      findFirst: vi.fn(async () => ({ generatedAtUtc: new Date("2026-02-06T00:00:00Z") })),
    },
    verificationPackage: {
      count: vi.fn(async () => 1),
      findFirst: vi.fn(async () => ({ generatedAtUtc: new Date("2026-02-07T00:00:00Z") })),
    },
    analyticsEvent: {
      findFirst: vi.fn(async () => ({ createdAt: new Date("2026-03-11T00:00:00Z") })),
    },
    operationalIncident: { count: vi.fn(async () => 0) },
    ssoConnection: { count: vi.fn(async () => 0) },
    case: { count: vi.fn(async () => 5) },
    organizationPolicy: { count: vi.fn(async () => 0) },
    evidenceLegalHold: { count: vi.fn(async () => 0) },
    destructionRequest: { count: vi.fn(async () => 0) },
    subscription: { count: vi.fn(async () => 1) },
    payment: { count: vi.fn(async () => 0) },
    user: { findUnique: vi.fn(async () => null) },
    organizationAuditEvent: { findMany: vi.fn(async () => []) },
    adminAuditLog: { findMany: vi.fn(async () => []) },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getAdminOrganizationDetail — customerSuccess + workspaces + lifecycle", () => {
  it("not-modelled fields (accountManager/supportContact/renewalDate/supportTickets/onboardingCompletion) are null", async () => {
    const client = makeDetailClient();
    const d = await getAdminOrganizationDetail("org-a", client);
    expect(d.customerSuccess.accountManager).toBeNull();
    expect(d.customerSuccess.supportContact).toBeNull();
    expect(d.customerSuccess.renewalDate).toBeNull();
    expect(d.customerSuccess.supportTickets).toBeNull();
    expect(d.customerSuccess.onboardingCompletion).toBeNull();
    expect(d.customerSuccess.notModelled.length).toBeGreaterThan(0);
  });

  it("exposes REAL milestones and a derived ACTIVE lifecycle stage", async () => {
    const client = makeDetailClient();
    const d = await getAdminOrganizationDetail("org-a", client);
    expect(d.lifecycle.stage).toBe("ACTIVE");
    expect(d.customerSuccess.firstEvidenceAt).toBe("2026-02-05T00:00:00.000Z");
    expect(d.customerSuccess.firstReportAt).toBe("2026-02-06T00:00:00.000Z");
    expect(d.customerSuccess.firstPackageAt).toBe("2026-02-07T00:00:00.000Z");
    expect(d.customerSuccess.lastLoginAt).toBe("2026-03-11T00:00:00.000Z");
    expect(d.customerSuccess.ssoConfigured).toBe(false);
    expect(d.customerSuccess.domainVerified).toBe(true);
  });

  it("emits the Platform Map: one workspace with real counts", async () => {
    const client = makeDetailClient();
    const d = await getAdminOrganizationDetail("org-a", client);
    expect(d.workspaces).toHaveLength(1);
    const ws = d.workspaces[0]!;
    expect(ws.name).toBe("Legal WS");
    expect(ws.memberCount).toBe(4);
    expect(ws.caseCount).toBe(5);
    expect(ws.evidenceCount).toBe(3);
    expect(ws.reportCount).toBe(2);
    expect(ws.packageCount).toBe(1);
    expect(ws.health).toBe("HEALTHY");
  });
});
