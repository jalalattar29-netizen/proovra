/**
 * MEMBERS RE-AUDIT ENT-05 / DEFECT 14 — ONE seat formula, against live
 * PostgreSQL.
 *
 * The legacy formula (`computeOverSeatLimit` over every ACTIVE member, the
 * owner included, against raw `Team.includedSeats`) was persisted into
 * `Team.overSeatLimit` by `refreshTeamSeatState` and projected verbatim by
 * GET /v1/orgs/:id/workspaces to the org-admin Seats card. The canonical
 * authority (`resolveWorkspaceSeatState`) excludes the owner and is bounded
 * only by an ACTIVE Enterprise contract's seat count. For an Enterprise
 * workspace with a 4-seat contract, four members and its owner, the legacy
 * answer is "over" (5 > 4) and the canonical one is "within limit".
 *
 * This proves, end to end:
 *   1. the org route projects the canonical answer, even when the persisted
 *      column still holds a stale legacy `true`;
 *   2. `refreshTeamSeatState` — the writer — persists the canonical answer;
 *   3. a workspace genuinely over its contract is reported over by both.
 */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import {
  seedOrganizationTenant,
  type FixtureDeps,
} from "./point7/product-fixtures.js";

type SeatsBlock = {
  used: number;
  limit: number | null;
  remaining: number | null;
  overLimit: boolean;
  featureIncluded: boolean;
  source: string;
};

type WorkspacesBody = {
  callerCanSeeBilling: boolean;
  workspaces: Array<{
    workspaceId: string;
    billing?: { includedSeats: number; overSeatLimit: boolean; seats: SeatsBlock };
  }>;
};

describe("ENT-05 — the org Seats projection is the canonical seat authority (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let deps: FixtureDeps;
  let refreshTeamSeatState: typeof import("../src/services/billing.service.js")["refreshTeamSeatState"];
  let grantModule: typeof import("../src/services/enterprise-provisioning.service.js");
  let projectionModule: typeof import("../src/services/billing/billing-account-projection.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ refreshTeamSeatState } = await import("../src/services/billing.service.js"));
    grantModule = await import("../src/services/enterprise-provisioning.service.js");
    projectionModule = await import("../src/services/billing/billing-account-projection.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `seats-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
  });

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function seedContractWorkspace(members: number, contractSeats: number) {
    const t = await seedOrganizationTenant(deps, { memberCount: members });
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { seatCount: contractSeats },
    });
    return t;
  }

  async function readWorkspaces(orgId: string, token: string): Promise<WorkspacesBody> {
    const res = await harness.app.inject({
      method: "GET",
      url: `/v1/orgs/${orgId}/workspaces`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as WorkspacesBody;
  }

  it("owner + 4 members on a 4-seat contract: within limit on the route, even with a stale legacy flag persisted", async () => {
    const t = await seedContractWorkspace(4, 4);
    // The state the legacy writer left behind: includedSeats 4, owner counted.
    await prisma.team.update({
      where: { id: t.workspaceId },
      data: { includedSeats: 4, overSeatLimit: true },
    });

    const body = await readWorkspaces(t.organizationId, t.owner.token);
    expect(body.callerCanSeeBilling).toBe(true);
    const ws = body.workspaces.find((w) => w.workspaceId === t.workspaceId)!;
    expect(ws.billing!.seats).toMatchObject({
      used: 4,
      limit: 4,
      remaining: 0,
      overLimit: false,
      featureIncluded: true,
      source: "ENTERPRISE_CONTRACT",
    });
    expect(ws.billing!.overSeatLimit).toBe(false);
  });

  it("refreshTeamSeatState persists the canonical answer, not the owner-inclusive one", async () => {
    const t = await seedContractWorkspace(4, 4);
    await prisma.team.update({
      where: { id: t.workspaceId },
      data: { includedSeats: 4, overSeatLimit: true },
    });

    await refreshTeamSeatState(t.workspaceId);

    const row = await prisma.team.findUniqueOrThrow({
      where: { id: t.workspaceId },
      select: { overSeatLimit: true },
    });
    expect(row.overSeatLimit).toBe(false);
  });

  it("5 members on a 4-seat contract is over — on the route and in the persisted flag", async () => {
    const t = await seedContractWorkspace(5, 4);
    await prisma.team.update({
      where: { id: t.workspaceId },
      data: { includedSeats: 4, overSeatLimit: false },
    });

    await refreshTeamSeatState(t.workspaceId);
    const row = await prisma.team.findUniqueOrThrow({
      where: { id: t.workspaceId },
      select: { overSeatLimit: true },
    });
    expect(row.overSeatLimit).toBe(true);

    const body = await readWorkspaces(t.organizationId, t.owner.token);
    const ws = body.workspaces.find((w) => w.workspaceId === t.workspaceId)!;
    expect(ws.billing!.seats).toMatchObject({ used: 5, limit: 4, overLimit: true });
    expect(ws.billing!.overSeatLimit).toBe(true);
  });

  it("an org-plan grant persists the canonical answer after commit (owner excluded), not a formula of its own", async () => {
    const { grantEnterprisePlanToOrg } = grantModule;
    const t = await seedContractWorkspace(4, 10);
    // A stale legacy flag the grant must overwrite with the canonical answer.
    await prisma.team.update({ where: { id: t.workspaceId }, data: { overSeatLimit: true } });

    // Owner + 4 members on 4 contract seats: within the limit (owner not counted).
    await grantEnterprisePlanToOrg({ orgId: t.organizationId, plan: "ENTERPRISE", seats: 4, actorUserId: t.owner.userId }, prisma as never);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.workspaceId }, select: { overSeatLimit: true } })).overSeatLimit).toBe(false);

    // The same workspace on 3 seats is over — the grant's contract, read after commit.
    await grantEnterprisePlanToOrg({ orgId: t.organizationId, plan: "ENTERPRISE", seats: 3, actorUserId: t.owner.userId }, prisma as never);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: t.workspaceId }, select: { overSeatLimit: true } })).overSeatLimit).toBe(true);
  });

  it("CT-14 — the Organization billing projection counts open workspace invitations only", async () => {
    const { buildBillingAccountProjection } = projectionModule;
    const t = await seedContractWorkspace(1, 4);
    const invite = (over: Record<string, unknown>) =>
      prisma.teamInvite.create({
        data: {
          teamId: t.workspaceId,
          email: `inv-${randomUUID().slice(0, 8)}@invitee.test`,
          role: "MEMBER",
          tokenHash: createHash("sha256").update(randomUUID()).digest("hex"),
          expiresAt: new Date(Date.now() + 86_400_000),
          invitedByUserId: t.owner.userId,
          ...over,
        } as never,
      });
    await invite({});
    await invite({});
    await invite({ expiresAt: new Date(Date.now() - 60_000) });
    await invite({ revokedAt: new Date() });
    await invite({ acceptedAt: new Date() });

    const projection = await buildBillingAccountProjection({
      account: { type: "ORGANIZATION", id: t.organizationId, displayName: "Org", capabilities: [], billingOwnerMissing: false },
      viewerUserId: t.owner.userId,
    });
    expect(projection.collaboration?.seats?.pendingInvites).toBe(2);
  });

  it("an ORG_MEMBER sees no billing block (and no seat state) at all", async () => {
    const t = await seedContractWorkspace(1, 4);
    const body = await readWorkspaces(t.organizationId, t.members[0]!.token);
    expect(body.callerCanSeeBilling).toBe(false);
    for (const w of body.workspaces) expect(w.billing).toBeUndefined();
  });
});
