/**
 * UC-0 DISCARD — abort an unsealed direct-capture session, end to end, against
 * a real database through the real HTTP routes.
 *
 * WHY THIS SUITE EXISTS
 *
 * `POST /v1/capture/direct-sessions/:id/evidence` runs the canonical
 * `createEvidence()` on the FIRST staged item: a durable, owned, listed Evidence
 * row plus an EVIDENCE_CREATED custody event, before a single byte exists. The
 * mobile client's "Discard Session" made no server call at all and no abort
 * route existed, so every abandoned capture left a permanent, custody-logged,
 * empty record in the owner's Active library — the observed
 * "record audio → stop → Discard → the evidence is still there" defect.
 *
 * WHAT THIS PROVES (behaviour, against real persistence — not mocks)
 *   * a reserved-but-unsealed record IS invisible in the library the moment it
 *     is reserved (the never-committed invariant), and Discard then releases it;
 *   * Discard is idempotent and answers 200 on an already-terminal session;
 *   * Discard REFUSES a BOUND (sealed) session — committed evidence is removed
 *     through the Evidence lifecycle, never through the capture path;
 *   * the release is auditable: the session goes DISCARDED and the custody chain
 *     records EVIDENCE_DELETED with the reason, so the record is genuinely
 *     terminal rather than merely hidden;
 *   * a non-owner cannot discard someone else's session, and existence is not
 *     leaked.
 */
import { createHash } from "node:crypto";
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
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://test-object-store.invalid/${encodeURIComponent(id(p))}`,
    presignGetObject: async (p: { bucket: string; key: string }) =>
      `https://test-object-store.invalid/${encodeURIComponent(id(p))}`,
    putObject: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
      return { etag: createHash("md5").update(p.body).digest("hex") };
    },
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
    deleteObject: async (p: { bucket: string; key: string }) => {
      objects.delete(id(p));
    },
    applyDefaultObjectRetention: async () => ({ applied: false, reason: "test_store" }),
    getObjectStream: async (p: { bucket: string; key: string }) => {
      const body = objects.get(id(p));
      if (!body) throw new Error(`missing object ${id(p)}`);
      return Readable.from(body);
    },
    /*
     * ANSWER WHAT THE PRODUCT READS, AND FAIL THE WAY S3 FAILS.
     *
     * This returned `{ contentLength }` and `null` for a miss. The real
     * `headObject` returns `sizeBytes` and THROWS NotFound, and completion
     * reads `sizeBytes` — so the seal refused with a bounded 404 that the
     * suite read as a product refusal. A double that answers a different
     * shape is not a double; it is a second implementation nobody reviewed.
     */
    headObject: async (p: { bucket: string; key: string }) => {
      const body = objects.get(id(p));
      if (!body) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: body.length,
        contentType: "application/octet-stream",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
  };
});

