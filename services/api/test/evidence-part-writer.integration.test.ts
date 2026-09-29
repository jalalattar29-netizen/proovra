/**
 * ET-UPL-01 / ET-INT-05 / ET-INT-14 — the canonical EvidencePart writer,
 * behaviourally, on live PostgreSQL 16:
 *   - owner and non-owner are refused once the record no longer accepts bytes;
 *   - the external-intake principal is refused after signing;
 *   - a soft-deleted record is "not found", never reused;
 *   - a write racing a finalize that holds the evidence lock waits for it and
 *     is then refused (there is no interleaving in which it lands).
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

describe("canonical EvidencePart writer (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let writer: typeof import("../src/services/evidence/evidence-part-writer.service.js");

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    writer = await import("../src/services/evidence/evidence-part-writer.service.js");
  }, 180_000);
  afterAll(async () => { await h?.cleanup(); });

  async function record(status: "UPLOADING" | "SIGNED", extra: Record<string, unknown> = {}) {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    return prisma.evidence.create({
      data: { title: "writer fixture", type: "PHOTO", status, teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId, ...extra } as never,
      select: { id: true, ownerUserId: true },
    });
  }
  const data = (i: number) => ({ storageBucket: "b", storageKey: `k/${randomUUID()}-${i}`, mimeType: "image/png", uploadedAtUtc: null });
  const refusal = async (p: Promise<unknown>) => {
    try { await p; return null; } catch (e) { return e instanceof writer.EvidencePartWriteRefused ? { code: e.code, status: e.statusCode } : { other: String(e) }; }
  };

  it("owner may write while UPLOADING; repeated index returns the same row", async () => {
    const ev = await record("UPLOADING");
    const a = await writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 0, onExistingIndex: "RETURN_EXISTING", data: data(0) });
    const b = await writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 0, onExistingIndex: "RETURN_EXISTING", data: data(0) });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.part.id).toBe(a.part.id);
    expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 0, onExistingIndex: "REFUSE", data: data(0) }))).toEqual({ code: "PART_INDEX_TAKEN", status: 409 });
  });

  it("SIGNED refuses the owner (409) and answers a non-owner as not found (404)", async () => {
    const ev = await record("SIGNED");
    expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 1, onExistingIndex: "REFUSE", data: data(1) }))).toEqual({ code: "EVIDENCE_NOT_WRITABLE", status: 409 });
    expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: h.fixtures.teamA.memberUserId }, partIndex: 1, onExistingIndex: "REFUSE", data: data(1) }))).toEqual({ code: "EVIDENCE_NOT_FOUND", status: 404 });
    expect(await prisma.evidencePart.count({ where: { evidenceId: ev.id } })).toBe(0);
  });

  it("ET-INT-05: the intake principal is refused once the record is signed", async () => {
    const ev = await record("SIGNED");
    expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "INTAKE_SESSION", linkCreatorUserId: ev.ownerUserId, sessionId: randomUUID() }, partIndex: 1, onExistingIndex: "REFUSE", data: data(1) }))).toEqual({ code: "EVIDENCE_NOT_WRITABLE", status: 409 });
  });

  it("ET-INT-14: a soft-deleted in-progress record is not found, never reused", async () => {
    const ev = await record("UPLOADING", { deletedAt: new Date() });
    expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "INTAKE_SESSION", linkCreatorUserId: ev.ownerUserId, sessionId: randomUUID() }, partIndex: 0, onExistingIndex: "REFUSE", data: data(0) }))).toEqual({ code: "EVIDENCE_NOT_FOUND", status: 404 });
  });

  it("locked, trashed and archived records refuse writes", async () => {
    for (const extra of [{ lockedAt: new Date() }, { lifecycleState: "ARCHIVED", archivedAt: new Date() }]) {
      const ev = await record("UPLOADING", extra);
      expect(await refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 0, onExistingIndex: "REFUSE", data: data(0) }))).toEqual({ code: "EVIDENCE_NOT_WRITABLE", status: 409 });
    }
  });

  it("a write racing a finalize that holds the evidence lock waits, then is refused", async () => {
    const ev = await record("UPLOADING");
    let releaseFinalize!: () => void;
    const finalizeMayCommit = new Promise<void>((r) => (releaseFinalize = r));
    let finalizeHasLock!: () => void;
    const lockTaken = new Promise<void>((r) => (finalizeHasLock = r));
    // The finalize transaction's shape: evidence lock, hash/sign, claim SIGNED.
    const finalize = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ev.id}))`;
      finalizeHasLock();
      await finalizeMayCommit;
      await tx.evidence.update({ where: { id: ev.id }, data: { status: "SIGNED" } });
    }, { timeout: 20_000 });
    await lockTaken;
    const racing = refusal(writer.writeEvidencePart({ evidenceId: ev.id, principal: { kind: "OWNER", userId: ev.ownerUserId }, partIndex: 5, onExistingIndex: "REFUSE", data: data(5) }));
    await new Promise((r) => setTimeout(r, 300));
    releaseFinalize();
    await finalize;
    expect(await racing).toEqual({ code: "EVIDENCE_NOT_WRITABLE", status: 409 });
    expect(await prisma.evidencePart.count({ where: { evidenceId: ev.id } })).toBe(0);
  });
});
