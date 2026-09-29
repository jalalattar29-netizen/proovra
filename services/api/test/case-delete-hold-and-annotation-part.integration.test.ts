/**
 * ET-SEC-17 / ET-SEC-32 — live PostgreSQL 16, the real routes.
 *
 * On a40ca76f:
 *   ET-SEC-17 — the case-deletion hold check caught a store error and answered
 *     "no hold", so DELETE /v1/cases/:id hard-deleted the case and detached all
 *     of its evidence while the hold state was unknown.
 *   ET-SEC-32 — only the annotation POST checked that evidencePartId belongs
 *     to the record; PATCH accepted any part id, including another record's.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("case delete fails closed; annotation edits keep part ownership (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, token: string, payload?: unknown) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: payload as never } : {}),
    });

  async function evidenceWithPart(teamId: string, ownerUserId: string) {
    const team = await prisma.team.findUniqueOrThrow({ where: { id: teamId }, select: { organizationId: true } });
    const ev = await prisma.evidence.create({
      data: { title: `sec ${randomUUID().slice(0, 6)}`, type: "PHOTO", status: "SIGNED", mimeType: "image/jpeg", teamId, organizationId: team.organizationId, ownerUserId },
      select: { id: true },
    });
    const part = await prisma.evidencePart.create({
      data: { evidenceId: ev.id, partIndex: 0, storageBucket: "b", storageKey: `k/${randomUUID()}` },
      select: { id: true },
    });
    return { evidenceId: ev.id, partId: part.id };
  }

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
  }, 180_000);
  afterAll(async () => {
    await h?.cleanup();
  });

  it("ET-SEC-17: an unreadable hold state answers 503 and the case and its links stay", async () => {
    const A = h.fixtures.teamA;
    const caseId = (
      await prisma.case.create({
        data: { name: `hold ${randomUUID().slice(0, 6)}`, teamId: A.teamId, ownerUserId: A.ownerUserId },
        select: { id: true },
      })
    ).id;
    const { evidenceId } = await evidenceWithPart(A.teamId, A.ownerUserId);
    await prisma.caseEvidenceLink.create({ data: { caseId, evidenceId } });

    const spy = vi.spyOn(prisma.evidenceLegalHold, "findMany").mockRejectedValueOnce(new Error("hold store down"));
    try {
      const res = await call("DELETE", `/v1/cases/${caseId}`, A.ownerToken);
      expect(res.statusCode, res.body).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ denial: "LEGAL_HOLD_STATE_UNAVAILABLE" });
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.case.findUnique({ where: { id: caseId }, select: { id: true } })).not.toBeNull();
    expect(await prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } })).toBe(1);
  });

  it("ET-SEC-32: PATCH cannot point an annotation at another record's part; its own part is accepted", async () => {
    const A = h.fixtures.teamA;
    const mine = await evidenceWithPart(A.teamId, A.ownerUserId);
    const other = await evidenceWithPart(A.teamId, A.ownerUserId);
    const created = await call("POST", `/v1/evidence/${mine.evidenceId}/annotations`, A.memberToken, {
      evidencePartId: null,
      annotationType: "TEXT",
      body: "note",
      coordinateSpace: "NORMALIZED",
    });
    expect(created.statusCode, created.body).toBe(201);
    const annotationId = (JSON.parse(created.body) as { annotation: { id: string } }).annotation.id;

    const foreign = await call("PATCH", `/v1/evidence/${mine.evidenceId}/annotations/${annotationId}`, A.memberToken, {
      evidencePartId: other.partId,
    });
    expect(foreign.statusCode, foreign.body).toBe(400);
    expect((await prisma.evidenceAnnotation.findUniqueOrThrow({ where: { id: annotationId } })).evidencePartId).toBeNull();

    const own = await call("PATCH", `/v1/evidence/${mine.evidenceId}/annotations/${annotationId}`, A.memberToken, {
      evidencePartId: mine.partId,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect((await prisma.evidenceAnnotation.findUniqueOrThrow({ where: { id: annotationId } })).evidencePartId).toBe(mine.partId);
  });
});
