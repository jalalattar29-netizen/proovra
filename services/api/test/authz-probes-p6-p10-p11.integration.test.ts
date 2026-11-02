/**
 * Probes P6, P10 and P11 from the Enterprise audit, run for real.
 *
 *   P6   A member whose access has expired, and a member of a SUSPENDED
 *        Organization, are refused the surfaces with hand-written gates.
 *   P10  The workspace that started a chain transfer cannot accept it.
 *   P11  Two ORG_OWNERs demoting each other at once cannot leave zero owners.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";
import {
  seedOrganizationTenant,
  type FixtureDeps,
  type OrganizationTenant,
} from "./point7/product-fixtures.js";

describe("Authorization probes P6, P10, P11 (live PostgreSQL)", () => {
  let harness: IntegrationHarness;
  let prisma: typeof import("../src/db.js")["prisma"];
  let signJwt: typeof import("../src/services/jwt.js")["signJwt"];
  let deps: FixtureDeps;
  const tag = `prb-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

  const mint = (userId: string, email: string) =>
    signJwt(
      { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) } as never,
      process.env.AUTH_JWT_SECRET!,
      60 * 60,
    );

  const get = (url: string, token: string) =>
    harness.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  // The fourth of AUTHZ-003's hand-written gates. The other three (command
  // center, threads, aggregators) were repaired and are proven on rem/case-reach.
  const surfaces = (org: OrganizationTenant) => [
    `/v1/sso/health?teamId=${org.workspaceId}`,
    `/v1/scim/sync-failures?teamId=${org.workspaceId}`,
  ];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ signJwt } = await import("../src/services/jwt.js"));
    deps = { prisma: prisma as never, tag, mintToken: mint };
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("P6: an expired member and a suspended Organization's member are refused; a current one is not", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 2 });
    const [expired, current] = org.members as [typeof org.members[0], typeof org.members[0]];
    // An administrator on both, so only expiry or lifecycle can be what refuses.
    await prisma.teamMember.updateMany({
      where: { teamId: org.workspaceId, userId: { in: [expired.userId, current.userId] } },
      data: { role: "ADMIN" },
    });
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: org.workspaceId, userId: expired.userId } },
      data: { accessExpiresAtUtc: new Date(Date.now() - 60_000) },
    });

    for (const url of surfaces(org)) {
      const live = await get(url, current.token);
      expect(live.statusCode, `${url}: ${live.body}`).toBe(200);
      const gone = await get(url, expired.token);
      expect([403, 404], `${url}: ${gone.body}`).toContain(gone.statusCode);
    }

    await prisma.organization.update({ where: { id: org.organizationId }, data: { status: "SUSPENDED" } });
    for (const url of surfaces(org)) {
      const res = await get(url, current.token);
      expect([403, 404], `${url}: ${res.body}`).toContain(res.statusCode);
    }
  });

  it("P10: the initiating workspace cannot record its counterparty's acceptance", async () => {
    const org = await seedOrganizationTenant(deps, {});
    const counterparty = await seedOrganizationTenant(deps, {});
    await prisma.user.update({
      where: { id: counterparty.owner.userId },
      data: { currentWorkspaceId: counterparty.workspaceId },
    });
    const stepUp = createStepUpCeremony({
      prisma: prisma as never,
      inject: (o) =>
        harness.app.inject({ method: o.method, url: o.url, headers: o.headers, payload: o.payload as never }) as never,
    });
    await prisma.user.update({
      where: { id: org.owner.userId },
      data: { currentWorkspaceId: org.workspaceId },
    });
    await prisma.entitlementGrant.create({
      data: {
        teamId: org.workspaceId,
        entitlementKey: "FEATURE_CHAIN_TRANSFER",
        boolValue: true,
        source: "ADMIN_OVERRIDE",
        grantedByUserId: org.owner.userId,
      } as never,
    }).catch(() => null);
    const evidence = await prisma.evidence.create({
      data: {
        ownerUserId: org.owner.userId,
        teamId: org.workspaceId,
        organizationId: org.organizationId,
        type: "PHOTO",
      },
      select: { id: true },
    });
    const headers = await stepUp.approvedHeader({
      token: org.owner.token,
      userId: org.owner.userId,
      teamId: org.workspaceId,
      purpose: "EVIDENCE_EXCHANGE_EXPORT",
    }).catch(() => ({}));
    const started = await harness.app.inject({
      method: "POST",
      url: "/v1/exchange/chain-transfers",
      headers: { authorization: `Bearer ${org.owner.token}`, ...headers },
      payload: {
        toOrganizationId: counterparty.organizationId,
        evidenceIds: [evidence.id],
        reasonNote: "P10 probe",
      },
    });
    expect(started.statusCode, started.body).toBe(201);
    const transferId = (started.json() as { transferId: string }).transferId;
    const accepted = await harness.app.inject({
      method: "POST",
      url: `/v1/exchange/chain-transfers/${transferId}/accept`,
      headers: { authorization: `Bearer ${org.owner.token}` },
      payload: {},
    });
    expect([403, 404], accepted.body).toContain(accepted.statusCode);
    const stillOpen = await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transferId }, select: { state: true } });
    expect(stillOpen.state).toBe("INITIATED");

    // The counterparty, on the same transfer, may.
    const byRecipient = await harness.app.inject({
      method: "POST",
      url: `/v1/exchange/chain-transfers/${transferId}/accept`,
      headers: { authorization: `Bearer ${counterparty.owner.token}` },
      payload: {},
    });
    expect(byRecipient.statusCode, byRecipient.body).toBe(200);
    const accepted2 = await prisma.chainTransfer.findUniqueOrThrow({ where: { id: transferId }, select: { state: true } });
    expect(accepted2.state).toBe("ACCEPTED");
  });

  it("P11: two owners demoting each other at once leave one owner", async () => {
    const org = await seedOrganizationTenant(deps, { memberCount: 1 });
    const second = org.members[0]!;
    await prisma.organizationMembership.updateMany({
      where: { organizationId: org.organizationId, userId: second.userId },
      data: { role: "ORG_OWNER" },
    });

    const membershipOf = async (userId: string) =>
      (
        await prisma.organizationMembership.findFirstOrThrow({
          where: { organizationId: org.organizationId, userId },
          select: { id: true },
        })
      ).id;
    const [firstMembership, secondMembership] = await Promise.all([
      membershipOf(org.owner.userId),
      membershipOf(second.userId),
    ]);
    const demote = (actorToken: string, membershipId: string) =>
      harness.app.inject({
        method: "PATCH",
        url: `/v1/orgs/${org.organizationId}/members/${membershipId}`,
        headers: { authorization: `Bearer ${actorToken}` },
        payload: { role: "ORG_ADMIN" },
      });

    for (let round = 0; round < 8; round += 1) {
      await prisma.organizationMembership.updateMany({
        where: { organizationId: org.organizationId },
        data: { role: "ORG_OWNER" },
      });
      const results = await Promise.all([
        demote(org.owner.token, secondMembership),
        demote(second.token, firstMembership),
      ]);
      await harness.handlersSettled();
      const owners = await prisma.organizationMembership.count({
        where: { organizationId: org.organizationId, role: "ORG_OWNER", status: "ACTIVE" },
      });
      expect(owners, results.map((r) => r.statusCode).join(",")).toBe(1);
    }
  });
});
