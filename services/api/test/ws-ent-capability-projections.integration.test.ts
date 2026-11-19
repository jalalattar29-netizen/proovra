/**
 * WS-ENT (RG-13 / RG-14) — the server answers that clients now render, and the
 * sibling gates that were missing. Live PostgreSQL, the real routes.
 *
 * At base cdcb8aef8:
 *   PRO-T1C-02  a VIEWER read the billing, integrations and governance
 *               sections of the workspace-administration aggregate.
 *   PRO-K2-23   every role read the subscription lifecycle detail.
 *   PRO-K2-09   a workspace VIEWER was projected canCreateCollaborationTeam.
 *   PRO-E1-06   a creator demoted to VIEWER renamed / deleted a TEAM view.
 *   PRO-E2-05   a label write was accepted on a record in Trash.
 *   PRO-NC-08   a role refusal on batch analysis was the plan sentence.
 *   PRO-NAZ-01  the criteria list projected no authoring decision.
 *   PRO-E2-09   the record detail projected no downloadOriginal capability.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const WS = "x-proovra-workspace-id";

describe("WS-ENT capability projections and sibling gates (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const call = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    token: string,
    payload?: unknown,
    teamId?: string,
  ) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(teamId ? { [WS]: teamId } : {}),
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

  it("PRO-T1C-02: the administration aggregate projects billing, integrations and governance only to a role holding each", async () => {
    const A = h.fixtures.teamA;
    const url = `/v1/teams/workspace-admin?teamId=${A.teamId}`;
    type Sections = Record<string, { status: string }>;

    const viewer = await call("GET", url, A.viewerToken, undefined, A.teamId);
    expect(viewer.statusCode, viewer.body).toBe(200);
    const v = (viewer.json() as { sections: Sections }).sections;
    expect(v.billing!.status).toBe("not_applicable");
    expect(v.integrationsPosture!.status).toBe("not_applicable");
    expect(viewer.body).not.toContain("seatsUsed");

    const owner = await call("GET", url, A.ownerToken, undefined, A.teamId);
    expect(owner.statusCode, owner.body).toBe(200);
    const o = (owner.json() as { sections: Sections }).sections;
    expect(o.billing!.status).not.toBe("not_applicable");
    expect(o.integrationsPosture!.status).not.toBe("not_applicable");
    expect(o.governanceSnapshot!.status).not.toBe("not_applicable");
  });

  it("PRO-K2-23 / PRO-K2-09: the collaboration entitlement gives lifecycle detail to billing.read only, and no create affordance to a workspace VIEWER", async () => {
    const A = h.fixtures.teamA;
    type Projection = {
      lifecycle: { state: string; graceEndsAtUtc: string | null };
      canCreateCollaborationTeam: boolean;
      canAssignExistingMember: boolean;
    };
    const viewer = await call("GET", "/v1/collaboration-teams/entitlement", A.viewerToken, undefined, A.teamId);
    expect(viewer.statusCode, viewer.body).toBe(200);
    const v = viewer.json() as Projection;
    expect(["ACTIVE", "RESTRICTED"]).toContain(v.lifecycle.state);
    expect(v.lifecycle.graceEndsAtUtc).toBeNull();
    expect(v.canCreateCollaborationTeam).toBe(false);
    expect(v.canAssignExistingMember).toBe(false);

    const owner = await call("GET", "/v1/collaboration-teams/entitlement", A.ownerToken, undefined, A.teamId);
    expect(owner.statusCode, owner.body).toBe(200);
  });

  it("PRO-E1-06: a creator demoted to VIEWER no longer renames or deletes their TEAM search view; their PRIVATE view stays theirs", async () => {
    const A = h.fixtures.teamA;
    const create = async (visibility: "TEAM" | "PRIVATE") => {
      const res = await call("POST", "/v1/search/saved-views", A.memberToken, {
        teamId: A.teamId,
        name: `ws-ent ${visibility} ${Date.now()}`,
        visibility,
        query: { teamId: A.teamId },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json() as { view: { id: string; name: string } }).view;
    };
    const shared = await create("TEAM");
    const mine = await create("PRIVATE");

    await prisma.teamMember.updateMany({
      where: { teamId: A.teamId, userId: A.memberUserId },
      data: { role: "VIEWER" },
    });
    try {
      const rename = await call("PATCH", `/v1/search/saved-views/${shared.id}`, A.memberToken, {
        teamId: A.teamId,
        name: "renamed after demotion",
      });
      expect(rename.statusCode, rename.body).toBeGreaterThanOrEqual(400);
      const del = await call("DELETE", `/v1/search/saved-views/${shared.id}?teamId=${A.teamId}`, A.memberToken);
      expect(del.statusCode, del.body).toBeGreaterThanOrEqual(400);
      expect(await prisma.savedSearchView.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({
        name: shared.name,
      });

      const delMine = await call("DELETE", `/v1/search/saved-views/${mine.id}?teamId=${A.teamId}`, A.memberToken);
      expect(delMine.statusCode, delMine.body).toBeLessThan(300);
    } finally {
      await prisma.teamMember.updateMany({
        where: { teamId: A.teamId, userId: A.memberUserId },
        data: { role: "MEMBER" },
      });
    }
  });

  it("PRO-NC-08: a VIEWER refused batch analysis is told it is the role, not the plan", async () => {
    const A = h.fixtures.teamA;
    const res = await call(
      "POST",
      "/v1/batch-analysis",
      A.viewerToken,
      { evidenceIds: [A.evidenceId], name: "ws-ent" },
      A.teamId,
    );
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain("FORBIDDEN");
    expect(res.body).not.toContain("Pro and above");
    expect(await prisma.batchAnalysisJob.count({ where: { name: "ws-ent" } })).toBe(0);
  });

  it("PRO-NAZ-01 / PRO-E2-09: the criteria list and the record detail project the write decisions", async () => {
    const A = h.fixtures.teamA;
    const criteria = await call("GET", `/v1/reviewer-criteria?teamId=${A.teamId}`, A.memberToken, undefined, A.teamId);
    expect(criteria.statusCode, criteria.body).toBe(200);
    expect(criteria.json()).toMatchObject({ canManage: false, manageBlockedBy: "ROLE" });

    const asViewer = await call("GET", `/v1/evidence/${A.evidenceId}`, A.viewerToken, undefined, A.teamId);
    expect(asViewer.statusCode, asViewer.body).toBe(200);
    expect(
      (asViewer.json() as { evidence: { actorCapabilities: { downloadOriginal: boolean } } }).evidence
        .actorCapabilities.downloadOriginal,
    ).toBe(false);
    const asOwner = await call("GET", `/v1/evidence/${A.evidenceId}`, A.ownerToken, undefined, A.teamId);
    expect(asOwner.statusCode, asOwner.body).toBe(200);
    expect(
      (asOwner.json() as { evidence: { actorCapabilities: { downloadOriginal: boolean } } }).evidence
        .actorCapabilities.downloadOriginal,
    ).toBe(true);
  });

  // Last: it moves the fixture record into Trash.
  it("PRO-E2-05: a record in Trash takes no label write", async () => {
    const A = h.fixtures.teamA;
    const before = await prisma.evidence.findUniqueOrThrow({ where: { id: A.evidenceId }, select: { label: true } });
    await prisma.evidence.update({ where: { id: A.evidenceId }, data: { lifecycleState: "TRASHED" } });
    const res = await call("PATCH", `/v1/evidence/${A.evidenceId}/label`, A.ownerToken, { label: "after trash" }, A.teamId);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);
    expect(
      (await prisma.evidence.findUniqueOrThrow({ where: { id: A.evidenceId }, select: { label: true } })).label,
    ).toBe(before.label);
  });
});
