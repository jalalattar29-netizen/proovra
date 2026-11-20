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
      // NEW-RG-13-1 (DEC-11) — the /investigation dashboard and reviewer
      // console reads. At a4a5df226 these three answered 200 to any member.
      ["GET", `/v1/investigation/overview?${q}`, undefined],
      ["GET", `/v1/investigation/reviewers?${q}`, undefined],
      ["GET", `/v1/investigation/cross-evidence?${q}`, undefined],
      // PRO-K1-03 — every SIU profile write and the PII reveal.
      ["POST", `/v1/cases/${A.caseId}/siu-profile/checklist/scene_overview/map-evidence`, { evidenceId: A.evidenceId }],
      ["POST", `/v1/cases/${A.caseId}/siu-profile/checklist/scene_overview/status`, { status: "waived" }],
      [
        "POST",
        `/v1/cases/${A.caseId}/siu-profile/indicators`,
        { code: "MISSING_REQUIRED_EVIDENCE", explanation: "x", severity: "info" },
      ],
      ["POST", `/v1/cases/${A.caseId}/siu-profile/follow-ups`, { checklistItemId: "scene_overview" }],
      [
        "POST",
        `/v1/cases/${A.caseId}/siu-profile/follow-ups/33333333-3333-4333-8333-333333333333/status`,
        { status: "cancelled" },
      ],
      ["POST", `/v1/cases/${A.caseId}/siu-profile/reveal-pii`, undefined],
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
    expect(await prisma.caseSiuReviewIndicator.count({ where: { siuProfile: { caseId: A.caseId } } })).toBe(0);
    expect(await prisma.caseSiuFollowUp.count({ where: { siuProfile: { caseId: A.caseId } } })).toBe(0);

    // DEC-10 — reads of stored SIU material stay open to an authorized member.
    const exportsList = await call("GET", `/v1/cases/${A.caseId}/siu-exports`, A.ownerToken);
    expect(exportsList.statusCode, exportsList.body).toBe(200);
  });

  it("a non-member is still answered with the concealed 404, not the plan refusal", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    const res = await call("GET", `/v1/graph/seeds?teamId=${A.teamId}`, B.ownerToken);
    expect(res.statusCode, res.body).toBe(404);
    // NEW-RG-13-1 — the investigation reads keep the membership 404 first.
    for (const path of ["overview", "reviewers", "cross-evidence"]) {
      const inv = await call("GET", `/v1/investigation/${path}?teamId=${A.teamId}`, B.ownerToken);
      expect(inv.statusCode, `${path} ${inv.body}`).toBe(404);
    }
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

    // NEW-RG-13-1 — the investigation reads answer the entitled workspace.
    for (const path of ["overview", "reviewers", "cross-evidence"]) {
      const inv = await call("GET", `/v1/investigation/${path}?teamId=${A.teamId}`, A.ownerToken);
      expect(inv.statusCode, `${path} ${inv.body}`).toBe(200);
    }
  });

  it("PRO-K1-03/04: on an Enterprise workspace the case owner writes the SIU checklist, indicators and follow-ups", async () => {
    // Runs after the test above: workspace A is an Enterprise organization and
    // case A has an auto-claim SIU profile.
    const A = h.fixtures.teamA;
    await prisma.caseEvidenceLink.create({ data: { caseId: A.caseId, evidenceId: A.evidenceId, teamId: A.teamId } as never });
    const base = `/v1/cases/${A.caseId}/siu-profile`;

    const mapped = await call("POST", `${base}/checklist/scene_overview/map-evidence`, A.ownerToken, {
      evidenceId: A.evidenceId,
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    const status = await call("POST", `${base}/checklist/vehicle_identifier/status`, A.ownerToken, { status: "waived" });
    expect(status.statusCode, status.body).toBe(200);
    const indicator = await call("POST", `${base}/indicators`, A.ownerToken, {
      code: "MISSING_REQUIRED_EVIDENCE",
      explanation: "owner note",
      severity: "info",
    });
    expect(indicator.statusCode, indicator.body).toBe(200);
    const followUp = await call("POST", `${base}/follow-ups`, A.ownerToken, { checklistItemId: "repair_estimate" });
    expect(followUp.statusCode, followUp.body).toBe(200);
    const followUpId = (followUp.json() as { followUp: { id: string } }).followUp.id;
    const followUpStatus = await call("POST", `${base}/follow-ups/${followUpId}/status`, A.ownerToken, { status: "sent" });
    expect(followUpStatus.statusCode, followUpStatus.body).toBe(200);

    const profile = await prisma.caseSiuProfile.findUniqueOrThrow({ where: { caseId: A.caseId }, select: { id: true } });
    const items = await prisma.caseSiuChecklistItem.findMany({
      where: { siuProfileId: profile.id, templateItemId: { in: ["scene_overview", "vehicle_identifier"] } },
      select: { templateItemId: true, status: true },
    });
    expect(Object.fromEntries(items.map((i) => [i.templateItemId, i.status]))).toEqual({
      scene_overview: "mapped",
      vehicle_identifier: "waived",
    });
    expect(await prisma.caseSiuReviewIndicator.count({ where: { siuProfileId: profile.id } })).toBe(1);
    expect(
      await prisma.caseSiuFollowUp.findUniqueOrThrow({ where: { id: followUpId }, select: { status: true } }),
    ).toEqual({ status: "sent" });
  });

  it("PRO-K1-04: a VIEWER is refused every SIU write, even holding an evidence.update_metadata grant, and nothing changes", async () => {
    const A = h.fixtures.teamA;
    const base = `/v1/cases/${A.caseId}/siu-profile`;
    const profile = await prisma.caseSiuProfile.findUniqueOrThrow({ where: { caseId: A.caseId }, select: { id: true } });
    const followUp = await prisma.caseSiuFollowUp.findFirstOrThrow({
      where: { siuProfileId: profile.id },
      select: { id: true, status: true },
    });
    const writes = [
      [`${base}/checklist/police_report/map-evidence`, { evidenceId: A.evidenceId }],
      [`${base}/checklist/police_report/status`, { status: "waived" }],
      [`${base}/indicators`, { code: "MISSING_REQUIRED_EVIDENCE", explanation: "viewer", severity: "info" }],
      [`${base}/follow-ups`, { checklistItemId: "police_report" }],
      [`${base}/follow-ups/${followUp.id}/status`, { status: "cancelled" }],
    ] as const;
    const snapshot = async () => ({
      police: await prisma.caseSiuChecklistItem.findFirstOrThrow({
        where: { siuProfileId: profile.id, templateItemId: "police_report" },
        select: { status: true, mappedEvidenceIdsJson: true },
      }),
      indicators: await prisma.caseSiuReviewIndicator.count({ where: { siuProfileId: profile.id } }),
      followUps: await prisma.caseSiuFollowUp.findMany({
        where: { siuProfileId: profile.id },
        select: { id: true, status: true },
        orderBy: { id: "asc" },
      }),
    });
    const before = await snapshot();

    // A plain VIEWER does not hold the write permission at all.
    for (const [url, body] of writes) {
      const res = await call("POST", url, A.viewerToken, body);
      expect(res.statusCode, `${url} ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ error: { code: "permission_denied" } });
    }

    // With the workspace permission granted, the case mutation matrix still
    // refuses: a VIEWER never mutates a case (A2-14, PRO-K1-04).
    const viewerMember = await prisma.teamMember.findUniqueOrThrow({
      where: { teamId_userId: { teamId: A.teamId, userId: A.viewerUserId } },
      select: { id: true },
    });
    await prisma.memberCapabilityGrant.create({
      data: {
        teamMemberId: viewerMember.id,
        teamId: A.teamId,
        permission: "evidence.update_metadata",
        grantedByUserId: A.ownerUserId,
      },
    });
    try {
      for (const [url, body] of writes) {
        const res = await call("POST", url, A.viewerToken, body);
        expect(res.statusCode, `${url} ${res.body}`).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: "permission_denied", reason: "case_mutation_denied" } });
      }
    } finally {
      await prisma.memberCapabilityGrant.deleteMany({ where: { teamMemberId: viewerMember.id } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("PRO-K1-03/04: reveal-pii — the case owner reaches step-up; a member who is not the owner and a creator demoted to VIEWER are refused", async () => {
    const A = h.fixtures.teamA;
    // Authorized path: the Enterprise case owner passes the capability and is
    // asked for the dedicated step-up (no fresh step-up on this session).
    const owner = await call("POST", `/v1/cases/${A.caseId}/siu-profile/reveal-pii`, A.ownerToken);
    expect(owner.statusCode, owner.body).toBe(401);
    expect(owner.body).toContain("STEP_UP_REQUIRED");

    const member = await call("POST", `/v1/cases/${A.caseId}/siu-profile/reveal-pii`, A.memberToken);
    expect(member.statusCode, member.body).toBe(403);
    expect(member.json()).toMatchObject({ error: { code: "siu_pii_capability_required" } });

    // A case the member created, after the member is demoted to VIEWER:
    // historical creator status is not authority (PRO-K1-04).
    const own = await prisma.case.create({
      data: { name: "member-created SIU case", teamId: A.teamId, ownerUserId: A.memberUserId },
      select: { id: true },
    });
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
      data: { role: "VIEWER" },
    });
    try {
      const demoted = await call("POST", `/v1/cases/${own.id}/siu-profile/reveal-pii`, A.memberToken);
      expect(demoted.statusCode, demoted.body).toBe(403);
      expect(demoted.json()).toMatchObject({
        error: { code: "siu_pii_capability_required", decisionReason: "denied_by_default" },
      });
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
        data: { role: "MEMBER" },
      });
    }
  });
});
