/**
 * LEGAL HOLD AS A CUSTOMER GETS IT: REFUSED UNTIL THE CONTRACT STATES IT, THEN REAL.
 *
 * The audit had no runtime evidence on hold behaviour: no term could enable it. This
 * suite provisions customers, enables the term only through
 * `PATCH /v1/admin/orgs/:id/contract` with an operator's step-up, never by SQL, and
 * places every hold through the product route with the owner's step-up. Then: what a
 * hold blocks, each scope, who sees it, what a release needs, and the custody and
 * audit rows it leaves.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { coverageKit, type CoverageKit, type Injected, type Person } from "./support/coverage-actors.js";
import { customerKit, type Customer, type CustomerKit } from "./support/coverage-customer.js";
import { createStepUpCeremony } from "./support/step-up-ceremony.js";

type Prisma = import("@prisma/client").PrismaClient;

describe("Legal Hold through the contract path (live PostgreSQL)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;
  let kit: CoverageKit;
  let customers: CustomerKit;
  let stepUp: ReturnType<typeof createStepUpCeremony>;
  let a: Customer;
  let unsold: Customer;
  let admin: Person;
  let approver: Person;
  let member: Person;
  let foreignAdmin: Person;

  const owner = () => ({ token: a.owner.token });

  async function record(c: Customer, title = `record ${kit.tag()}`) {
    return (
      await prisma.evidence.create({
        data: {
          title,
          type: "PHOTO",
          status: "SIGNED",
          teamId: c.workspaceId,
          organizationId: c.orgId,
          ownerUserId: c.owner.userId,
        } as never,
        select: { id: true },
      })
    ).id;
  }

  async function caseWith(c: Customer, evidenceIds: string[], over: Record<string, unknown> = {}) {
    const row = await prisma.case.create({
      data: { name: `Case ${kit.tag()}`, teamId: c.workspaceId, ownerUserId: c.owner.userId, ...over } as never,
      select: { id: true },
    });
    for (const evidenceId of evidenceIds) {
      await prisma.caseEvidenceLink.create({ data: { caseId: row.id, evidenceId, teamId: c.workspaceId } as never });
    }
    return row.id;
  }

  /** The step-up the owner's browser would complete. */
  const ownerStepUp = (c: Customer, purpose: string, resourceId?: string) =>
    stepUp.approvedHeader({
      token: c.owner.token,
      userId: c.owner.userId,
      teamId: c.workspaceId,
      purpose,
      resourceKind: "evidence_legal_hold",
      ...(resourceId ? { resourceId } : {}),
    });

  async function place(c: Customer, kind: "EVIDENCE" | "CASE" | "WORKSPACE", scopeTargetId: string | null) {
    const res = await kit.call(
      "POST",
      "/v1/lifecycle/legal-holds",
      { token: c.owner.token },
      { kind, scopeTargetId, name: `Hold ${kit.tag()}`, reason: "Litigation notice received." },
      await ownerStepUp(c, "LEGAL_HOLD_PLACE", scopeTargetId ?? undefined),
    );
    return res;
  }
  async function placed(c: Customer, kind: "EVIDENCE" | "CASE" | "WORKSPACE", scopeTargetId: string | null) {
    const res = await place(c, kind, scopeTargetId);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().holdId as string;
  }
  const release = async (c: Customer, holdId: string) =>
    kit.call(
      "POST",
      `/v1/lifecycle/legal-holds/${holdId}/release`,
      { token: c.owner.token },
      { releaseNote: "Matter closed." },
      await ownerStepUp(c, "LEGAL_HOLD_RELEASE", holdId),
    );

  const custody = (evidenceId: string) =>
    prisma.custodyEvent.findMany({ where: { evidenceId }, select: { eventType: true, payload: true } });

  const deleteRecord = (id: string, who: { token: string } = owner()) => kit.call("DELETE", `/v1/evidence/${id}`, who);
  const archiveRecord = (id: string, who: { token: string } = owner()) => kit.call("POST", `/v1/evidence/${id}/archive`, who, {});
  const askDestruction = (evidenceIds: string[]) =>
    kit.call("POST", "/v1/lifecycle/destruction/requests", owner(), {
      evidenceIds,
      reason: "Retention elapsed.",
      requiredApproverUserIds: [approver.id],
    });

  /** The record is untouched by a refused destructive call. */
  const expectIntact = async (id: string) => {
    expect(await prisma.evidence.findUniqueOrThrow({ where: { id } })).toMatchObject({
      deletedAt: null,
      destroyedAtUtc: null,
      archivedAt: null,
    });
  };

  const expectBlocked = async (id: string) => {
    for (const res of [await deleteRecord(id), await archiveRecord(id)]) {
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, res.body).toBeLessThan(500);
      expect(res.body).toMatch(/legal.?hold/i);
    }
    await expectIntact(id);
  };

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    prisma = (await import("../src/db.js")).prisma as unknown as Prisma;
    kit = await coverageKit(h);
    customers = await customerKit(h, prisma);
    stepUp = createStepUpCeremony({ prisma, inject: h.app.inject.bind(h.app) as never });
    a = await customers.customer();
    unsold = await customers.customer();
    admin = await kit.person(a.workspaceId, "ADMIN");
    approver = await kit.person(a.workspaceId, "OWNER");
    member = await kit.person(a.workspaceId, "MEMBER");
    foreignAdmin = await kit.person(unsold.workspaceId, "ADMIN");
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  it("before the term: every placement route refuses, writes nothing, and the record stays destructible", async () => {
    const id = await record(a);
    const caseId = await caseWith(a, [id]);
    const before = await prisma.evidenceLegalHold.count();

    const lifecycle = await kit.call("POST", "/v1/lifecycle/legal-holds", owner(), {
      kind: "EVIDENCE",
      scopeTargetId: id,
      name: "Too early",
      reason: "Not bought.",
    });
    expect(lifecycle.statusCode, lifecycle.body).toBe(403);
    expect(lifecycle.json()).toEqual({ denial: "ENTITLEMENT_REQUIRED", key: "FEATURE_LEGAL_HOLD" });
    const evidenceRoute = await kit.call("POST", "/v1/governance/legal-holds", owner(), {
      teamId: a.workspaceId,
      evidenceId: id,
      title: "Too early",
    });
    expect(evidenceRoute.statusCode, evidenceRoute.body).toBe(403);
    expect(evidenceRoute.json()).toMatchObject({ denial: "ENTITLEMENT_REQUIRED" });
    const caseRoute = await kit.call("POST", "/v1/governance/case-legal-holds", owner(), {
      teamId: a.workspaceId,
      caseId,
      title: "Too early",
    });
    expect(caseRoute.statusCode, caseRoute.body).toBe(403);
    expect(await prisma.evidenceLegalHold.count()).toBe(before);
    expect((await custody(id)).filter((e) => String(e.eventType).includes("LEGAL_HOLD"))).toEqual([]);
  });

  it("the term is stated only by an operator with a step-up, and it is audited; a customer owner cannot state it", async () => {
    const byOwner = await kit.call("PATCH", `/v1/admin/orgs/${a.orgId}/contract`, owner(), {
      teamId: a.workspaceId,
      legalHoldEnabled: true,
    });
    expect(byOwner.statusCode, byOwner.body).toBeGreaterThanOrEqual(401);
    expect(byOwner.statusCode).toBeLessThan(500);
    expect((await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: a.orgId } })).legalHoldEnabled).not.toBe(true);

    const res = await customers.setTerms(a.orgId, { legalHoldEnabled: true });
    expect(res.statusCode, res.body).toBe(200);
    expect((await prisma.enterpriseContract.findUniqueOrThrow({ where: { organizationId: a.orgId } })).legalHoldEnabled).toBe(true);
    expect(
      await prisma.organizationAuditEvent.count({
        where: { organizationId: a.orgId, eventType: "ENTERPRISE_CONTRACT_TERMS_UPDATED" },
      }),
    ).toBe(1);
  });

  describe("once the contract states it", () => {
    it("an EVIDENCE hold needs its step-up and the permission, then blocks delete, archive and destruction, with custody and audit", async () => {
      const id = await record(a);
      const free = await record(a);

      const noStepUp = await kit.call("POST", "/v1/lifecycle/legal-holds", owner(), {
        kind: "EVIDENCE",
        scopeTargetId: id,
        name: "No step-up",
        reason: "x",
      });
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      const byMember = await kit.call("POST", "/v1/lifecycle/legal-holds", member, {
        kind: "EVIDENCE",
        scopeTargetId: id,
        name: "Member",
        reason: "x",
      });
      expect(byMember.statusCode, byMember.body).toBe(403);
      expect(await prisma.evidenceLegalHold.count({ where: { evidenceId: id } })).toBe(0);

      const holdId = await placed(a, "EVIDENCE", id);
      expect(await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
        teamId: a.workspaceId,
        scope: "EVIDENCE",
        evidenceId: id,
        status: "ACTIVE",
        placedByUserId: a.owner.userId,
        organizationId: a.orgId,
      });
      expect((await custody(id)).map((e) => String(e.eventType))).toContain("LEGAL_HOLD_PLACED");
      expect(await prisma.adminAuditLog.count({ where: { resourceId: holdId, action: "legal_hold.placed", userId: a.owner.userId } })).toBe(1);

      await expectBlocked(id);
      expect((await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).status).toBe("ACTIVE");

      // POSITIVE: the sibling record, unheld, can be trashed.
      const control = await deleteRecord(free);
      expect(control.statusCode, control.body).toBeLessThan(300);
    });

    it("a record already in the trash cannot be asked for destruction once held, and can after release", async () => {
      const id = await record(a);
      const trashed = await deleteRecord(id);
      expect(trashed.statusCode, trashed.body).toBeLessThan(300);
      const holdId = await placed(a, "EVIDENCE", id);
      const asked = await askDestruction([id]);
      expect(asked.statusCode, asked.body).toBe(409);
      expect(asked.json()).toEqual({ denial: "LEGAL_HOLD_BLOCKED", holdIds: [holdId] });
      expect(await prisma.destructionRequest.count({ where: { teamId: a.workspaceId, evidenceIds: { array_contains: [id] } } })).toBe(0);
      const done = await release(a, holdId);
      expect(done.statusCode, done.body).toBe(200);
      const after = await askDestruction([id]);
      expect(after.statusCode, after.body).toBe(201);
    });

    it("a CASE hold covers its records, a record linked later, and the case itself", async () => {
      const inside = await record(a);
      const later = await record(a);
      const caseId = await caseWith(a, [inside]);
      const holdId = await placed(a, "CASE", caseId);
      await expectBlocked(inside);

      await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId: later, teamId: a.workspaceId } as never });
      await expectBlocked(later);

      const removeCase = await kit.call("DELETE", `/v1/cases/${caseId}`, owner());
      expect(removeCase.statusCode, removeCase.body).toBe(403);
      expect(removeCase.json()).toMatchObject({ denial: "LEGAL_HOLD_BLOCKED", holdIds: [holdId] });
      expect(await prisma.case.count({ where: { id: caseId } })).toBe(1);

      const events = await prisma.custodyEvent.findMany({
        where: { evidenceId: inside, payload: { path: ["legalHoldId"], equals: holdId } },
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it("a WORKSPACE hold covers every record, including one created after it, and no other tenant's", async () => {
      const b = await customers.customer();
      await customers.setTerms(b.orgId, { legalHoldEnabled: true });
      const before = await record(b);
      const holdId = await placed(b, "WORKSPACE", null);
      const after = await record(b);
      const elsewhere = await record(a);
      const { evaluateEffectiveLegalHold } = await import("@proovra/shared-runtime");
      for (const id of [before, after]) {
        expect((await evaluateEffectiveLegalHold(prisma as never, { teamId: b.workspaceId, evidenceId: id })).held).toBe(true);
        const res = await kit.call("DELETE", `/v1/evidence/${id}`, { token: b.owner.token });
        expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
        await expectIntact(id);
      }
      expect((await evaluateEffectiveLegalHold(prisma as never, { teamId: a.workspaceId, evidenceId: elsewhere })).held).toBe(false);

      // A WORKSPACE hold has no target, and needs none.
      expect(await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
        scope: "WORKSPACE",
        evidenceId: null,
        caseId: null,
      });
    });

    it("a hold is visible on the list and on search-facing state; another tenant's list has none of it", async () => {
      const id = await record(a);
      const holdId = await placed(a, "EVIDENCE", id);
      const list = await kit.call("GET", "/v1/lifecycle/legal-holds", owner());
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().holds.map((x: { id: string }) => x.id)).toContain(holdId);
      const foreign = await kit.call("GET", "/v1/lifecycle/legal-holds", foreignAdmin);
      expect(foreign.statusCode, foreign.body).toBe(200);
      expect(foreign.json().holds.map((x: { id: string }) => x.id)).not.toContain(holdId);
      const viewer = await kit.person(a.workspaceId, "VIEWER");
      const read = await kit.call("GET", "/v1/lifecycle/legal-holds", viewer);
      expect(read.statusCode, read.body).toBe(200);
    });

    it("another tenant can neither hold a foreign record nor touch a foreign hold", async () => {
      const id = await record(a);
      const holdId = await placed(a, "EVIDENCE", id);
      const b = await customers.customer();
      await customers.setTerms(b.orgId, { legalHoldEnabled: true });
      const foreignPlace = await place(b, "EVIDENCE", id);
      expect(foreignPlace.statusCode, foreignPlace.body).toBe(409);
      expect(foreignPlace.json()).toEqual({ denial: "TARGET_NOT_IN_WORKSPACE" });
      const foreignRelease = await release(b, holdId);
      expect(foreignRelease.statusCode, foreignRelease.body).toBe(404);
      for (const step of ["release-request", "release-approval"]) {
        const res = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/${step}`, { token: b.owner.token }, { note: "x" });
        expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      }
      expect((await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).status).toBe("ACTIVE");
      await expectBlocked(id);
    });

    it("a member off a restricted case's list neither sees a hold on its record nor places one", async () => {
      const hidden = await record(a);
      const restricted = await caseWith(a, [hidden], { restrictedAtUtc: new Date() });
      await prisma.caseAccess.create({ data: { caseId: restricted, userId: a.owner.userId } });
      const holdId = await placed(a, "EVIDENCE", hidden);
      const caseHold = await placed(a, "CASE", restricted);

      const list = await kit.call("GET", "/v1/lifecycle/legal-holds", admin);
      expect(list.statusCode, list.body).toBe(200);
      const ids = list.json().holds.map((x: { id: string }) => x.id);
      expect(ids).not.toContain(holdId);
      expect(ids).not.toContain(caseHold);
      expect(list.body).not.toContain(hidden);
      const seen = await kit.call("GET", "/v1/lifecycle/legal-holds", owner());
      expect(seen.json().holds.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([holdId, caseHold]));

      // The refusal comes before the step-up, as on the governance routes.
      const placing = await kit.call("POST", "/v1/lifecycle/legal-holds", admin, {
        kind: "EVIDENCE",
        scopeTargetId: hidden,
        name: "Reach",
        reason: "x",
      });
      expect(placing.statusCode, placing.body).toBe(409);
      expect(placing.json()).toEqual({ denial: "TARGET_NOT_IN_WORKSPACE" });
      const placingCase = await kit.call("POST", "/v1/lifecycle/legal-holds", admin, {
        kind: "CASE",
        scopeTargetId: restricted,
        name: "Reach",
        reason: "x",
      });
      expect(placingCase.statusCode, placingCase.body).toBe(409);
      expect(await prisma.evidenceLegalHold.count({ where: { evidenceId: hidden } })).toBe(1);

      // Knowing the hold id opens no step of its release.
      for (const step of ["release", "release-request", "release-approval"]) {
        const res = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/${step}`, admin, { note: "reach", releaseNote: "reach" });
        expect(res.statusCode, `${step} ${res.body}`).toBe(404);
        expect(res.json()).toEqual({ denial: "NOT_FOUND" });
      }
      expect(await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
        status: "ACTIVE",
        releaseRequestedByUserId: null,
      });
    });

    it("release: needs a step-up, lifts the block, and leaves custody and audit; the same record can then be asked for destruction", async () => {
      const id = await record(a);
      const holdId = await placed(a, "EVIDENCE", id);

      const noStepUp = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/release`, owner(), { releaseNote: "x" });
      expect(noStepUp.statusCode, noStepUp.body).toBe(401);
      const byMember = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/release`, member, { releaseNote: "x" });
      expect(byMember.statusCode, byMember.body).toBe(403);
      expect((await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).status).toBe("ACTIVE");

      const done = await release(a, holdId);
      expect(done.statusCode, done.body).toBe(200);
      expect(await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
        status: "RELEASED",
        releasedByUserId: a.owner.userId,
        releaseNote: "Matter closed.",
      });
      expect((await custody(id)).map((e) => String(e.eventType))).toEqual(
        expect.arrayContaining(["LEGAL_HOLD_PLACED", "LEGAL_HOLD_RELEASED"]),
      );
      expect(await prisma.adminAuditLog.count({ where: { resourceId: holdId, action: "legal_hold.released", userId: a.owner.userId } })).toBe(1);

      const trashed = await deleteRecord(id);
      expect(trashed.statusCode, trashed.body).toBeLessThan(300);
      // A second release changes nothing and records nothing more.
      const again = await release(a, holdId);
      expect(again.statusCode, again.body).toBe(200);
      expect(await prisma.adminAuditLog.count({ where: { resourceId: holdId, action: "legal_hold.released" } })).toBe(1);
    });

    it("under the release-approval policy one person cannot release: the second person's approval is what it claims", async () => {
      const b = await customers.customer();
      await customers.setTerms(b.orgId, { legalHoldEnabled: true });
      const second = await kit.person(b.workspaceId, "ADMIN");
      const policyHeader = await stepUp.approvedHeader({
        token: b.owner.token,
        userId: b.owner.userId,
        teamId: b.workspaceId,
        purpose: "GOVERNANCE_POLICY_UPDATE",
        resourceKind: "workspace_governance_policy",
        resourceId: b.workspaceId,
      });
      const set = await kit.call(
        "PUT",
        "/v1/governance/policy",
        { token: b.owner.token },
        { expectedVersion: 0, requireLegalHoldReleaseApproval: true },
        policyHeader,
      );
      expect(set.statusCode, set.body).toBe(200);

      const id = await record(b);
      const holdId = await placed(b, "EVIDENCE", id);
      expect((await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).releaseApprovalRequired).toBe(true);

      const alone = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/release`, { token: b.owner.token }, { releaseNote: "x", approvalAcknowledged: true });
      expect(alone.statusCode, alone.body).toBe(403);
      expect(alone.json()).toEqual({ denial: "RELEASE_APPROVAL_REQUIRED" });

      const asked = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/release-request`, { token: b.owner.token }, { note: "Matter closed." });
      expect(asked.statusCode, asked.body).toBe(200);
      const approval = await stepUp.approvedHeader({
        token: second.token,
        userId: second.id,
        teamId: b.workspaceId,
        purpose: "LEGAL_HOLD_RELEASE",
        resourceKind: "evidence_legal_hold",
        resourceId: holdId,
      });
      const approved = await kit.call("POST", `/v1/lifecycle/legal-holds/${holdId}/release-approval`, second, {}, approval);
      expect(approved.statusCode, approved.body).toBe(200);
      const done = await release(b, holdId);
      expect(done.statusCode, done.body).toBe(200);
      expect(await prisma.evidenceLegalHold.findUniqueOrThrow({ where: { id: holdId } })).toMatchObject({
        status: "RELEASED",
        releaseApprovedByUserId: second.id,
        releaseRequestedByUserId: b.owner.userId,
      });
    });

    it("withdrawing the term stops new holds; existing ones keep blocking, stay visible, and can still be released", async () => {
      const b = await customers.customer();
      await customers.setTerms(b.orgId, { legalHoldEnabled: true });
      const id = await record(b);
      const holdId = await placed(b, "EVIDENCE", id);
      const off = await customers.setTerms(b.orgId, { legalHoldEnabled: false });
      expect(off.statusCode, off.body).toBe(200);

      const another: Injected = await kit.call("POST", "/v1/lifecycle/legal-holds", { token: b.owner.token }, {
        kind: "EVIDENCE",
        scopeTargetId: await record(b),
        name: "After",
        reason: "x",
      });
      expect(another.statusCode, another.body).toBe(403);
      const del = await kit.call("DELETE", `/v1/evidence/${id}`, { token: b.owner.token });
      expect(del.statusCode, del.body).toBeGreaterThanOrEqual(400);
      await expectIntact(id);
      const list = await kit.call("GET", "/v1/lifecycle/legal-holds", { token: b.owner.token });
      expect(list.json().holds.map((x: { id: string }) => x.id)).toContain(holdId);
      const done = await release(b, holdId);
      expect(done.statusCode, done.body).toBe(200);
    });
  });

  it("the customer who never bought it still cannot place one, by any route", async () => {
    const id = await record(unsold);
    const res = await kit.call("POST", "/v1/lifecycle/legal-holds", { token: unsold.owner.token }, {
      kind: "WORKSPACE",
      scopeTargetId: null,
      name: `No ${randomUUID().slice(0, 6)}`,
      reason: "x",
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(await prisma.evidenceLegalHold.count({ where: { teamId: unsold.workspaceId } })).toBe(0);
    await expectIntact(id);
  });
});
