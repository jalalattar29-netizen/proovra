/**
 * ET-DC-01 — a discard that races a direct-capture completion.
 *
 * The real routes and the real completeEvidence against live PostgreSQL 16.
 * The object store is in-process and its read is GATED, which holds
 * finalization inside its transaction (evidence lock held, bytes being hashed)
 * while the discard is sent — the exact window of the defect.
 *
 * On a40ca76f the discard only took the capture-session lock, so it
 * soft-deleted the reservation and wrote EVIDENCE_DELETED while finalization
 * was hashing; finalization then signed the deleted row (its claim had no
 * deletedAt predicate), wrote SIGNATURE_APPLIED after EVIDENCE_DELETED, and the
 * completion answered bound:true for a session that was DISCARDED.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const gate = vi.hoisted(() => ({
  armed: false,
  entered: null as null | (() => void),
  release: null as null | Promise<void>,
}));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://dc01-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        versionId: "v1",
        contentType: "image/jpeg",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      if (gate.armed) {
        gate.armed = false;
        gate.entered?.();
        await gate.release;
      }
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
    deleteObject: async (p: { bucket: string; key: string }) => {
      objects.delete(id(p));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`dc01-test-signature:${hex}`).toString("base64"),
        keyId: "dc01-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

process.env.S3_BUCKET = "dc01-race-test-bucket";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("direct capture: discard racing completion (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: harness.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: harness.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  afterAll(async () => {
    if (harness && originalBilling) {
      await prisma.team
        .update({ where: { id: harness.fixtures.teamA.teamId }, data: originalBilling as never })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  }, 120_000);

  const call = (method: "POST", url: string, token: string, payload?: unknown) =>
    harness.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  async function stageDeclared() {
    const A = harness.fixtures.teamA;
    const token = A.ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: A.teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sessionId = open.json().session.captureSessionId as string;
    const reserve = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
    });
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "camera.jpg",
    });
    expect(part.statusCode, part.body).toBe(201);
    const { bucket, key } = part.json().upload as { bucket: string; key: string };
    const bytes = Buffer.from(`dc01-${randomBytes(8).toString("hex")}`);
    objects.set(`${bucket}/${key}`, bytes);
    const declare = await call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/0/declaration`, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: null,
    });
    expect(declare.statusCode, declare.body).toBe(201);
    return { token, sessionId, evidenceId };
  }

  it("a discard sent while finalization is hashing never deletes a record that then gets signed", async () => {
    const { token, sessionId, evidenceId } = await stageDeclared();

    let releaseFn: () => void = () => undefined;
    gate.release = new Promise<void>((r) => (releaseFn = r));
    const entered = new Promise<void>((r) => (gate.entered = r));
    gate.armed = true;

    const completing = call("POST", `/v1/capture/direct-sessions/${sessionId}/complete`, token);
    await entered; // finalization holds the evidence lock and is reading bytes
    const discarding = call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, token);
    await sleep(750); // the old discard committed inside this window
    releaseFn();

    const [done, discard] = await Promise.all([completing, discarding]);

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, deletedAt: true },
    });
    const session = await prisma.captureSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true },
    });
    const custody = await prisma.custodyEvent.findMany({
      where: { evidenceId },
      orderBy: { sequence: "asc" },
      select: { eventType: true },
    });
    const types = custody.map((c) => String(c.eventType));
    const observed = JSON.stringify({ ev, session: session.status, types, done: [done.statusCode, done.body.slice(0, 200)], discard: [discard.statusCode, discard.body.slice(0, 200)] });

    // Exactly one of the two may win, and the record's state must agree with it.
    if (ev.status === "SIGNED" || ev.status === "REPORTED") {
      expect(ev.deletedAt, observed).toBeNull();
      expect(types, observed).not.toContain("EVIDENCE_DELETED");
      expect(session.status, observed).toBe("BOUND");
      expect(done.statusCode, observed).toBe(200);
      expect(done.json().result, observed).toMatchObject({ bound: true, alreadyBound: false });
      expect(discard.statusCode, observed).toBe(409);
    } else {
      expect(ev.deletedAt, observed).not.toBeNull();
      expect(types, observed).not.toContain("SIGNATURE_APPLIED");
      expect(session.status, observed).toBe("DISCARDED");
      expect(done.statusCode, observed).not.toBe(200);
    }
  }, 120_000);
});
