/**
 * Phase 2 Blocker 1 — brand-new-owner enterprise auto-completion.
 *
 * Unit-tests `completeEnterpriseProvisioningOnOwnerAccept`, the pure
 * transaction helper the org-invite accept route runs after the
 * ORG_OWNER membership is created. It is fully guarded so it is a no-op
 * for every non-enterprise accept.
 *
 * Positive: an ORG_OWNER accept for an org with pendingEnterpriseSeats=N
 * and ZERO workspaces mints an ENTERPRISE workspace owned by the
 * accepter (includedSeats=N, ACTIVE, OWNER membership), sets
 * org.billingOwnerUserId, clears pendingEnterpriseSeats, emits an
 * ENTERPRISE_PROVISIONED audit row, and returns a setupRedirect.
 *
 * Negative: a normal ORG_MEMBER accept (pendingEnterpriseSeats=null)
 * creates NO workspace, writes no audit row, and returns null (no
 * setupRedirect).
 *
 * House style mirrors phase2-enterprise-provisioning.test.ts: mocked
 * audit module + an injectable in-memory prisma double. No live DB.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { asPrismaDouble, type DelegateArgs } from "./support/prisma-double.js";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT imports.
// ---------------------------------------------------------------------------

const { emitOrgAuditEventMock, appendPlatformAuditLogMock } = vi.hoisted(
  () => ({
    emitOrgAuditEventMock: vi.fn(async () => undefined),
    appendPlatformAuditLogMock: vi.fn(async () => undefined),
  }),
);
vi.mock("../src/services/organization/org-audit.service.js", () => ({
  emitOrgAuditEvent: emitOrgAuditEventMock,
}));
vi.mock("../src/services/platform-audit-log.service.js", () => ({
  appendPlatformAuditLog: appendPlatformAuditLogMock,
}));

// The service only needs `prisma` for its default client — the helper is
// always called with an explicit tx, so this stub is never used.
vi.mock("../src/db.js", () => ({ prisma: {} }));

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------

import { completeEnterpriseProvisioningOnOwnerAccept } from "../src/services/enterprise-provisioning.service.js";

// ---------------------------------------------------------------------------
// In-memory prisma double (tx client shape only — the helper takes a tx).
// ---------------------------------------------------------------------------

type Team = {
  id: string;
  organizationId: string | null;
  ownerUserId: string;
  billingOwnerUserId: string | null;
  name: string;
  billingPlan: string;
  billingStatus: string;
  includedSeats: number;
  overSeatLimit: boolean;
  memberCount: number;
  memberRoles: { userId: string; role: string }[];
};

type Org = {
  id: string;
  name: string;
  status: string;
  billingOwnerUserId: string | null;
  pendingEnterpriseSeats: number | null;
};

function makeTx(seed: { orgs?: Org[]; teams?: Team[] }) {
  const orgs = new Map<string, Org>((seed.orgs ?? []).map((o) => [o.id, o]));
  const teams = new Map<string, Team>((seed.teams ?? []).map((t) => [t.id, t]));

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const tx = {
    organization: {
      findUnique: vi.fn(async ({ where }: DelegateArgs) => {
        const o = orgs.get(String(where?.id));
        return o ? { ...o } : null;
      }),
      update: vi.fn(async ({ where, data }: DelegateArgs) => {
        const o = orgs.get(String(where?.id))!;
        Object.assign(o, data);
        return { ...o };
      }),
    },
    team: {
      count: vi.fn(async ({ where }: DelegateArgs) => {
        return [...teams.values()].filter(
          (t) => t.organizationId === where?.organizationId,
        ).length;
      }),
      create: vi.fn(async ({ data }: DelegateArgs) => {
        // The shape the production caller actually sends; narrowed once here
        // so a change in the write payload surfaces as a type error.
        const d = (data ?? {}) as {
          organizationId: string;
          ownerUserId: string;
          billingOwnerUserId?: string | null;
          name: string;
          billingPlan: string;
          billingStatus: string;
          includedSeats: number;
          overSeatLimit?: boolean;
          members?: { create?: { userId: string; role: string } };
        };
        const memberRoles = d.members?.create
          ? [
              {
                userId: d.members.create.userId,
                role: d.members.create.role,
              },
            ]
          : [];
        const t: Team = {
          id: nextId("team"),
          organizationId: d.organizationId,
          ownerUserId: d.ownerUserId,
          billingOwnerUserId: d.billingOwnerUserId ?? null,
          name: d.name,
          billingPlan: d.billingPlan,
          billingStatus: d.billingStatus,
          includedSeats: d.includedSeats,
          overSeatLimit: d.overSeatLimit ?? false,
          memberCount: memberRoles.length,
          memberRoles,
        };
        teams.set(t.id, t);
        return { id: t.id };
      }),
    },
  };

  return { tx, orgs, teams };
}

beforeEach(() => {
  emitOrgAuditEventMock.mockClear();
  appendPlatformAuditLogMock.mockClear();
});

// ---------------------------------------------------------------------------
// Positive — ORG_OWNER accept completes enterprise provisioning.
// ---------------------------------------------------------------------------

describe("completeEnterpriseProvisioningOnOwnerAccept — positive", () => {
  it("mints an ENTERPRISE workspace + OWNER, clears the marker, sets billing owner, returns setupRedirect", async () => {
    const { tx, orgs, teams } = makeTx({
      orgs: [
        {
          id: "org-1",
          name: "Acme Inc",
          status: "ACTIVE",
          billingOwnerUserId: null,
          pendingEnterpriseSeats: 25,
        },
      ],
      teams: [],
    });

    const res = await completeEnterpriseProvisioningOnOwnerAccept(asPrismaDouble(tx), {
      organizationId: "org-1",
      userId: "user-9",
      inviteRole: "ORG_OWNER",
      actorUserId: "user-9",
    });

    expect(res).not.toBeNull();
    expect(res!.seats).toBe(25);
    expect(res!.setupRedirect).toBe("/organizations/org-1/setup");
    expect(res!.enterpriseWorkspaceId).toBeTruthy();

    // Workspace created with the provisioned plan + seats + OWNER member.
    const ws = teams.get(res!.enterpriseWorkspaceId)!;
    expect(ws.organizationId).toBe("org-1");
    expect(ws.ownerUserId).toBe("user-9");
    expect(ws.billingPlan).toBe("ENTERPRISE");
    expect(ws.billingStatus).toBe("ACTIVE");
    expect(ws.includedSeats).toBe(25);
    expect(ws.overSeatLimit).toBe(false);
    expect(ws.memberRoles).toContainEqual({ userId: "user-9", role: "OWNER" });

    // Org marker cleared + billing owner claimed.
    const org = orgs.get("org-1")!;
    expect(org.pendingEnterpriseSeats).toBeNull();
    expect(org.billingOwnerUserId).toBe("user-9");

    // Audit row emitted inside the tx.
    expect(emitOrgAuditEventMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: "org-1",
        eventType: "ENTERPRISE_PROVISIONED",
        actorUserId: "user-9",
      }),
    );
  });

  it("preserves an existing org.billingOwnerUserId instead of overwriting it", async () => {
    const { tx, orgs } = makeTx({
      orgs: [
        {
          id: "org-2",
          name: "Beta",
          status: "ACTIVE",
          billingOwnerUserId: "prior-owner",
          pendingEnterpriseSeats: 10,
        },
      ],
      teams: [],
    });

    await completeEnterpriseProvisioningOnOwnerAccept(asPrismaDouble(tx), {
      organizationId: "org-2",
      userId: "user-9",
      inviteRole: "ORG_OWNER",
      actorUserId: "user-9",
    });

    expect(orgs.get("org-2")!.billingOwnerUserId).toBe("prior-owner");
    expect(orgs.get("org-2")!.pendingEnterpriseSeats).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Negative — non-enterprise accepts are a no-op.
// ---------------------------------------------------------------------------

describe("completeEnterpriseProvisioningOnOwnerAccept — negative", () => {
  it("a normal ORG_MEMBER accept (no pending marker) creates nothing and returns null", async () => {
    const { tx, orgs, teams } = makeTx({
      orgs: [
        {
          id: "org-3",
          name: "Gamma",
          status: "ACTIVE",
          billingOwnerUserId: null,
          pendingEnterpriseSeats: null,
        },
      ],
      teams: [],
    });

    const res = await completeEnterpriseProvisioningOnOwnerAccept(asPrismaDouble(tx), {
      organizationId: "org-3",
      userId: "user-9",
      inviteRole: "ORG_MEMBER",
      actorUserId: "user-9",
    });

    expect(res).toBeNull();
    expect(teams.size).toBe(0);
    expect(orgs.get("org-3")!.billingOwnerUserId).toBeNull();
    expect(tx.team.create).not.toHaveBeenCalled();
    expect(emitOrgAuditEventMock).not.toHaveBeenCalled();
  });

  it("an ORG_OWNER accept with NO pending marker is a no-op (returns null)", async () => {
    const { tx, teams } = makeTx({
      orgs: [
        {
          id: "org-4",
          name: "Delta",
          status: "ACTIVE",
          billingOwnerUserId: null,
          pendingEnterpriseSeats: null,
        },
      ],
      teams: [],
    });

    const res = await completeEnterpriseProvisioningOnOwnerAccept(asPrismaDouble(tx), {
      organizationId: "org-4",
      userId: "user-9",
      inviteRole: "ORG_OWNER",
      actorUserId: "user-9",
    });

    expect(res).toBeNull();
    expect(teams.size).toBe(0);
    expect(emitOrgAuditEventMock).not.toHaveBeenCalled();
  });

  it("is idempotent — an ORG_OWNER accept for an org that ALREADY has a workspace is a no-op", async () => {
    const { tx, teams } = makeTx({
      orgs: [
        {
          id: "org-5",
          name: "Epsilon",
          status: "ACTIVE",
          billingOwnerUserId: "user-9",
          pendingEnterpriseSeats: 5,
        },
      ],
      teams: [
        {
          id: "t-existing",
          organizationId: "org-5",
          ownerUserId: "user-9",
          billingOwnerUserId: "user-9",
          name: "Existing WS",
          billingPlan: "ENTERPRISE",
          billingStatus: "ACTIVE",
          includedSeats: 5,
          overSeatLimit: false,
          memberCount: 1,
          memberRoles: [{ userId: "user-9", role: "OWNER" }],
        },
      ],
    });

    const res = await completeEnterpriseProvisioningOnOwnerAccept(asPrismaDouble(tx), {
      organizationId: "org-5",
      userId: "user-9",
      inviteRole: "ORG_OWNER",
      actorUserId: "user-9",
    });

    expect(res).toBeNull();
    // No second workspace was created.
    expect(teams.size).toBe(1);
    expect(tx.team.create).not.toHaveBeenCalled();
    expect(emitOrgAuditEventMock).not.toHaveBeenCalled();
  });
});
