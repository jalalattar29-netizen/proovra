/**
 * WS-CAP — workspace-bound capture, native evidence preservation and upload/seal
 * correctness (live PostgreSQL 16, real HTTP route registration and the real
 * services; only the object store, the signer and the TSA are doubled, as in
 * capture-selection-change-reservation.integration.test.ts).
 *
 *   PRO-C1-01  a web record write naming a workspace other than the record's is
 *              refused before any write; mobile / no-header clients unaffected.
 *   PRO-NBC-01 a staged direct-capture session past its one-hour idle expiry is
 *              live until start + 24 h (C-02, decided in the API too).
 *   PRO-NBC-02 an owner keep-alive slides a capturing session's expiry.
 *   PRO-C1-05  draft autosave re-checks evidence.create in the draft's workspace.
 *   PRO-C1-02  a post-commit retention failure answers the sealed record with its
 *              protection pending repair, recorded once, and the recovery pass
 *              re-drives the repair.
 *   PRO-C1-11  an upload-session idempotency key binds the declared file.
 *   PRO-C1-09  an upload session past its lifetime accepts no further part.
 *   PRO-C1C-02 a part write keeps the record's live reservation live.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";
import { seedPersonalTenant, type FixtureDeps, type PersonalTenant } from "./point7/product-fixtures.js";

const objects = vi.hoisted(() => new Map<string, Buffer>());
const retention = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://ws-cap-store.invalid/${encodeURIComponent(id(p))}?n=${randomBytes(4).toString("hex")}`,
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
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return Readable.from([b]);
    },
    applyDefaultObjectRetention: async () => {
      if (retention.fail) throw Object.assign(new Error("SlowDown"), { name: "SlowDown", $metadata: { httpStatusCode: 503 } });
      return { applied: false, reason: "test_store" };
    },
    putObjectBuffer: async (p: { bucket: string; key: string; body: Buffer }) => {
      objects.set(id(p), Buffer.from(p.body));
    },
  };
});

vi.mock("../src/signing/signer.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getEvidenceSigner: () => ({
      signFingerprintHex: async (hex: string) => ({
        signatureBase64: Buffer.from(`ws-cap-sig:${hex}`).toString("base64"),
        keyId: "ws-cap-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

process.env.S3_BUCKET = "ws-cap-test-bucket";

const MIN = 60 * 1000;
const b64 = (b: Buffer) => createHash("sha256").update(b).digest("base64");
const hexDigest = () => randomBytes(32).toString("hex");

describe("WS-CAP capture remediation (Postgres, real HTTP)", () => {
  let h: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let deps: FixtureDeps;
  let clearRates: () => Promise<unknown>;
  let svc: typeof import("../src/services/capture-trust/direct-capture-ingest.service.js");
  let uploads: typeof import("../src/services/uploads/upload-session.service.js");
  let complete: typeof import("../src/services/evidence-complete.service.js");
  let cleanup: typeof import("../src/services/evidence/refused-upload-cleanup.service.js");
  let originalBilling: Record<string, unknown> | null = null;

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    h = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    const { registerPrisma } = await import("@proovra/shared-runtime");
    registerPrisma(prisma as never);
    ({ clearAllRateLimitBuckets: clearRates } = await import("../src/services/rate-limit.js"));
    svc = await import("../src/services/capture-trust/direct-capture-ingest.service.js");
    uploads = await import("../src/services/uploads/upload-session.service.js");
    complete = await import("../src/services/evidence-complete.service.js");
    cleanup = await import("../src/services/evidence/refused-upload-cleanup.service.js");
    const { signJwt } = await import("../src/services/jwt.js");
    const secret = process.env.AUTH_JWT_SECRET!;
    deps = {
      prisma: prisma as never,
      tag: `wscap-${Date.now().toString(36)}`,
      mintToken: (userId, email) =>
        signJwt(
          { sub: userId, provider: "EMAIL", email, authMethod: "PASSWORD", authAt: Math.floor(Date.now() / 1000) },
          secret,
          60 * 60,
        ),
    };
    const team = await prisma.team.findUniqueOrThrow({
      where: { id: h.fixtures.teamA.teamId },
      select: { billingPlan: true, billingStatus: true },
    });
    originalBilling = team as unknown as Record<string, unknown>;
    await prisma.team.update({
      where: { id: h.fixtures.teamA.teamId },
      data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never,
    });
  }, 600_000);

  beforeEach(async () => {
    await clearRates();
    retention.fail = false;
  });

  afterAll(async () => {
    if (h && originalBilling) {
      await prisma.team.update({ where: { id: h.fixtures.teamA.teamId }, data: originalBilling as never }).catch(() => undefined);
    }
    await h?.cleanup();
  }, 120_000);

  const call = (
    method: "POST" | "GET" | "DELETE" | "PATCH",
    url: string,
    token: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    h.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });

  const presignBody = (bytes: Buffer, name = "a.jpg") => ({
    partIndex: 0,
    mimeType: "image/jpeg",
    originalFileName: name,
    sizeBytes: bytes.length,
    checksumSha256Base64: b64(bytes),
    clientSignals: { clientHintSha256Base64: b64(bytes), duplicateStatus: "unique" },
  });

  // --- PRO-C1-01 --------------------------------------------------------------

  it("PRO-C1-01: a web part/complete naming another workspace is refused 409 before any write; mobile is unaffected", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    // The member of A is a member of B too (the multi-workspace condition).
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: B.teamId, userId: A.memberUserId } },
      create: { teamId: B.teamId, userId: A.memberUserId, role: "MEMBER", status: "ACTIVE" },
      update: { status: "ACTIVE" },
    } as never);
    const created = await call("POST", "/v1/evidence", A.memberToken, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: A.teamId,
      originalFileName: "a.jpg",
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const bytes = Buffer.from(`C101-${randomBytes(6).toString("hex")}`);
    const web = { "x-web-client": "1", "x-proovra-workspace-id": B.teamId };

    const movedPart = await call("POST", `/v1/evidence/${id}/parts`, A.memberToken, presignBody(bytes), web);
    expect(movedPart.statusCode, movedPart.body).toBe(409);
    expect(movedPart.json().code).toBe("CAPTURE_WORKSPACE_CHANGED");
    expect(await prisma.evidencePart.count({ where: { evidenceId: id } })).toBe(0);

    const movedComplete = await call("POST", `/v1/evidence/${id}/complete`, A.memberToken, {}, web);
    expect(movedComplete.statusCode, movedComplete.body).toBe(409);
    expect(movedComplete.json().code).toBe("CAPTURE_WORKSPACE_CHANGED");
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true, signatureBase64: true } });
    expect(ev.signatureBase64).toBeNull();
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "EVIDENCE_COMPLETED" } })).toBe(0);

    // The same web page in the record's own workspace writes normally.
    const samePart = await call("POST", `/v1/evidence/${id}/parts`, A.memberToken, presignBody(bytes), {
      "x-web-client": "1",
      "x-proovra-workspace-id": A.teamId,
    });
    expect([200, 201], samePart.body).toContain(samePart.statusCode);
    // A non-web client naming another workspace is not held to the web rule.
    const mobilePart = await call("POST", `/v1/evidence/${id}/parts`, A.memberToken, presignBody(bytes), {
      "x-proovra-workspace-id": B.teamId,
    });
    expect([200, 201], mobilePart.body).toContain(mobilePart.statusCode);
  }, 240_000);

  // --- PRO-NBC-01 -------------------------------------------------------------

  async function stagedSession(t0: Date, staged: boolean) {
    const A = h.fixtures.teamA;
    const open = await svc.openDirectCaptureSession({
      ownerUserId: A.ownerUserId,
      teamId: A.teamId,
      mode: "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS",
      deviceId: null,
      now: t0,
    });
    const reserved = await svc.reserveDirectCaptureEvidence({
      sessionId: open.captureSessionId,
      ownerUserId: A.ownerUserId,
      type: "VIDEO",
      mimeType: "video/mp4",
      now: new Date(t0.getTime() + MIN),
    } as never);
    await svc.declareDirectCapturePart({
      sessionId: open.captureSessionId,
      ownerUserId: A.ownerUserId,
      partIndex: 0,
      sha256: hexDigest(),
      clientReportedSource: "UNKNOWN",
      signed: null,
      now: new Date(t0.getTime() + 2 * MIN),
    });
    if (staged) {
      await prisma.evidencePart.create({
        data: {
          evidenceId: reserved.evidenceId,
          partIndex: 0,
          storageBucket: "ws-cap-test-bucket",
          storageKey: `evidence/${reserved.evidenceId}/parts/000-seg.mp4`,
        },
      });
    }
    return { sessionId: open.captureSessionId, evidenceId: reserved.evidenceId };
  }

  it("PRO-NBC-01: a staged session idle past its hour stays live until start + 24 h; unstaged and over-lifetime still expire", async () => {
    const A = h.fixtures.teamA;
    const t0 = new Date(Date.now() - 2 * 60 * MIN);
    const declareAt = (sessionId: string, partIndex: number, at: Date) =>
      svc.declareDirectCapturePart({
        sessionId,
        ownerUserId: A.ownerUserId,
        partIndex,
        sha256: hexDigest(),
        clientReportedSource: "UNKNOWN",
        signed: null,
        now: at,
      });

    // Staged, idle two hours, reaper not yet run: live, expiry slides.
    const staged = await stagedSession(t0, true);
    const twoHours = new Date(t0.getTime() + 120 * MIN);
    await expect(declareAt(staged.sessionId, 1, twoHours)).resolves.toMatchObject({ created: true });
    const kept = await prisma.captureSession.findUniqueOrThrow({
      where: { id: staged.sessionId },
      select: { status: true, expiresAtUtc: true },
    });
    expect(kept.status).toBe("ACTIVE");
    expect(kept.expiresAtUtc!.getTime()).toBe(twoHours.getTime() + 60 * MIN);
    // The server says so to the client.
    const listed = await svc.listDirectCaptureParts({ sessionId: staged.sessionId, ownerUserId: A.ownerUserId });
    expect(listed.session.status).toBe("ACTIVE");
    expect(listed.session.maxExpiresAtUtc).toBe(new Date(t0.getTime() + 24 * 60 * MIN).toISOString());

    // Nothing staged: the one-hour idle expiry still ends it.
    const empty = await stagedSession(new Date(Date.now() - 2 * 60 * MIN), false);
    const emptyRow = await prisma.captureSession.findUniqueOrThrow({ where: { id: empty.sessionId }, select: { startedAtUtc: true } });
    await expect(
      declareAt(empty.sessionId, 1, new Date(emptyRow.startedAtUtc!.getTime() + 120 * MIN)),
    ).rejects.toMatchObject({ code: "CAPTURE_WINDOW_EXPIRED" });

    // Staged but past its maximum lifetime: expired.
    const old = await stagedSession(new Date(Date.now() - 2 * 60 * MIN), true);
    const oldRow = await prisma.captureSession.findUniqueOrThrow({ where: { id: old.sessionId }, select: { startedAtUtc: true } });
    await expect(
      declareAt(old.sessionId, 1, new Date(oldRow.startedAtUtc!.getTime() + 24 * 60 * MIN + MIN)),
    ).rejects.toMatchObject({ code: "CAPTURE_WINDOW_EXPIRED" });
  }, 240_000);

  // --- PRO-NBC-02 -------------------------------------------------------------

  it("PRO-NBC-02: the owner's heartbeat slides a capturing session's expiry; another user gets the unknown-session answer", async () => {
    const A = h.fixtures.teamA;
    const open = await call("POST", "/v1/capture/direct-sessions", A.ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: A.teamId,
      deviceId: null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const sid = open.json().session.captureSessionId as string;
    // Pretend the recording started 50 minutes ago and nothing slid since.
    const soon = new Date(Date.now() + 10 * MIN);
    await prisma.captureSession.update({ where: { id: sid }, data: { expiresAtUtc: soon } });
    const beat = await call("POST", `/v1/capture/direct-sessions/${sid}/heartbeat`, A.ownerToken, {});
    expect(beat.statusCode, beat.body).toBe(200);
    const after = await prisma.captureSession.findUniqueOrThrow({ where: { id: sid }, select: { expiresAtUtc: true } });
    expect(after.expiresAtUtc!.getTime()).toBeGreaterThan(soon.getTime() + 30 * MIN);
    const stranger = await call("POST", `/v1/capture/direct-sessions/${sid}/heartbeat`, h.fixtures.teamB.ownerToken, {});
    expect(stranger.statusCode).toBe(404);
  }, 240_000);

  // --- PRO-C1-05 --------------------------------------------------------------

  it("PRO-C1-05: a member demoted to Viewer cannot autosave a team draft; discard still works", async () => {
    const A = h.fixtures.teamA;
    const draft = await call("POST", "/v1/capture/sessions", A.memberToken, { teamId: A.teamId });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = (draft.json().session?.id ?? draft.json().id) as string;
    const ok = await call("PATCH", `/v1/capture/sessions/${draftId}`, A.memberToken, { internalNotes: "first" });
    expect(ok.statusCode, ok.body).toBe(200);
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
      data: { role: "VIEWER" },
    } as never);
    try {
      const refused = await call("PATCH", `/v1/capture/sessions/${draftId}`, A.memberToken, { internalNotes: "second" });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().code).toBe("NOT_PERMITTED");
      const row = await prisma.captureSession.findUniqueOrThrow({ where: { id: draftId }, select: { internalNotes: true } });
      expect(row.internalNotes).toBe("first");
      const discard = await call("DELETE", `/v1/capture/sessions/${draftId}`, A.memberToken);
      expect(discard.statusCode, discard.body).toBe(200);
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: A.teamId, userId: A.memberUserId } },
        data: { role: "MEMBER" },
      } as never);
    }
  }, 240_000);

  // --- PRO-C1-02 --------------------------------------------------------------

  it("PRO-C1-02: a post-commit retention failure answers the sealed record with protection pending repair; recovery re-drives it", async () => {
    const t: PersonalTenant = await seedPersonalTenant(deps, "FREE");
    const bytes = Buffer.from(`C102-${randomBytes(6).toString("hex")}`);
    const created = await call("POST", "/v1/evidence", t.owner.token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: t.personalTeamId,
      originalFileName: "a.jpg",
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const presign = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, presignBody(bytes));
    expect([200, 201], presign.body).toContain(presign.statusCode);
    objects.set(decodeURIComponent(new URL(presign.json().upload.putUrl as string).pathname.slice(1)), bytes);

    retention.fail = true;
    const done = await call("POST", `/v1/evidence/${id}/complete`, t.owner.token, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().storageProtection).toBe("PENDING_REPAIR");
    const ev = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { status: true, storageObjectLockMode: true } });
    expect(["SIGNED", "REPORTED"]).toContain(ev.status);
    expect(ev.storageObjectLockMode).toBeNull();
    const outcomes = await prisma.custodyEvent.findMany({
      where: { evidenceId: id, eventType: "STORAGE_PROTECTION_UNAVAILABLE" },
      select: { payload: true },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.payload).toMatchObject({ phase: complete.STORAGE_PROTECTION_PENDING_REPAIR_PHASE });

    // The recovery pass selects it and re-drives the existing sealed-record repair.
    retention.fail = false;
    const signedAt = (await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { signedAtUtc: true } })).signedAtUtc!;
    const summary = await complete.recoverSealedRecordObligations({ now: new Date(signedAt.getTime() + 11 * MIN) });
    expect(summary.protectionCandidates).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);
    // Recorded once: a repeat never stacks another outcome.
    expect(await prisma.custodyEvent.count({ where: { evidenceId: id, eventType: "STORAGE_PROTECTION_UNAVAILABLE" } })).toBe(1);
  }, 240_000);

  // --- PRO-C1-11 / PRO-C1-09 / PRO-C1C-02 -------------------------------------

  async function reservedRecord(): Promise<string> {
    const A = h.fixtures.teamA;
    const created = await call("POST", "/v1/evidence", A.ownerToken, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: A.teamId,
      originalFileName: "big.jpg",
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().id as string;
  }

  it("PRO-C1-11: a reused idempotency key with another declared file is a conflict; the identical replay is reused", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await reservedRecord();
    const base = {
      teamId: A.teamId,
      evidenceId,
      actorUserId: A.ownerUserId,
      expectedPartCount: 2,
      expectedTotalBytes: 200 * 1024 * 1024,
      expectedSha256: "a".repeat(64),
      idempotencyKey: `capture:${evidenceId}:0`,
      targetPartIndex: 0,
    };
    const first = await uploads.createUploadSession(base, prisma as never);
    expect(first.ok).toBe(true);
    const replay = await uploads.createUploadSession(base, prisma as never);
    expect(replay).toMatchObject({ ok: true, reused: true });
    const changed = await uploads.createUploadSession({ ...base, expectedSha256: "b".repeat(64) }, prisma as never);
    expect(changed).toMatchObject({ ok: false, reason: "idempotency_key_conflict" });
  }, 240_000);

  it("PRO-C1-09: a session past its declared lifetime accepts no further part acknowledgement", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await reservedRecord();
    const made = await uploads.createUploadSession(
      { teamId: A.teamId, evidenceId, actorUserId: A.ownerUserId, expectedPartCount: 1 },
      prisma as never,
    );
    expect(made.ok).toBe(true);
    const sessionId = (made as { session: { id: string } }).session.id;
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence_upload_sessions" SET "created_at_utc" = NOW() - interval '20 minutes', "expires_at_utc" = NOW() - interval '10 minutes' WHERE "id" = $1`,
      sessionId,
    );
    const late = await uploads.markPartUploaded({ teamId: A.teamId, sessionId, partIndex: 0 }, prisma as never);
    expect(late).toMatchObject({ ok: false, reason: "session_already_terminal" });
  }, 240_000);

  it("PRO-C1C-02: a part written 23 h after creation keeps the reservation live for another window", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await reservedRecord();
    const old = new Date(Date.now() - 23 * 60 * MIN);
    await prisma.$executeRawUnsafe(
      `UPDATE "evidence" SET "created_at" = $2, "updated_at" = $2 WHERE "id" = $1::uuid`,
      evidenceId,
      old,
    );
    const bytes = Buffer.from(`C1C02-${randomBytes(6).toString("hex")}`);
    const presign = await call("POST", `/v1/evidence/${evidenceId}/parts`, A.ownerToken, presignBody(bytes, "big.jpg"));
    expect([200, 201], presign.body).toContain(presign.statusCode);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { updatedAt: true } });
    expect(row.updatedAt.getTime()).toBeGreaterThan(Date.now() - 5 * MIN);
  }, 240_000);

  // --- PRO-C1Z-01 -------------------------------------------------------------

  it("PRO-C1Z-01: a sealed record whose fan-out never finished is completed by the recovery pass, once", async () => {
    const t: PersonalTenant = await seedPersonalTenant(deps, "FREE");
    const bytes = Buffer.from(`C1Z01-${randomBytes(6).toString("hex")}`);
    const created = await call("POST", "/v1/evidence", t.owner.token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: t.personalTeamId,
      originalFileName: "a.jpg",
    });
    const id = created.json().id as string;
    const presign = await call("POST", `/v1/evidence/${id}/parts`, t.owner.token, presignBody(bytes));
    objects.set(decodeURIComponent(new URL(presign.json().upload.putUrl as string).pathname.slice(1)), bytes);
    const done = await call("POST", `/v1/evidence/${id}/complete`, t.owner.token, {});
    expect(done.statusCode, done.body).toBe(200);
    // The process "died" after the commit: no done marker, no live claim.
    const sealedAt = new Date(Date.now() - 30 * MIN);
    await prisma.evidence.update({
      where: { id },
      data: { completionFanoutDoneAtUtc: null, completionFanoutClaimedAtUtc: null, signedAtUtc: sealedAt },
    });
    const first = await complete.recoverSealedRecordObligations({ now: new Date() });
    expect(first.fanoutRecovered).toBeGreaterThanOrEqual(1);
    const row = await prisma.evidence.findUniqueOrThrow({ where: { id }, select: { completionFanoutDoneAtUtc: true } });
    expect(row.completionFanoutDoneAtUtc).not.toBeNull();
    // Marked done: a second pass does not run it again.
    const again = await complete.recoverSealedRecordObligations({ now: new Date() });
    const candidates = await prisma.evidence.count({ where: { id, completionFanoutDoneAtUtc: null } });
    expect(candidates).toBe(0);
    expect(again.failed).toBe(0);
  }, 240_000);

  // --- PRO-C1-03 --------------------------------------------------------------

  it("PRO-C1-03: an assembled session object no part references is removed; a referenced one never is", async () => {
    const A = h.fixtures.teamA;
    const evidenceId = await reservedRecord();
    const listed: string[] = [];
    const storage = {
      listObjectVersions: async (p: { bucket: string; key: string }) => {
        listed.push(p.key);
        return [];
      },
      deleteObjectVersion: async () => ({ deleted: true }),
    } as never;
    const { discardUnboundSessionObject } = cleanup;
    const orphan = { bucket: "ws-cap-test-bucket", key: `evidence/${evidenceId}/multipart/s-1/object` };
    await discardUnboundSessionObject(evidenceId, orphan, { storage, client: prisma as never });
    expect(listed).toEqual([orphan.key]);

    listed.length = 0;
    const bound = { bucket: "ws-cap-test-bucket", key: `evidence/${evidenceId}/multipart/s-2/object` };
    await prisma.evidencePart.create({ data: { evidenceId, partIndex: 0, storageBucket: bound.bucket, storageKey: bound.key } });
    await discardUnboundSessionObject(evidenceId, bound, { storage, client: prisma as never });
    expect(listed).toEqual([]);
    void A;
  }, 240_000);

  // --- PRO-N1-10 --------------------------------------------------------------

  it("PRO-N1-10: a legacy record with no workspace resolves to its owner's Personal workspace, for the owner only", async () => {
    const t: PersonalTenant = await seedPersonalTenant(deps, "FREE");
    const created = await call("POST", "/v1/evidence", t.owner.token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: t.personalTeamId,
      originalFileName: "legacy.jpg",
    });
    const id = created.json().id as string;
    await prisma.$executeRawUnsafe(`UPDATE "evidence" SET "team_id" = NULL WHERE "id" = $1::uuid`, id);
    const owner = await call("POST", "/v1/deep-link/resolve", t.owner.token, { resourceType: "evidence", resourceId: id });
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().workspaceId).toBe(t.personalTeamId);
    const other = await call("POST", "/v1/deep-link/resolve", h.fixtures.teamB.ownerToken, { resourceType: "evidence", resourceId: id });
    expect(other.statusCode).toBe(404);
  }, 240_000);

  // --- PRO-T1-16 --------------------------------------------------------------

  it("PRO-T1-16: the context describes the workspace this client names, and the shared pointer does not move", async () => {
    const A = h.fixtures.teamA;
    const B = h.fixtures.teamB;
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: B.teamId, userId: A.memberUserId } },
      create: { teamId: B.teamId, userId: A.memberUserId, role: "MEMBER", status: "ACTIVE" },
      update: { status: "ACTIVE" },
    } as never);
    await prisma.user.update({ where: { id: A.memberUserId }, data: { currentWorkspaceId: A.teamId } });
    const named = await call("GET", "/v1/platform/context", A.memberToken, undefined, { "x-proovra-workspace-id": B.teamId });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json().activeSpace?.id ?? named.json().workspace?.id).toBe(B.teamId);
    const pointer = await prisma.user.findUniqueOrThrow({ where: { id: A.memberUserId }, select: { currentWorkspaceId: true } });
    expect(pointer.currentWorkspaceId).toBe(A.teamId);
    // A workspace the caller cannot enter is not used: the pointer answers.
    const foreign = await call("GET", "/v1/platform/context", A.memberToken, undefined, {
      "x-proovra-workspace-id": "00000000-0000-4000-8000-000000000000",
    });
    expect(foreign.statusCode, foreign.body).toBe(200);
    expect(foreign.json().activeSpace?.id ?? foreign.json().workspace?.id).toBe(A.teamId);
  }, 240_000);
});
