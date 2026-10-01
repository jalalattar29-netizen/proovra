/**
 * UC-CASE-001 / UC-CASE-002 / UC-CASE-004 / UC-CASE-005 — the case ↔ evidence
 * authority under legal hold, role and concurrency pressure. Live PostgreSQL 16,
 * real HTTP routes and the canonical services.
 *
 *  - CASE-001: an ACTIVE case hold refuses single, bulk and case-workspace
 *    unlink with zero mutation (409 LEGAL_HOLD_BLOCKED); a record whose unlink
 *    was refused is still held (trash refused); after release the unlink
 *    works; a hold placed CONCURRENTLY with an unlink never ends with the link
 *    gone while the hold is active (case-row lock vs the hold's FK).
 *  - CASE-002: a VIEWER granted CaseAccess stays a VIEWER: unlink and link are
 *    refused 403, never a 500, with zero mutation; a MEMBER in CaseAccess may.
 *  - CASE-004: N concurrent attaches with mixed roles → exactly one link row,
 *    every caller answered without error.
 *  - CASE-005: the review workspace projects EVERY linked case the viewer may
 *    open, and omits a restricted case (no id, no name).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("case hold, role and link concurrency (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let holds: typeof import("../src/services/governance/legal-hold.service.js");
  let links: typeof import("../src/services/cases/case-evidence-link.service.js");
  const createdCases: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    holds = await import("../src/services/governance/legal-hold.service.js");
    links = await import("../src/services/cases/case-evidence-link.service.js");
  }, 180_000);

  afterAll(async () => {
    if (createdCases.length) {
      await prisma?.evidenceLegalHold.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma?.caseEvidenceLink.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma?.caseAccess.deleteMany({ where: { caseId: { in: createdCases } } }).catch(() => undefined);
      await prisma?.case.deleteMany({ where: { id: { in: createdCases } } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  const A = () => h.fixtures.teamA;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function newCase(name = "c"): Promise<string> {
    const { id } = await prisma.case.create({
      data: { name: `${name}-${randomUUID().slice(0, 8)}`, teamId: A().teamId, ownerUserId: A().ownerUserId } as never,
      select: { id: true },
    });
    createdCases.push(id);
    return id;
  }
  async function record(ownerUserId = A().ownerUserId): Promise<string> {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A().teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      data: {
        title: "case-hold fixture",
        type: "PHOTO",
        status: "SIGNED",
        teamId: A().teamId,
        organizationId: team.organizationId,
        ownerUserId,
        sizeBytes: 1_000n,
      } as never,
      select: { id: true },
    });
    return id;
  }
  const link = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.create({ data: { caseId, evidenceId, teamId: A().teamId } as never, select: { id: true } });
  const linkCount = (caseId: string, evidenceId: string) =>
    prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } });
  const placeHold = (caseId: string) =>
    holds.placeCanonicalLegalHold({ teamId: A().teamId, scope: "CASE", caseId, actorUserId: A().ownerUserId, title: "matter hold" });

  // --- UC-CASE-001 ------------------------------------------------------------

  it("CASE-001: single, bulk and case-workspace unlink are refused under an active case hold, zero mutation", async () => {
    const caseId = await newCase("held");
    const ev = await record();
    const row = await link(caseId, ev);
    const hold = await placeHold(caseId);

    const single = await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/evidence/${ev}`, headers: auth(A().ownerToken) });
    expect(single.statusCode, single.body).toBe(409);
    expect(single.json().code).toBe("LEGAL_HOLD_BLOCKED");

    const bulk = await h.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: auth(A().ownerToken),
      payload: { action: "REMOVE_FROM_CASE", evidenceIds: [ev] },
    });
    expect(bulk.statusCode, bulk.body).toBe(200);
    expect(bulk.json()).toMatchObject({ successCount: 0, failedCount: 1 });
    expect(bulk.body).toContain("LEGAL_HOLD_BLOCKED");

    const ws = await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/evidence-links/${row.id}`, headers: auth(A().ownerToken) });
    expect(ws.statusCode, ws.body).toBe(409);

    expect(await linkCount(caseId, ev)).toBe(1);

    // The record stays held: trash is still refused.
    const trash = await h.app.inject({
      method: "POST",
      url: "/v1/evidence/bulk",
      headers: auth(A().ownerToken),
      payload: { action: "TRASH", evidenceIds: [ev] },
    });
    expect(trash.json()).toMatchObject({ successCount: 0 });

    // After release the unlink is allowed.
    await prisma.evidenceLegalHold.update({ where: { id: hold.id }, data: { status: "RELEASED", releasedAtUtc: new Date() } as never });
    const after = await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/evidence/${ev}`, headers: auth(A().ownerToken) });
    expect(after.statusCode, after.body).toBe(200);
    expect(await linkCount(caseId, ev)).toBe(0);
  });

  it("CASE-001: an unlink racing an in-flight hold placement waits for it and is refused (row lock vs the hold's FK)", async () => {
    const caseId = await newCase("race");
    const ev = await record();
    await link(caseId, ev);
    let unlinkSettled = false;
    let unlink: Promise<unknown> | null = null;
    // Place the hold in an open transaction; start the unlink BEFORE it commits.
    await prisma.$transaction(
      async (tx) => {
        await holds.placeCanonicalLegalHold(
          { teamId: A().teamId, scope: "CASE", caseId, actorUserId: A().ownerUserId, title: "racing hold" },
          tx as never,
        );
        unlink = links
          .detachEvidenceFromCase({ caseId, evidenceId: ev, actorUserId: A().ownerUserId })
          .finally(() => {
            unlinkSettled = true;
          });
        unlink.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
        // The unlink cannot have completed while the hold is uncommitted.
        expect(unlinkSettled).toBe(false);
      },
      { timeout: 20_000 },
    );
    await expect(unlink!).rejects.toMatchObject({ code: "case_hold_active" });
    expect(await linkCount(caseId, ev)).toBe(1);
  });

  it("CASE-001: hold-vs-unlink races always end consistent (never: hold active AND link gone after the hold)", async () => {
    for (let round = 0; round < 6; round++) {
      const caseId = await newCase("race2");
      const ev = await record();
      await link(caseId, ev);
      const [unlink, hold] = await Promise.allSettled([
        links.detachEvidenceFromCase({ caseId, evidenceId: ev, actorUserId: A().ownerUserId }),
        placeHold(caseId),
      ]);
      expect(hold.status, String((hold as PromiseRejectedResult).reason)).toBe("fulfilled");
      if (unlink.status === "rejected") {
        expect((unlink.reason as { code?: string }).code).toBe("case_hold_active");
        expect(await linkCount(caseId, ev)).toBe(1);
      } else {
        expect(await linkCount(caseId, ev)).toBe(0);
      }
    }
  });

  // --- UC-CASE-002 ------------------------------------------------------------

  it("CASE-002: a VIEWER on the case's access list stays a viewer (403, never 500, no mutation); a MEMBER on it may", async () => {
    const caseId = await newCase("acl");
    await prisma.caseAccess.create({ data: { caseId, userId: A().viewerUserId } });
    await prisma.caseAccess.create({ data: { caseId, userId: A().memberUserId } });
    const ev = await record();
    await link(caseId, ev);

    const unlink = await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/evidence/${ev}`, headers: auth(A().viewerToken) });
    expect(unlink.statusCode, unlink.body).toBe(403);
    expect(await linkCount(caseId, ev)).toBe(1);

    const other = await record();
    const add = await h.app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/evidence`,
      headers: auth(A().viewerToken),
      payload: { evidenceId: other },
    });
    expect(add.statusCode, add.body).toBe(403);
    expect(await linkCount(caseId, other)).toBe(0);

    const memberUnlink = await h.app.inject({ method: "DELETE", url: `/v1/cases/${caseId}/evidence/${ev}`, headers: auth(A().memberToken) });
    expect(memberUnlink.statusCode, memberUnlink.body).toBe(200);
  });

  // --- UC-CASE-004 ------------------------------------------------------------

  it("CASE-004: concurrent attaches with mixed roles create exactly one link and no caller errors", async () => {
    const caseId = await newCase("dup");
    const ev = await record();
    const roles = ["PRIMARY", "SUPPORTING", "RELATED", "CONTEXT", "PRIMARY", "SUPPORTING", "DERIVED", "RELATED"] as const;
    const results = await Promise.allSettled(
      roles.map((role) =>
        links.attachEvidenceToCase({ caseId, evidenceId: ev, actorUserId: A().ownerUserId, role }),
      ),
    );
    for (const r of results) expect(r.status, String((r as PromiseRejectedResult).reason)).toBe("fulfilled");
    const created = results.filter((r) => r.status === "fulfilled" && r.value.created).length;
    expect(created).toBe(1);
    expect(await linkCount(caseId, ev)).toBe(1);
  });

  // --- UC-CASE-005 ------------------------------------------------------------

  it("CASE-005: the review workspace lists every case the viewer may open and hides a restricted one", async () => {
    const open1 = await newCase("open-one");
    const open2 = await newCase("open-two");
    const restricted = await newCase("restricted-secret");
    await prisma.caseAccess.create({ data: { caseId: restricted, userId: A().adminUserId } });
    const ev = await record(A().ownerUserId);
    await link(open1, ev);
    await link(restricted, ev);
    await link(open2, ev);

    const asMember = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${ev}/review-workspace`,
      headers: auth(A().memberToken),
    });
    expect(asMember.statusCode, asMember.body).toBe(200);
    const rel = asMember.json().relationships as { caseId: string | null; cases: Array<{ caseId: string; caseName: string }> };
    expect(rel.cases.map((c) => c.caseId).sort()).toEqual([open1, open2].sort());
    expect(asMember.body).not.toContain(restricted);
    expect(asMember.body).not.toContain("restricted-secret");
    expect(rel.caseId).toBe(open1);

    const asAdmin = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${ev}/review-workspace`,
      headers: auth(A().adminToken),
    });
    expect((asAdmin.json().relationships.cases as unknown[]).length).toBe(3);
  });
});
