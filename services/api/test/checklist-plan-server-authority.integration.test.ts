/**
 * ET-ACQ-05 — the required-checklist gate enforces the SERVER's plan.
 * Live PostgreSQL 16; the object store is an in-memory double at the storage
 * module boundary (the pattern of completion-size-and-prehash).
 *
 * On a40ca76f the gate read only Evidence.intakePlanJson, which the client
 * wrote: a raw API caller omitted it and the gate did not apply, although the
 * capture session the owner opened had chosen CHECKLIST_REQUIRED against a
 * template with required steps.
 */
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return { sizeBytes: b.length, versionId: "v1", contentType: "image/jpeg", etag: '"e1"', metadata: null, objectLockMode: null, objectLockRetainUntilDate: null, objectLockLegalHoldStatus: null };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => Readable.from([objects.get(id(p))!]),
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
  };
});

describe("checklist plan server authority (live PostgreSQL 16)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let completeEvidence: (typeof import("../src/services/evidence-complete.service.js"))["completeEvidence"];
  const created: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    ({ completeEvidence } = await import("../src/services/evidence-complete.service.js"));
  }, 180_000);

  afterAll(async () => {
    if (created.length) {
      await prisma?.evidence.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } }).catch(() => undefined);
    }
    await h?.cleanup();
  });

  /** A record with one unmapped part, bound to a finalized capture session. */
  async function recordFromSession(planMode: "CHECKLIST_REQUIRED" | "FLEXIBLE") {
    const A = h.fixtures.teamA;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: A.teamId }, select: { organizationId: true } });
    const { id } = await prisma.evidence.create({
      // No intakePlanJson: the client omitted it.
      data: { title: "ACQ-05 fixture", type: "PHOTO", status: "CREATED", teamId: A.teamId, organizationId: team.organizationId, ownerUserId: A.ownerUserId } as never,
      select: { id: true },
    });
    created.push(id);
    const key = `evidence/${id}/parts/0-${randomUUID()}`;
    objects.set(`acq05/${key}`, Buffer.from(`bytes-${id}`));
    await prisma.evidencePart.create({
      data: { evidenceId: id, partIndex: 0, storageBucket: "acq05", storageKey: key, mimeType: "image/jpeg" } as never,
    });
    await prisma.captureSession.create({
      data: {
        ownerUserId: A.ownerUserId,
        teamId: A.teamId,
        status: "FINALIZED",
        templateId: "insurance-claim",
        templateVersion: 1,
        planMode,
        finalizedEvidenceId: id,
      } as never,
    });
    return { id, ownerUserId: A.ownerUserId };
  }

  it("a CHECKLIST_REQUIRED session refuses completion when the template's required steps are unmapped, plan omitted or not", async () => {
    const r = await recordFromSession("CHECKLIST_REQUIRED");
    await expect(completeEvidence({ evidenceId: r.id, ownerUserId: r.ownerUserId })).rejects.toMatchObject({
      message: "Required checklist steps are not satisfied.",
    });
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } });
    expect(row.status).toBe("CREATED");
  });

  it("a FLEXIBLE session completes (control)", async () => {
    const r = await recordFromSession("FLEXIBLE");
    const result = await completeEvidence({ evidenceId: r.id, ownerUserId: r.ownerUserId });
    expect(result.status).toBe("SIGNED");
  });
});
