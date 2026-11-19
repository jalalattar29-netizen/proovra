/**
 * PRO-K1-03 (WS-ENT, RG-13) — investigation graph, investigation diagnostics
 * and SIU APIs answer only an Enterprise organization workspace. Live
 * PostgreSQL, the real routes.
 *
 * At base cdcb8aef8 every one of these routes served and mutated for any
 * member of any workspace (only the web hid them): the refusals below were
 * 200/201/202.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { makeEnterpriseOrganizationWorkspace } from "./support/enterprise-organization.js";

describe("PRO-K1-03 Enterprise-only investigation/SIU APIs (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const call = (method: "GET" | "POST" | "PUT", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);

  afterAll(async () => {
    await h?.cleanup();
  });

  it("a non-Enterprise workspace owner is refused on graph, diagnostics and SIU writes, and nothing is written", async () => {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { billingPlan: true } });
    expect(team.billingPlan).not.toBe("ENTERPRISE");
    const q = `teamId=${A.teamId}`;

    for (const [method, url, body] of [
      ["GET", `/v1/graph/seeds?${q}`, undefined],
      ["GET", `/v1/graph/search?${q}&label=x`, undefined],
      ["GET", `/v1/graph/diagnostics?${q}`, undefined],
      ["POST", `/v1/graph/reconcile?${q}`, {}],
      ["GET", `/v1/investigation/diagnostics?${q}`, undefined],
      ["GET", `/v1/siu/worklist?${q}`, undefined],
      ["GET", `/v1/siu/saved-views?${q}`, undefined],
      ["PUT", `/v1/cases/${A.caseId}/siu-profile`, { claimType: "auto" }],
      ["POST", `/v1/cases/${A.caseId}/siu-export`, {}],
    ] as const) {
      const res = await call(method, url, A.ownerToken, body);
      expect(res.statusCode, `${method} ${url} ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE" });
    }
    const manual = await call("POST", "/v1/graph/relationships/manual", A.ownerToken, {
      teamId: A.teamId,
      sourceNodeId: "11111111-1111-4111-8111-111111111111",
      targetNodeId: "22222222-2222-4222-8222-222222222222",
      edgeType: "MANUALLY_LINKED_TO",
    });
    expect(manual.statusCode, manual.body).toBe(403);
    expect(await prisma.manualRelationship.count({ where: { teamId: A.teamId } })).toBe(0);
    expect(await prisma.caseSiuProfile.count({ where: { caseId: A.caseId } })).toBe(0);
    expect(await prisma.caseSiuExport.count({ where: { caseId: A.caseId } })).toBe(0);

    // DEC-10 — reads of stored SIU material stay open to an authorized member.
    const exportsList = await call("GET", `/v1/cases/${A.caseId}/siu-exports`, A.ownerToken);
    expect(exportsList.statusCode, exportsList.body).toBe(200);
  });

  it("a non-member is still answered with the concealed 404, not the plan refusal", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const res = await call("GET", `/v1/graph/seeds?teamId=${A.teamId}`, B.ownerToken);
    expect(res.statusCode, res.body).toBe(404);
  });

  it("PRO-A2-09: a non-Enterprise workspace cannot mint a capability grant or a delegated scope; reads stay by role", async () => {
    // At base both POSTs passed membership + permission and went on to the
    // step-up challenge (401 STEP_UP_REQUIRED) for ANY workspace.
    const B = h.fixtures.teamB;
    const A = h.fixtures.teamA;
    const target = await prisma.teamMember.findFirstOrThrow({
      where: { teamId: B.teamId, userId: B.viewerUserId },
      select: { id: true },
    });
    for (const [url, body] of [
      [`/v1/identity/members/${target.id}/capabilities`, { teamId: B.teamId, permission: "evidence.read" }],
      [`/v1/identity/members/${target.id}/delegated-admin`, { teamId: B.teamId, scopeKind: "GOVERNANCE_ADMIN" }],
    ] as const) {
      const res = await call("POST", url, B.ownerToken, body);
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED", requirement: "ENTERPRISE_ORGANIZATION_WORKSPACE" });
      // A caller of another workspace still gets the concealed 404.
      const foreign = await call("POST", url, A.ownerToken, body);
      expect(foreign.statusCode, foreign.body).toBe(404);
    }
    expect(await prisma.memberCapabilityGrant.count({ where: { teamMemberId: target.id } })).toBe(0);
    expect(await prisma.memberDelegatedAdminScope.count({ where: { teamMemberId: target.id } })).toBe(0);

    // DEC-10 — the roster read (and with it every revoke) is still by role.
    await prisma.user.update({ where: { id: B.ownerUserId }, data: { currentWorkspaceId: B.teamId } });
    const roster = await call("GET", "/v1/identity/members", B.ownerToken);
    expect(roster.statusCode, roster.body).toBe(200);

    // Entitled: the same POST passes the plan question and reaches step-up.
    await makeEnterpriseOrganizationWorkspace(prisma, B.teamId);
    const entitled = await call("POST", `/v1/identity/members/${target.id}/delegated-admin`, B.ownerToken, {
      teamId: B.teamId,
      scopeKind: "GOVERNANCE_ADMIN",
    });
    expect(entitled.statusCode, entitled.body).toBe(401);
    expect(entitled.body).toContain("STEP_UP_REQUIRED");
  });

  it("once the workspace is an Enterprise organization (ACTIVE contract) the same routes answer, without a redeploy", async () => {
    const A = h.fixtures.teamA;
    await makeEnterpriseOrganizationWorkspace(prisma, A.teamId);
    const seeds = await call("GET", `/v1/graph/seeds?teamId=${A.teamId}`, A.ownerToken);
    expect(seeds.statusCode, seeds.body).toBe(200);
    const put = await call("PUT", `/v1/cases/${A.caseId}/siu-profile`, A.ownerToken, { claimType: "auto" });
    expect(put.statusCode, put.body).toBeLessThan(300);
    expect(await prisma.caseSiuProfile.count({ where: { caseId: A.caseId } })).toBe(1);
  });
});
