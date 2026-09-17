/**
 * BATCH K4 (part A) — runtime proof for the case (matter) mutations and the
 * external reviewer portal mutations the UI sweep could not drive to their
 * success branch.
 *
 * Every action is proven three ways against a disposable PostgreSQL 16:
 *   1. the authorized SUCCESS branch, with the payload the product consumer
 *      sends, re-reading the exact row/column the action exists to change;
 *   2. the AUDIT record where the route writes one;
 *   3. an EXPECTED REFUSAL with its bounded status/code and no durable effect.
 *
 * Payloads come from the real consumers:
 *   - apps/web/components/cases-experience/MatterWorkspace.tsx      (DELETE assignment)
 *   - apps/web/components/cases-experience/simple-case-detail/SimpleCaseDetail.tsx
 *                                   (DELETE comment, DELETE case evidence, DELETE case)
 *   - apps/web/components/cases-experience/CasesIndex.tsx          (POST /v1/cases/bulk)
 *   - apps/web/lib/external-portal/portal-client.ts                (portal comment/decision/view)
 * Routes with no current web consumer (evidence-links/:linkId,
 * legacy-evidence-link, access/:accessId) take their contract from the route's
 * zod params (path-only, no body).
 *
 * The case-access grant route has known defects the lead is fixing; the access
 * row the revoke test removes is therefore SEEDED, never granted through it.
 *
 * `auditCaseAction` in cases.routes.ts is fire-and-forget (`void
 * emitTenantAudit(...)`); those rows are read with `expect.poll` — a bounded
 * wait for a write the product already dispatched, never a retry of the action.
 */

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

type Prisma = (typeof import("../src/db.js"))["prisma"];

