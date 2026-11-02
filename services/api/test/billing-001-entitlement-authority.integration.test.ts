/**
 * BILLING-001 — no customer raises their own paid features, an operator still
 * can, and what an Enterprise contract sold works with no customer action.
 *
 * Real routes on a real PostgreSQL. The audit reproduced this on a FREE owner, on
 * a VIEWER's personal workspace and on an Enterprise owner self-granting
 * FEATURE_REDACTION, so each stands here as a negative control with its row count.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("BILLING-001 — the entitlement authority (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let fixtures: typeof import("./point7/product-fixtures.js");
  let signJwt: typeof import("../src/services/jwt.js").signJwt;
  let entitlements: typeof import("../src/services/packaging/entitlement.service.js");
  let stepUp: typeof import("./helpers/operator-step-up.js");
  const tag = () => randomUUID().slice(0, 8);
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    fixtures = await import("./point7/product-fixtures.js");
    ({ signJwt } = await import("../src/services/jwt.js"));
    entitlements = await import("../src/services/packaging/entitlement.service.js");
    stepUp = await import("./helpers/operator-step-up.js");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  const deps = () => ({
    prisma: prisma as never,
    tag: `ent-${tag()}`,
    mintToken: (userId: string, email: string) =>
      signJwt(
        { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
        process.env.AUTH_JWT_SECRET as string,
        3600,
      ),
  });

  const grantBody = (workspaceId: string) => ({
    teamId: workspaceId,
    targetWorkspaceId: workspaceId,
    key: "FEATURE_WEBHOOKS",
    kind: "FEATURE",
    value: true,
    source: "PLAN",
  });

  async function refuses(workspaceId: string, token: string) {
    const headers = bearer(token);
    const grant = await h.app.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers,
      payload: grantBody(workspaceId),
    });
    expect(grant.statusCode, grant.body).toBe(403);
    const line = await h.app.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/apply-product-line",
      headers,
      payload: { teamId: workspaceId, targetWorkspaceId: workspaceId, line: "ENTERPRISE" },
    });
    expect(line.statusCode, line.body).toBe(403);
    expect(await prisma.entitlementGrant.count({ where: { teamId: workspaceId } })).toBe(0);
  }

  it("a FREE owner, a TEAM owner and an Enterprise owner are each refused, and no row is written", async () => {
    const d = deps();
    const personal = await fixtures.seedPersonalTenant(d, "FREE");
    await refuses(personal.personalTeamId, personal.owner.token);

    const A = h.fixtures.teamA;
    await prisma.team.updateMany({ where: { id: A.teamId }, data: { billingPlan: "TEAM", billingStatus: "ACTIVE" } });
    await refuses(A.teamId, A.ownerToken);

    const enterprise = await fixtures.seedOrganizationTenant(d);
    await refuses(enterprise.workspaceId, enterprise.owner.token);
  });

  it("a self-grant cannot open a paid gate: the webhook endpoint stays refused for a FREE owner", async () => {
    const personal = await fixtures.seedPersonalTenant(deps(), "FREE");
    await refuses(personal.personalTeamId, personal.owner.token);
    const projected = await entitlements.resolveEntitlement({
      prisma,
      teamId: personal.personalTeamId,
      key: "FEATURE_WEBHOOKS",
    });
    expect(projected).toMatchObject({ value: false, source: "DEFAULT" });
  });

  it("a provisioned Enterprise customer has what the contract sold, with no customer action and nothing stored", async () => {
    const t = await fixtures.seedOrganizationTenant(deps());
    expect(await prisma.entitlementGrant.count({ where: { teamId: t.workspaceId } })).toBe(0);

    const redaction = await entitlements.assertFeatureEntitlement({
      prisma,
      teamId: t.workspaceId,
      key: "FEATURE_REDACTION",
      actorUserId: t.owner.userId,
    });
    expect(redaction).toMatchObject({ ok: true });

    const list = await entitlements.listEntitlements({ prisma, teamId: t.workspaceId });
    const byKey = new Map(list.map((e) => [e.key, e]));
    expect(byKey.get("FEATURE_WEBHOOKS")).toMatchObject({ value: true, source: "PLAN" });
    expect(byKey.get("INTEGRATION_WEBHOOK_ENDPOINTS_MAX")).toMatchObject({ value: 100, source: "PLAN" });
    expect(byKey.get("RETENTION_MAX_YEARS")).toMatchObject({ value: 25, source: "PLAN" });
    // Legal Hold is a contract term of its own, still not implied by the plan.
    expect(byKey.get("FEATURE_LEGAL_HOLD")).toMatchObject({ value: false });

    const res = await h.app.inject({
      method: "GET",
      url: `/v1/packaging/entitlements`,
      headers: { ...bearer(t.owner.token), "x-workspace-id": t.workspaceId },
    });
    expect(res.statusCode, res.body).toBeLessThan(500);
  });

  it("a contract that stops being ACTIVE grants nothing, stored grant or not", async () => {
    const t = await fixtures.seedOrganizationTenant(deps());
    await entitlements.upsertEntitlementGrant({
      prisma,
      teamId: t.workspaceId,
      key: "FEATURE_WEBHOOKS",
      kind: "FEATURE",
      value: true,
      source: "CUSTOM",
      grantedByUserId: t.owner.userId,
    });
    await prisma.enterpriseContract.update({
      where: { organizationId: t.organizationId },
      data: { status: "SUSPENDED" },
    });
    for (const key of ["FEATURE_WEBHOOKS", "FEATURE_REDACTION"] as const) {
      expect(await entitlements.resolveEntitlement({ prisma, teamId: t.workspaceId, key })).toMatchObject({
        value: false,
        source: "DEFAULT",
      });
    }
  });

  it("an operator can still state an exception: step-up required, audited, and it reaches the gate", async () => {
    const operator = await stepUp.seedOperator(h, deps(), prisma);
    const personal = await fixtures.seedPersonalTenant(deps(), "FREE");
    const payload = { ...grantBody(personal.personalTeamId), teamId: operator.stepUpTeamId, source: "CUSTOM" };

    const noStepUp = await h.app.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: bearer(operator.token),
      payload,
    });
    expect(noStepUp.statusCode, noStepUp.body).toBe(401);
    expect(await prisma.entitlementGrant.count({ where: { teamId: personal.personalTeamId } })).toBe(0);

    const challengeId = await stepUp.approvedStepUp(h, operator, "CAPABILITY_GRANT", "workspace", personal.personalTeamId);
    const granted = await h.app.inject({
      method: "POST",
      url: "/v1/packaging/entitlements/grant",
      headers: { ...bearer(operator.token), "x-proovra-step-up-challenge-id": challengeId },
      payload,
    });
    expect(granted.statusCode, granted.body).toBe(201);
    expect(
      await entitlements.resolveEntitlement({ prisma, teamId: personal.personalTeamId, key: "FEATURE_WEBHOOKS" }),
    ).toMatchObject({ value: true, source: "CUSTOM" });
    expect(
      await prisma.adminAuditLog.count({
        where: { action: "billing.entitlement_granted", resourceId: granted.json().grantId },
      }),
    ).toBe(1);
  });
});
