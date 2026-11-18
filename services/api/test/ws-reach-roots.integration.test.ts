/* eslint-disable @typescript-eslint/no-explicit-any -- test support reads Prisma delegates and JSON bodies of many shapes. */
/**
 * WS-REACH (cdcb8ae remediation) — the Medium roots of RG-11 / RG-12 / RG-19 on
 * real routes and PostgreSQL. Each refusal has the entitled caller's success
 * beside it. `off` is an OWNER of the workspace off the restricted case's
 * list; `listed` is an OWNER on it (ACC-01: workspace rank is not reach).
 *
 *   PRO-P1-01  Ops drill-down / workflows / causality / bulk follow record reach
 *   PRO-K2-02  mention fan-out follows the comment target's reach
 *   PRO-K1-02  a member cannot close a colleague's record into a restricted case
 *   PRO-T1-07  case unlink is the case owner's act, never with records linked
 *   PRO-K1-04  SIU writes: case matrix, PII capability, plan gate
 *   PRO-K1-01  a stored SIU bundle is released by what it contains
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Person } from "./support/coverage-actors.js";
import { RowFactory, RowSet, type Tenant } from "./support/write-sweep-engine.js";
import { enterpriseTenantMaker } from "./support/write-sweep-world.js";

describe("WS-REACH Medium roots (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let bulk: typeof import("../src/services/dashboard/bulk-actions.service.js");
  let kit: CoverageKit;
  let tenant: Tenant;
  let rows: RowSet;
  let off: Person;
  let listed: Person;
  let member: Person;
  let viewer: Person;
  let restrictedCase: string;
  let hiddenEvidence: string;
  const tag = () => randomUUID().slice(0, 8);
  const q = () => `teamId=${tenant.teamId}`;
  const headers = () => ({ "x-proovra-workspace-id": tenant.teamId });
  const get = (url: string, who: Person | { token: string }) => kit.call("GET", url, who, undefined, headers());
  const send = (method: string, url: string, who: Person | { token: string }, body: unknown = {}) =>
    kit.call(method, url, who, body, headers());
  const make = async (model: string, data: Record<string, unknown>) => {
    const fresh = new RowSet(rows.factory, prisma, tenant);
    const id = await rows.factory.make(fresh, model);
    if (!id) throw new Error(`fixture ${model}: ${rows.factory.failures.get(model)}`);
    const accessor = (prisma as any)[model.charAt(0).toLowerCase() + model.slice(1)];
    await accessor.update({ where: { id }, data });
    return id;
  };
  const record = async (ownerUserId: string) =>
    (
      await prisma.evidence.create({
        data: {
          title: `rec-${tag()}`,
          displayFileName: `rec-${tag()}.pdf`,
          type: "PHOTO",
          status: "SIGNED",
          teamId: tenant.teamId,
          organizationId: tenant.orgId,
          ownerUserId,
          sizeBytes: 1_000n,
        } as never,
        select: { id: true },
      })
    ).id;
  const teamCase = async (ownerUserId: string) =>
    (
      await prisma.case.create({
        data: { name: `ws-reach ${tag()}`, teamId: tenant.teamId, ownerUserId } as never,
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    bulk = await import("../src/services/dashboard/bulk-actions.service.js");
    kit = await coverageKit(h);
    tenant = await (await enterpriseTenantMaker(h))();
    rows = new RowSet(new RowFactory(prisma), prisma, tenant);
    off = await kit.person(tenant.teamId, "OWNER");
    listed = await kit.person(tenant.teamId, "OWNER");
    member = await kit.person(tenant.teamId, "MEMBER");
    viewer = await kit.person(tenant.teamId, "VIEWER");

    restrictedCase = await teamCase(listed.id);
    await prisma.case.update({ where: { id: restrictedCase }, data: { restrictedAtUtc: new Date() } });
    await prisma.caseAccess.create({ data: { caseId: restrictedCase, userId: listed.id } });
    hiddenEvidence = await record(listed.id);
    await prisma.caseEvidenceLink.create({
      data: { caseId: restrictedCase, evidenceId: hiddenEvidence, teamId: tenant.teamId } as never,
    });
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  describe("PRO-P1-01 — Operations sibling paths", () => {
    const sourceId = `ws-reach-src-${randomUUID().slice(0, 6)}`;
    let incident: string;
    let workflow: string;
    let chain: string;
    beforeAll(async () => {
      incident = await make("OperationalIncident", {
        teamId: tenant.teamId,
        relatedEvidenceId: hiddenEvidence,
        sourceId,
        status: "OPEN",
        severity: "CRITICAL",
      });
      workflow = await make("OperationalWorkflow", { teamId: tenant.teamId, evidenceId: hiddenEvidence, caseId: null });
      chain = await make("OperationalCausalityChain", {
        teamId: tenant.teamId,
        status: "ACTIVE",
        linkedEvidenceIds: [hiddenEvidence],
        linkedCaseIds: [],
      });
    });

    it("the group drill-down leaves out the condition for a closed record", async () => {
      const url = `/v1/ops/incident-groups/${sourceId}/affected?${q()}`;
      const mine = await get(url, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(incident);
      const theirs = await get(url, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(incident);
      expect(theirs.body).not.toContain(hiddenEvidence);
    });

    it("workflows: list omits, detail answers 404, a mutation answers 404", async () => {
      const mine = await get(`/v1/ops/workflows?${q()}`, listed);
      expect(mine.statusCode, mine.body).toBe(200);
      expect(mine.body).toContain(workflow);
      const theirs = await get(`/v1/ops/workflows?${q()}`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(workflow);
      expect((await get(`/v1/ops/workflows/${workflow}?${q()}`, off)).statusCode).toBe(404);
      expect((await get(`/v1/ops/workflows/${workflow}?${q()}`, listed)).statusCode).toBe(200);
      const escalate = await send("POST", `/v1/ops/workflows/${workflow}/mitigation`, off, {
        teamId: tenant.teamId,
        note: "off-list mitigation",
      });
      expect(escalate.statusCode, escalate.body).toBe(404);
    });

    it("causality chains naming a closed record are not listed or readable", async () => {
      const theirs = await get(`/v1/ops/causality/chains?${q()}`, off);
      expect(theirs.statusCode, theirs.body).toBe(200);
      expect(theirs.body).not.toContain(chain);
      expect((await get(`/v1/ops/causality/chains/${chain}?${q()}`, off)).statusCode).toBe(404);
      expect((await get(`/v1/ops/causality/chains/${chain}?${q()}`, listed)).statusCode).toBe(200);
    });

    it("a bulk acknowledge by an off-list actor skips the item and changes nothing", async () => {
      const run = await bulk.runBulkAction({
        teamId: tenant.teamId,
        actionType: "BULK_ACKNOWLEDGE_INCIDENTS",
        targetIds: [incident],
        actorUserId: off.id,
        note: "bulk ack",
      });
      expect(run.succeeded).toBe(0);
      const row = await prisma.operationalIncident.findUniqueOrThrow({ where: { id: incident } });
      expect(row.status).toBe("OPEN");
    });
  });

  it("PRO-K2-02 — @team on a restricted-case comment notifies only members who reach the case", async () => {
    const listed2 = await kit.person(tenant.teamId, "MEMBER");
    await prisma.caseAccess.create({ data: { caseId: restrictedCase, userId: listed2.id } });
    const groupId = (
      await prisma.collaborationTeam.create({
        data: { workspaceId: tenant.teamId, name: `group-${tag()}`, createdByUserId: listed.id } as never,
        select: { id: true },
      })
    ).id;
    for (const who of [listed, listed2, off]) {
      await prisma.collaborationTeamMember.create({ data: { teamId: groupId, userId: who.id, status: "ACTIVE" } as never });
    }
    const posted = await send("POST", `/v1/collaboration-teams/${groupId}/comments`, listed, {
      targetType: "CASE",
      targetId: restrictedCase,
      body: "@team restricted-sentinel text",
    });
    expect(posted.statusCode, posted.body).toBeLessThan(300);
    const note = (userId: string) => prisma.collaborationTeamNotification.count({ where: { teamId: groupId, userId } });
    expect(await note(listed2.id)).toBe(1);
    expect(await note(off.id)).toBe(0);
  });

  describe("PRO-K1-02 — restricted-case narrowing needs record authority (DEC-06)", () => {
    it("a MEMBER cannot link a colleague's record into their restricted case; their own record they can", async () => {
      const own = await teamCase(member.id);
      await prisma.case.update({ where: { id: own }, data: { restrictedAtUtc: new Date() } });
      await prisma.caseAccess.create({ data: { caseId: own, userId: member.id } });
      const colleagues = await record(tenant.owner.id);
      const refused = await send("POST", `/v1/cases/${own}/evidence`, member, { evidenceId: colleagues });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().code).toBe("CASE_RESTRICTED_LINK_MANAGER_REQUIRED");
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: own, evidenceId: colleagues } })).toBe(0);

      const mine = await record(member.id);
      const ok = await send("POST", `/v1/cases/${own}/evidence`, member, { evidenceId: mine });
      expect(ok.statusCode, ok.body).toBeLessThan(300);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: own, evidenceId: mine } })).toBe(1);
    });

    it("a MEMBER cannot restrict a case holding a colleague's record; a workspace admin on it can", async () => {
      const own = await teamCase(member.id);
      const colleagues = await record(tenant.owner.id);
      await prisma.caseEvidenceLink.create({ data: { caseId: own, evidenceId: colleagues, teamId: tenant.teamId } as never });
      const refused = await send("POST", `/v1/cases/${own}/access`, member, { userId: member.id });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().code).toBe("CASE_RESTRICTED_LINK_MANAGER_REQUIRED");
      const after = await prisma.case.findUniqueOrThrow({ where: { id: own }, select: { restrictedAtUtc: true } });
      expect(after.restrictedAtUtc).toBeNull();
      expect(await prisma.caseAccess.count({ where: { caseId: own } })).toBe(0);

      const ok = await send("POST", `/v1/cases/${own}/access`, tenant.owner, { userId: member.id });
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });

  describe("PRO-T1-07 — taking a case out of the workspace", () => {
    it("an ADMIN cannot detach someone else's case; the case stays in the workspace", async () => {
      const kase = await teamCase(tenant.owner.id);
      const res = await send("DELETE", `/v1/teams/${tenant.teamId}/cases/${kase}`, tenant.admin);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().code).toBe("CASE_UNLINK_OWNER_REQUIRED");
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase } })).teamId).toBe(tenant.teamId);
    });

    it("the owner cannot detach a case that still holds workspace records", async () => {
      const kase = await teamCase(tenant.owner.id);
      const ev = await record(tenant.owner.id);
      await prisma.caseEvidenceLink.create({ data: { caseId: kase, evidenceId: ev, teamId: tenant.teamId } as never });
      const res = await send("DELETE", `/v1/teams/${tenant.teamId}/cases/${kase}`, tenant.owner);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe("CASE_UNLINK_HAS_EVIDENCE");
      expect((await prisma.case.findUniqueOrThrow({ where: { id: kase } })).teamId).toBe(tenant.teamId);
    });
  });

  describe("PRO-K1-04 / PRO-K1-01 / B3C-F-007 — SIU", () => {
    let siuCase: string;
    beforeAll(async () => {
      siuCase = await teamCase(tenant.owner.id);
      const created = await send("PUT", `/v1/cases/${siuCase}/siu-profile`, tenant.owner, {
        claimType: "auto",
        claimantName: "Claimant Sentinel",
      });
      expect(created.statusCode, created.body).toBe(200);
    });

    it("a MEMBER edits non-PII fields but not claimant PII", async () => {
      const ok = await send("PUT", `/v1/cases/${siuCase}/siu-profile`, member, { claimType: "auto", claimNumber: "C-1" });
      expect(ok.statusCode, ok.body).toBe(200);
      const refused = await send("PUT", `/v1/cases/${siuCase}/siu-profile`, member, {
        claimType: "auto",
        claimantName: "Overwritten",
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe("siu_pii_capability_required");
      const row = await prisma.caseSiuProfile.findUniqueOrThrow({ where: { caseId: siuCase } });
      expect((row as any).claimantName).toBe("Claimant Sentinel");
    });

    it("a VIEWER cannot generate an export", async () => {
      const res = await send("POST", `/v1/cases/${siuCase}/siu-export`, viewer, {});
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error.reason).toBe("case_mutation_denied");
    });

    it("a legacy stored bundle (PII unknown, records unknown) is the generator's only", async () => {
      const profile = await prisma.caseSiuProfile.findUniqueOrThrow({ where: { caseId: siuCase }, select: { id: true } });
      const exportRow = await prisma.caseSiuExport.create({
        data: {
          siuProfileId: profile.id,
          caseId: siuCase,
          exportStatus: "generated",
          readinessState: "ready",
          generatedByUserId: tenant.owner.id,
        } as never,
        select: { id: true },
      });
      const theirs = await get(`/v1/cases/${siuCase}/siu-exports/${exportRow.id}/download`, member);
      expect(theirs.statusCode, theirs.body).toBe(404);
      expect(theirs.json().error.code).toBe("siu_export_not_found");
    });

    it("after a downgrade every SIU write answers CASES_NOT_INCLUDED", async () => {
      await prisma.team.update({ where: { id: tenant.teamId }, data: { billingPlan: "FREE", billingStatus: "ACTIVE" } as never });
      const res = await send("PUT", `/v1/cases/${siuCase}/siu-profile`, tenant.owner, { claimType: "auto", claimNumber: "C-2" });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().code).toBe("CASES_NOT_INCLUDED");
    });
  });
});