describe("K4-A — cases and external portal (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: Prisma;

  const call = (opts: {
    method: "GET" | "POST" | "PATCH" | "DELETE";
    url: string;
    token?: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }) =>
    h.app.inject({
      method: opts.method,
      url: opts.url,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}),
    });

  const tag = () => randomUUID().slice(0, 8);

  const auditRow = (action: string, resourceId: string) =>
    prisma.adminAuditLog.findFirst({
      where: { action, resourceId },
      orderBy: { createdAt: "desc" },
    });

  /** `auditCaseAction` is `void emitTenantAudit(...)` — fire-and-forget. */
  const pollAudit = (action: string, resourceId: string, outcome = "success") =>
    expect.poll(
      () =>
        prisma.adminAuditLog.findFirst({
          where: { action, resourceId, outcome },
          orderBy: { createdAt: "desc" },
          select: { userId: true, workspaceId: true, outcome: true, resourceType: true, metadata: true },
        }),
      { timeout: 10_000, interval: 25 },
    );

  async function newCase(teamId: string, ownerUserId: string) {
    return prisma.case.create({
      data: { name: `k4 case ${tag()}`, teamId, ownerUserId },
      select: { id: true },
    });
  }

  async function newEvidence(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { organizationId: true },
    });
    return prisma.evidence.create({
      data: {
        title: `k4 evidence ${tag()}`,
        type: "PHOTO",
        status: "SIGNED",
        mimeType: "image/jpeg",
        teamId,
        organizationId: team.organizationId,
        ownerUserId,
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 900_000);

  afterAll(async () => {
    await h?.cleanup();
  }, 300_000);

  // ===========================================================================
  // DELETE /v1/cases/:id/assignments/:assignmentId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/assignments/:assignmentId", () => {
    it("workspace ADMIN removes an assignment; row REMOVED + audited; MEMBER and other tenant refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const created = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/assignments`,
        token: a.ownerToken,
        payload: { assignedToUserId: a.memberUserId, role: "INVESTIGATOR" },
      });
      expect(created.statusCode, created.body).toBe(200);
      const assignmentId = created.json().assignment.id as string;
      const url = `/v1/cases/${c.id}/assignments/${assignmentId}`;

      // Refusals first — nothing may change.
      const member = await call({ method: "DELETE", url, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      expect(member.json().error.code).toBe("forbidden");
      const foreign = await call({ method: "DELETE", url, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(
        (await prisma.caseAssignment.findUniqueOrThrow({ where: { id: assignmentId } })).status,
      ).toBe("ACTIVE");

      const ok = await call({ method: "DELETE", url, token: a.adminToken });
      expect(ok.statusCode, ok.body).toBe(200);
      const row = await prisma.caseAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
      expect(row.status).toBe("REMOVED");
      expect(row.removedByUserId).toBe(a.adminUserId);
      expect(row.removedAtUtc).toBeInstanceOf(Date);
      const audit = await auditRow("cases.assignment_removed", assignmentId);
      expect(audit).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "case_assignment",
      });
      expect((audit?.metadata as Record<string, unknown>).caseId).toBe(c.id);
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id/comments/:commentId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/comments/:commentId", () => {
    it("the author deletes their note; row gone + audited; non-author, VIEWER and other tenant refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const posted = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/comments`,
        token: a.memberToken,
        payload: { body: "Initial triage note" },
      });
      expect(posted.statusCode, posted.body).toBe(200);
      const commentId = posted.json().comment.id as string;
      const url = `/v1/cases/${c.id}/comments/${commentId}`;

      const admin = await call({ method: "DELETE", url, token: a.adminToken });
      expect(admin.statusCode).toBe(403);
      expect(admin.json()).toEqual({ error: { code: "comment_forbidden" } });
      const viewer = await call({ method: "DELETE", url, token: a.viewerToken });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json().error.code).toBe("forbidden");
      const foreign = await call({ method: "DELETE", url, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(await prisma.caseComment.count({ where: { id: commentId } })).toBe(1);

      const ok = await call({ method: "DELETE", url, token: a.memberToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ removed: true, commentId });
      expect(await prisma.caseComment.count({ where: { id: commentId } })).toBe(0);
      const audit = await auditRow("cases.comment_deleted", commentId);
      expect(audit).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "case_comment",
      });
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id/legacy-evidence-link/:evidenceId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/legacy-evidence-link/:evidenceId", () => {
    it("is unreachable by design (legacy Evidence.caseId was dropped): every persona is refused and nothing changes", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const linkedEvidence = await newEvidence(a.teamId, a.ownerUserId);
      const unlinkedEvidence = await newEvidence(a.teamId, a.ownerUserId);
      const link = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/evidence-links`,
        token: a.ownerToken,
        payload: { evidenceId: linkedEvidence.id, role: "SUPPORTING" },
      });
      expect(link.statusCode, link.body).toBe(200);

      // The case OWNER — the most privileged persona — with a canonical link.
      const canonical = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/legacy-evidence-link/${linkedEvidence.id}`,
        token: a.ownerToken,
      });
      expect(canonical.statusCode).toBe(409);
      expect(canonical.json()).toEqual({ error: { code: "evidence_link_exists" } });
      // ...and with no binding at all (no legacy column exists any more).
      const nothing = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/legacy-evidence-link/${unlinkedEvidence.id}`,
        token: a.ownerToken,
      });
      expect(nothing.statusCode).toBe(404);
      expect(nothing.json()).toEqual({ error: { code: "evidence_not_found" } });
      const viewer = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/legacy-evidence-link/${linkedEvidence.id}`,
        token: a.viewerToken,
      });
      expect(viewer.statusCode).toBe(403);
      const foreign = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/legacy-evidence-link/${linkedEvidence.id}`,
        token: b.ownerToken,
      });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });

      // Zero mutation: the canonical link and both evidence rows are intact.
      expect(
        await prisma.caseEvidenceLink.count({ where: { caseId: c.id, evidenceId: linkedEvidence.id } }),
      ).toBe(1);
      expect(
        await prisma.evidence.count({ where: { id: { in: [linkedEvidence.id, unlinkedEvidence.id] }, teamId: a.teamId } }),
      ).toBe(2);
      expect(
        await prisma.adminAuditLog.count({ where: { action: { contains: "legacy" }, resourceId: c.id } }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id/evidence-links/:linkId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/evidence-links/:linkId", () => {
    it("a workspace MEMBER unlinks evidence; link row gone + audited; VIEWER and other tenant refused", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const ev = await newEvidence(a.teamId, a.ownerUserId);
      const link = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/evidence-links`,
        token: a.ownerToken,
        payload: { evidenceId: ev.id, role: "PRIMARY", reason: "Scene photo" },
      });
      expect(link.statusCode, link.body).toBe(200);
      const linkId = link.json().link.id as string;
      const url = `/v1/cases/${c.id}/evidence-links/${linkId}`;

      const viewer = await call({ method: "DELETE", url, token: a.viewerToken });
      expect(viewer.statusCode).toBe(403);
      expect(viewer.json().error.code).toBe("forbidden");
      const foreign = await call({ method: "DELETE", url, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ error: { code: "not_found" } });
      expect(await prisma.caseEvidenceLink.count({ where: { id: linkId } })).toBe(1);

      const ok = await call({ method: "DELETE", url, token: a.memberToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toEqual({ removed: true });
      expect(await prisma.caseEvidenceLink.count({ where: { id: linkId } })).toBe(0);
      // The evidence itself is untouched and stays in the workspace.
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } })).teamId).toBe(a.teamId);
      const audit = await auditRow("cases.evidence_unlinked", linkId);
      expect(audit).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "case_evidence_link",
      });
      expect(audit?.metadata as Record<string, unknown>).toMatchObject({
        caseId: c.id,
        evidenceId: ev.id,
        removedLinkCount: 1,
        linkId,
      });
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id
  // ===========================================================================
  describe("DELETE /v1/cases/:id", () => {
    it("workspace ADMIN deletes a case; row and links gone + audited; MEMBER refused 403; other tenant concealed 404", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const ev = await newEvidence(a.teamId, a.ownerUserId);
      const link = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/evidence-links`,
        token: a.ownerToken,
        payload: { evidenceId: ev.id },
      });
      expect(link.statusCode, link.body).toBe(200);

      const member = await call({ method: "DELETE", url: `/v1/cases/${c.id}`, token: a.memberToken });
      expect(member.statusCode).toBe(403);
      expect(member.json().code).toBe("CASE_DELETE_DENIED");
      const foreign = await call({ method: "DELETE", url: `/v1/cases/${c.id}`, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ message: "Case not found" });
      expect(await prisma.case.count({ where: { id: c.id } })).toBe(1);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id } })).toBe(1);

      const ok = await call({ method: "DELETE", url: `/v1/cases/${c.id}`, token: a.adminToken });
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await prisma.case.count({ where: { id: c.id } })).toBe(0);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id } })).toBe(0);
      expect(await prisma.evidence.count({ where: { id: ev.id } })).toBe(1);
      await pollAudit("cases.delete", c.id).toMatchObject({
        userId: a.adminUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "case",
      });
    });

    it("a case under legal hold does not reveal its hold to another tenant", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const hold = await prisma.evidenceLegalHold.create({
        data: {
          teamId: a.teamId,
          scope: "CASE",
          caseId: c.id,
          title: "k4 preservation",
          placedByUserId: a.ownerUserId,
        },
        select: { id: true },
      });
      try {
        const foreign = await call({ method: "DELETE", url: `/v1/cases/${c.id}`, token: b.ownerToken });
        expect(foreign.statusCode).toBe(404);
        expect(foreign.body).not.toContain(hold.id);
        const owner = await call({ method: "DELETE", url: `/v1/cases/${c.id}`, token: a.ownerToken });
        expect(owner.statusCode).toBe(403);
        expect(owner.json().denial).toBe("LEGAL_HOLD_BLOCKED");
        expect(await prisma.case.count({ where: { id: c.id } })).toBe(1);
      } finally {
        await prisma.evidenceLegalHold.delete({ where: { id: hold.id } });
      }
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id/evidence/:evidenceId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/evidence/:evidenceId", () => {
    it("a workspace MEMBER removes evidence from a case; link gone + audited; VIEWER refused 403; other tenant concealed 404", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const ev = await newEvidence(a.teamId, a.ownerUserId);
      const link = await call({
        method: "POST",
        url: `/v1/cases/${c.id}/evidence-links`,
        token: a.ownerToken,
        payload: { evidenceId: ev.id },
      });
      expect(link.statusCode, link.body).toBe(200);
      const url = `/v1/cases/${c.id}/evidence/${ev.id}`;

      const viewer = await call({ method: "DELETE", url, token: a.viewerToken });
      expect(viewer.statusCode).toBe(403);
      const foreign = await call({ method: "DELETE", url, token: b.ownerToken });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json()).toEqual({ message: "Case not found" });
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id, evidenceId: ev.id } })).toBe(1);

      const ok = await call({ method: "DELETE", url, token: a.memberToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().evidence).toMatchObject({ id: ev.id, caseId: null, teamId: null });
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id, evidenceId: ev.id } })).toBe(0);
      // Historical route semantics (clearEvidenceTeamIdWhenUnlinked): leaving
      // its only case returns the record to the uploader's personal pool.
      expect((await prisma.evidence.findUniqueOrThrow({ where: { id: ev.id } })).teamId).toBeNull();
      const unlinked = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "cases.evidence_unlinked", workspaceId: a.teamId, userId: a.memberUserId },
        orderBy: { createdAt: "desc" },
      });
      expect(unlinked.metadata as Record<string, unknown>).toMatchObject({ caseId: c.id, evidenceId: ev.id });
      await pollAudit("cases.remove_evidence", c.id).toMatchObject({
        userId: a.memberUserId,
        workspaceId: a.teamId,
        outcome: "success",
      });
    });
  });

  // ===========================================================================
  // POST /v1/cases/:id/evidence — D50
  // ===========================================================================
  describe("POST /v1/cases/:id/evidence", () => {
    it("a workspace MEMBER attaches their evidence; a VIEWER is refused 403 and another tenant is concealed 404, with nothing linked", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const url = `/v1/cases/${c.id}/evidence`;

      // The route attaches only the caller's own evidence, so each actor
      // brings a record they own.
      const viewerEv = await newEvidence(a.teamId, a.viewerUserId);
      const viewer = await call({ method: "POST", url, token: a.viewerToken, payload: { evidenceId: viewerEv.id } });
      expect(viewer.statusCode, viewer.body).toBe(403);
      const foreignEv = await newEvidence(b.teamId, b.ownerUserId);
      const foreign = await call({ method: "POST", url, token: b.ownerToken, payload: { evidenceId: foreignEv.id } });
      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(foreign.json()).toEqual({ message: "Case not found" });
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id } })).toBe(0);

      const memberEv = await newEvidence(a.teamId, a.memberUserId);
      const ok = await call({ method: "POST", url, token: a.memberToken, payload: { evidenceId: memberEv.id } });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await prisma.caseEvidenceLink.count({ where: { caseId: c.id, evidenceId: memberEv.id } })).toBe(1);
    });
  });

  // ===========================================================================
  // DELETE /v1/cases/:id/access/:accessId
  // ===========================================================================
  describe("DELETE /v1/cases/:id/access/:accessId", () => {
    it("the case owner revokes a direct-access grant; row gone + audited; a non-owner ADMIN is refused", async () => {
      const a = h.fixtures.teamA;
      const c = await newCase(a.teamId, a.ownerUserId);
      // Seeded — the grant route is being reworked by the lead.
      const access = await prisma.caseAccess.create({
        data: { caseId: c.id, userId: a.memberUserId },
        select: { id: true },
      });
      const url = `/v1/cases/${c.id}/access/${access.id}`;

      const admin = await call({ method: "DELETE", url, token: a.adminToken });
      expect(admin.statusCode).toBe(403);
      expect(admin.json()).toEqual({ message: "Forbidden" });
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(1);

      const ok = await call({ method: "DELETE", url, token: a.ownerToken });
      expect(ok.statusCode, ok.body).toBe(204);
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(0);
      await pollAudit("cases.access_revoke", c.id).toMatchObject({
        userId: a.ownerUserId,
        workspaceId: a.teamId,
        outcome: "success",
        resourceType: "case",
      });
      const row = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "cases.access_revoke", resourceId: c.id, outcome: "success" },
      });
      expect(row.metadata as Record<string, unknown>).toMatchObject({
        accessId: access.id,
        targetUserId: a.memberUserId,
      });
    });

    it("another tenant's owner is refused and the grant survives (status observed for the lead)", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const c = await newCase(a.teamId, a.ownerUserId);
      const access = await prisma.caseAccess.create({
        data: { caseId: c.id, userId: a.memberUserId },
        select: { id: true },
      });
      const foreign = await call({
        method: "DELETE",
        url: `/v1/cases/${c.id}/access/${access.id}`,
        token: b.ownerToken,
      });
      // DEFECT_FOR_LEAD — the family conceals cross-tenant existence (404)
      // elsewhere; this handler answers 403 for an existing case. Pinned as
      // observed so the lead's access-route rework flips it deliberately.
      expect(foreign.statusCode).toBe(403);
      expect(await prisma.caseAccess.count({ where: { id: access.id } })).toBe(1);
    });
  });

  // ===========================================================================
  // POST /v1/cases/bulk
  // ===========================================================================
  describe("POST /v1/cases/bulk", () => {
    it("a MEMBER bulk-closes accessible cases; status + history re-read; summary audited", async () => {
      const a = h.fixtures.teamA;
      const one = await newCase(a.teamId, a.ownerUserId);
      const two = await newCase(a.teamId, a.ownerUserId);
      const res = await call({
        method: "POST",
        url: "/v1/cases/bulk",
        token: a.memberToken,
        payload: { ids: [one.id, two.id], action: "CLOSE", reason: "Duplicate intake" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().results).toEqual([
        { id: one.id, outcome: "SUCCESS" },
        { id: two.id, outcome: "SUCCESS" },
      ]);
      for (const id of [one.id, two.id]) {
        const row = await prisma.case.findUniqueOrThrow({ where: { id } });
        expect(row.status).toBe("CLOSED");
        expect(row.closureReason).toBe("Duplicate intake");
        const history = await prisma.caseStatusHistory.findFirstOrThrow({ where: { caseId: id } });
        expect(history).toMatchObject({ fromStatus: "OPEN", toStatus: "CLOSED", changedByUserId: a.memberUserId });
        const perCase = await auditRow("cases.status_changed", id);
        expect(perCase).toMatchObject({ userId: a.memberUserId, workspaceId: a.teamId, outcome: "success" });
      }
      const summary = await prisma.adminAuditLog.findFirstOrThrow({
        where: { action: "cases.bulk_status_changed", userId: a.memberUserId },
        orderBy: { createdAt: "desc" },
      });
      expect(summary.outcome).toBe("success");
      expect(summary.workspaceId).toBeNull();
      expect(summary.metadata as Record<string, unknown>).toMatchObject({
        action: "CLOSE",
        requestedCount: 2,
        successCount: 2,
        skippedCount: 0,
        targetStatus: "CLOSED",
      });
    });

    it("another tenant's cases are skipped as not_accessible and a VIEWER cannot bulk-mutate", async () => {
      const a = h.fixtures.teamA;
      const b = h.fixtures.teamB;
      const target = await newCase(a.teamId, a.ownerUserId);

      const foreign = await call({
        method: "POST",
        url: "/v1/cases/bulk",
        token: b.ownerToken,
        payload: { ids: [target.id], action: "CLOSE" },
      });
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json().results).toEqual([
        { id: target.id, outcome: "SKIPPED", reason: "not_accessible" },
      ]);

      const viewer = await call({
        method: "POST",
        url: "/v1/cases/bulk",
        token: a.viewerToken,
        payload: { ids: [target.id], action: "RESOLVE" },
      });
      expect(viewer.statusCode).toBe(200);
      expect(viewer.json().results).toEqual([
        { id: target.id, outcome: "SKIPPED", reason: "forbidden" },
      ]);

      const row = await prisma.case.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.status).toBe("OPEN");
      expect(await prisma.caseStatusHistory.count({ where: { caseId: target.id } })).toBe(0);
    });
  });

  // ===========================================================================
  // External reviewer portal — /v1/portal/work/:workflowId/*
  // ===========================================================================
  describe("external reviewer portal", () => {
    type Grant = { grantId: string; rawToken: string; sessionId?: string };
    let evidenceInScope: string;
    let workflowInScope: string;
    let workflowOutOfScope: string;
    let reviewer: Grant;
    let observer: Grant;

    async function workflowFor(teamId: string, evidenceId: string) {
      return (
        await prisma.evidenceReviewWorkflow.create({
          data: { evidenceId, teamId, workspaceType: "TEAM" },
          select: { id: true },
        })
      ).id;
    }

    async function issue(role: "EXTERNAL_REVIEWER" | "EXTERNAL_OBSERVER"): Promise<Grant> {
      const a = h.fixtures.teamA;
      const { issueInvitation } = await import(
        "../src/services/external-review/portal-invitation.service.js"
      );
      const res = await issueInvitation({
        teamId: a.teamId,
        invitedByUserId: a.ownerUserId,
        reviewerEmail: `k4-${role.toLowerCase()}-${tag()}@test.proovra.local`,
        reviewerDisplayName: "Outside Counsel",
        role,
        scope: { kind: "EVIDENCE", evidenceId: evidenceInScope },
        expiresAtUtc: new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      });
      if (!res.ok) throw new Error(`grant issue failed: ${res.denial}`);
      const grant: Grant = { grantId: res.grantId, rawToken: res.rawToken };
      // portal-client.ts `authenticate` — the token exchange that accepts the
      // invitation and mints the session id every later call carries.
      const auth = await portal(grant, "/v1/portal/auth", { token: res.rawToken });
      expect(auth.statusCode, auth.body).toBe(200);
      expect(auth.json()).toMatchObject({ newLogin: true, role });
      grant.sessionId = auth.json().sessionId as string;
      expect(grant.sessionId).toMatch(/^[0-9a-f]{32}$/);
      const row = await prisma.externalReviewGrant.findUniqueOrThrow({ where: { id: res.grantId } });
      expect(row.state).toBe("ACTIVE");
      return grant;
    }

    /**
     * portal-client.ts `portalFetch`: bearer = raw token, `x-portal-session`
     * once authenticated, and `content-type: application/json` ALWAYS — also
     * on the body-less view POST.
     */
    const portal = (grant: Grant, url: string, body?: unknown) =>
      h.app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${grant.rawToken}`,
          "content-type": "application/json",
          ...(grant.sessionId ? { "x-portal-session": grant.sessionId } : {}),
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });

    beforeAll(async () => {
      const a = h.fixtures.teamA;
      evidenceInScope = (await newEvidence(a.teamId, a.ownerUserId)).id;
      workflowInScope = await workflowFor(a.teamId, evidenceInScope);
      workflowOutOfScope = await workflowFor(a.teamId, (await newEvidence(a.teamId, a.ownerUserId)).id);
      reviewer = await issue("EXTERNAL_REVIEWER");
      observer = await issue("EXTERNAL_OBSERVER");
    });

    it("POST /v1/portal/work/:id/comments — an EXTERNAL_REVIEWER posts; comment row + COMMENT_POSTED activity re-read", async () => {
      const a = h.fixtures.teamA;
      const res = await portal(reviewer, `/v1/portal/work/${workflowInScope}/comments`, {
        body: "Frame 3 shows the timestamp overlay.",
      });
      expect(res.statusCode, res.body).toBe(201);
      const commentId = res.json().commentId as string;
      const row = await prisma.externalReviewComment.findUniqueOrThrow({ where: { id: commentId } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        grantId: reviewer.grantId,
        workflowId: workflowInScope,
        body: "Frame 3 shows the timestamp overlay.",
        authorDisplay: "Outside Counsel",
        parentCommentId: null,
      });
      const activity = await prisma.externalReviewActivity.findFirstOrThrow({
        where: { grantId: reviewer.grantId, code: "COMMENT_POSTED" },
        orderBy: { occurredAtUtc: "desc" },
      });
      expect(activity.teamId).toBe(a.teamId);
      expect(activity.payload).toMatchObject({ workflowId: workflowInScope, commentId });

      // A threaded reply, exactly as postComment({ parentCommentId }) sends it.
      const reply = await portal(reviewer, `/v1/portal/work/${workflowInScope}/comments`, {
        body: "Agreed.",
        parentCommentId: commentId,
      });
      expect(reply.statusCode, reply.body).toBe(201);
      expect(
        (await prisma.externalReviewComment.findUniqueOrThrow({ where: { id: reply.json().commentId } }))
          .parentCommentId,
      ).toBe(commentId);
    });

    it("POST /v1/portal/work/:id/comments — refused for an OBSERVER, an out-of-scope workflow and an invalid token; nothing written", async () => {
      const before = await prisma.externalReviewComment.count();
      const obs = await portal(observer, `/v1/portal/work/${workflowInScope}/comments`, { body: "x" });
      expect(obs.statusCode).toBe(403);
      expect(obs.json()).toEqual({ denial: "NOT_PERMITTED" });
      const scope = await portal(reviewer, `/v1/portal/work/${workflowOutOfScope}/comments`, { body: "x" });
      expect(scope.statusCode).toBe(403);
      expect(scope.json()).toEqual({ denial: "OUT_OF_SCOPE" });
      const foreignWorkflow = await portal(
        reviewer,
        `/v1/portal/work/${await workflowFor(
          h.fixtures.teamB.teamId,
          h.fixtures.teamB.evidenceId,
        )}/comments`,
        { body: "x" },
      );
      expect(foreignWorkflow.statusCode).toBe(403);
      expect(foreignWorkflow.json()).toEqual({ denial: "OUT_OF_SCOPE" });
      const bad = await portal(
        { grantId: reviewer.grantId, rawToken: "not-a-real-token-value" },
        `/v1/portal/work/${workflowInScope}/comments`,
        { body: "x" },
      );
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ denial: "TOKEN_INVALID" });
      expect(await prisma.externalReviewComment.count()).toBe(before);
    });

    it("POST /v1/portal/work/:id/decision — a reviewer decides then replaces; decision row + DECISION_SUBMITTED activity re-read", async () => {
      const a = h.fixtures.teamA;
      const first = await portal(reviewer, `/v1/portal/work/${workflowInScope}/decision`, {
        verdict: "REQUEST_CHANGES",
        rationale: "Need the original file.",
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().replaced).toBe(false);
      const decisionId = first.json().decisionId as string;
      let row = await prisma.externalReviewDecision.findUniqueOrThrow({ where: { id: decisionId } });
      expect(row).toMatchObject({
        teamId: a.teamId,
        grantId: reviewer.grantId,
        workflowId: workflowInScope,
        verdict: "REQUEST_CHANGES",
        rationale: "Need the original file.",
      });

      // APPROVE without a rationale — submitDecision sends `rationale: undefined`.
      const second = await portal(reviewer, `/v1/portal/work/${workflowInScope}/decision`, {
        verdict: "APPROVE",
      });
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({ decisionId, replaced: true });
      row = await prisma.externalReviewDecision.findUniqueOrThrow({ where: { id: decisionId } });
      expect(row.verdict).toBe("APPROVE");
      expect(row.rationale).toBeNull();
      const activity = await prisma.externalReviewActivity.findMany({
        where: { grantId: reviewer.grantId, code: "DECISION_SUBMITTED" },
        orderBy: { occurredAtUtc: "asc" },
      });
      expect(activity.map((r) => r.payload)).toEqual([
        { workflowId: workflowInScope, verdict: "REQUEST_CHANGES", replaced: false },
        { workflowId: workflowInScope, verdict: "APPROVE", replaced: true },
      ]);
    });

    it("POST /v1/portal/work/:id/decision — refused for an OBSERVER, a REJECT without rationale and an out-of-scope workflow", async () => {
      const obs = await portal(observer, `/v1/portal/work/${workflowInScope}/decision`, { verdict: "APPROVE" });
      expect(obs.statusCode).toBe(403);
      expect(obs.json()).toEqual({ denial: "NOT_PERMITTED" });
      const scope = await portal(reviewer, `/v1/portal/work/${workflowOutOfScope}/decision`, { verdict: "APPROVE" });
      expect(scope.statusCode).toBe(403);
      expect(scope.json()).toEqual({ denial: "OUT_OF_SCOPE" });
      const before = await prisma.externalReviewDecision.findMany({
        where: { grantId: reviewer.grantId },
        orderBy: { id: "asc" },
      });
      const noRationale = await portal(reviewer, `/v1/portal/work/${workflowInScope}/decision`, {
        verdict: "REJECT",
      });
      expect(noRationale.statusCode).toBe(409);
      expect(noRationale.json()).toEqual({ denial: "POLICY_REJECTED" });
      expect(
        await prisma.externalReviewDecision.findMany({
          where: { grantId: reviewer.grantId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      expect(
        await prisma.externalReviewDecision.count({
          where: { workflowId: workflowOutOfScope },
        }),
      ).toBe(0);
      expect(
        await prisma.externalReviewDecision.count({ where: { grantId: observer.grantId } }),
      ).toBe(0);
    });

    it("POST /v1/portal/work/:id/view — the body-less JSON POST the portal client sends records REVIEW_OPENED on the session", async () => {
      const a = h.fixtures.teamA;
      // An OBSERVER holds portal.view — the least-privileged role succeeds.
      const res = await portal(observer, `/v1/portal/work/${workflowInScope}/view`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const activity = await prisma.externalReviewActivity.findFirstOrThrow({
        where: { grantId: observer.grantId, code: "REVIEW_OPENED" },
        orderBy: { occurredAtUtc: "desc" },
      });
      expect(activity).toMatchObject({ teamId: a.teamId, sessionId: observer.sessionId });
      expect(activity.payload).toEqual({ workflowId: workflowInScope });
    });

    it("POST /v1/portal/work/:id/view — refused out of scope and for a revoked grant; no activity written", async () => {
      const a = h.fixtures.teamA;
      const scope = await portal(observer, `/v1/portal/work/${workflowOutOfScope}/view`);
      expect(scope.statusCode).toBe(403);
      expect(scope.json()).toEqual({ denial: "OUT_OF_SCOPE" });

      const revoked = await issue("EXTERNAL_REVIEWER");
      const { revokeInvitation } = await import(
        "../src/services/external-review/portal-invitation.service.js"
      );
      const r = await revokeInvitation({
        teamId: a.teamId,
        grantId: revoked.grantId,
        revokedByUserId: a.ownerUserId,
      });
      expect(r.ok).toBe(true);
      const denied = await portal(revoked, `/v1/portal/work/${workflowInScope}/view`);
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ denial: "TOKEN_REVOKED" });
      expect(
        await prisma.externalReviewActivity.count({
          where: { grantId: revoked.grantId, code: "REVIEW_OPENED" },
        }),
      ).toBe(0);
      expect(
        await prisma.externalReviewActivity.count({
          where: { grantId: observer.grantId, code: "REVIEW_OPENED", payload: { equals: { workflowId: workflowOutOfScope } } },
        }),
      ).toBe(0);
    });
  });
});