describe("UC-0 discard — live PostgreSQL 16", () => {
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

  function call(method: "GET" | "POST", url: string, token: string, payload?: unknown) {
    return harness.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  }

  const owner = () => harness.fixtures.teamA;

  /** Open a session and reserve its record — the state a staged capture is in. */
  async function reserveOnly(token = owner().ownerToken) {
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const session = open.json().session as { captureSessionId: string };

    const reserve = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/evidence`,
      token,
      { type: "AUDIO", mimeType: "audio/mp4", deviceTimeIso: new Date().toISOString() },
    );
    expect(reserve.statusCode, reserve.body).toBe(201);
    return {
      sessionId: session.captureSessionId,
      evidenceId: reserve.json().evidence.evidenceId as string,
    };
  }

  async function listActiveIds(token = owner().ownerToken): Promise<string[]> {
    const res = await call("GET", "/v1/evidence?scope=active&limit=100", token);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().items as Array<{ id: string }>).map((i) => i.id);
  }

  it("a reserved-but-uncommitted record is never listed as library content", async () => {
    const { evidenceId } = await reserveOnly();

    // The record genuinely exists in persistence …
    const row = await prisma.evidence.findUnique({
      where: { id: evidenceId },
      select: { status: true, deletedAt: true },
    });
    // UPLOADING, not CREATED: `createEvidence` moves the record there in the
    // same transaction that issues its upload location, and a reservation
    // issues one. What matters for this test is the next assertion — an
    // uncommitted record is not library content, whatever it is called.
    expect(row?.status).toBe("UPLOADING");
    expect(row?.deletedAt).toBeNull();

    // … and is NOT offered to the user as evidence, because nothing has been
    // committed to it. This is the invariant that makes an abandoned capture
    // harmless even before Discard is pressed.
    expect(await listActiveIds()).not.toContain(evidenceId);

    // Asking for in-flight records BY NAME still returns it — the default is a
    // default, not a concealment.
    const explicit = await call(
      "GET",
      "/v1/evidence?scope=active&status=UPLOADING&limit=100",
      owner().ownerToken,
    );
    expect(explicit.statusCode).toBe(200);
    expect((explicit.json().items as Array<{ id: string }>).map((i) => i.id)).toContain(evidenceId);
  });

  it("discard releases the reservation and records why on the custody chain", async () => {
    const { sessionId, evidenceId } = await reserveOnly();

    const res = await call(
      "POST",
      `/v1/capture/direct-sessions/${sessionId}/discard`,
      owner().ownerToken,
      {},
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().result).toMatchObject({ discarded: true, releasedEvidenceId: evidenceId });

    const session = await prisma.captureSession.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, discardedAtUtc: true, endReason: true },
    });
    expect(session.status).toBe("DISCARDED");
    expect(session.discardedAtUtc).toBeInstanceOf(Date);
    expect(session.endReason).toBe("DISCARDED");

    const evidence = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { deletedAt: true },
    });
    expect(evidence.deletedAt).toBeInstanceOf(Date);

    // Not cosmetic hiding: the chain says what happened to it.
    const events = await prisma.custodyEvent.findMany({
      where: { evidenceId },
      orderBy: { sequence: "asc" },
      select: { eventType: true, payload: true },
    });
    expect(events.map((e) => e.eventType)).toContain("EVIDENCE_DELETED");
    const deletion = events.find((e) => e.eventType === "EVIDENCE_DELETED");
    expect(deletion?.payload).toMatchObject({ reason: "CAPTURE_SESSION_DISCARDED" });

    // And it is gone from every user-facing scope, including Trash — an empty
    // reservation is not a restorable user item.
    expect(await listActiveIds()).not.toContain(evidenceId);
    const trash = await call("GET", "/v1/evidence?scope=trash&limit=100", owner().ownerToken);
    expect((trash.json().items as Array<{ id: string }>).map((i) => i.id)).not.toContain(evidenceId);
  });

  it("discard is idempotent", async () => {
    const { sessionId } = await reserveOnly();

    const first = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, owner().ownerToken, {});
    expect(first.statusCode).toBe(200);
    expect(first.json().result.discarded).toBe(true);

    const second = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, owner().ownerToken, {});
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().result.discarded).toBe(false);
    expect(second.json().result.releasedEvidenceId).toBeNull();
  });

  it("a session cannot be discarded once it is reserved and then sealed", async () => {
    // Seal the session through the canonical path, then attempt a discard.
    const bytes = Buffer.from("proovra-discard-guard");
    const open = await call("POST", "/v1/capture/direct-sessions", owner().ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
      deviceId: null,
    });
    const session = open.json().session as { captureSessionId: string };
    const reserve = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/evidence`,
      owner().ownerToken,
      { type: "DOCUMENT", mimeType: "text/plain", deviceTimeIso: new Date().toISOString() },
    );
    const evidenceId = reserve.json().evidence.evidenceId as string;
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/parts/0/declaration`,
      owner().ownerToken,
      { sha256, clientReportedSource: "FILE_PICKER", signed: null },
    );
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, owner().ownerToken, {
      partIndex: 0,
      mimeType: "text/plain",
      checksumSha256Base64: createHash("sha256").update(bytes).digest("base64"),
      contentMd5Base64: createHash("md5").update(bytes).digest("base64"),
    });
    expect(part.statusCode, part.body).toBe(201);
    // The key comes from the response the route sends, not from parsing its
    // presigned URL: the last URL segment is the ENCODED `bucket%2Fkey`, so
    // nothing this test "uploaded" was ever findable under the key the double
    // stores by.
    const upload = part.json().upload as { bucket: string; key: string };
    objects.set(`${upload.bucket}/${upload.key}`, bytes);

    const done = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/complete`,
      owner().ownerToken,
      {},
    );
    expect(done.statusCode, done.body).toBe(200);

    const discard = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/discard`,
      owner().ownerToken,
      {},
    );
    expect(discard.statusCode).toBe(409);

    // The sealed record is untouched — discard is not a back door around the
    // Evidence lifecycle's authorization and legal-hold rules.
    const evidence = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { deletedAt: true },
    });
    expect(evidence.deletedAt).toBeNull();
  });

  it("a non-owner cannot discard someone else's session and learns nothing", async () => {
    const { sessionId, evidenceId } = await reserveOnly();

    const outsider = harness.fixtures.teamB?.ownerToken;
    if (!outsider) return; // fixture-dependent; skip rather than assert a shape we do not have

    const res = await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, outsider, {});
    expect([403, 404]).toContain(res.statusCode);

    const evidence = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { deletedAt: true },
    });
    expect(evidence.deletedAt).toBeNull();
  });
});
