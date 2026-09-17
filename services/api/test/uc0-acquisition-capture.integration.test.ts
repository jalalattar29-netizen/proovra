/**
 * UC-0a / UC-0b — ACQUISITION AUTHORITY + DIRECT-CAPTURE SESSION ADAPTER,
 * executed end to end against a real database through the real HTTP routes.
 *
 * The code under test is the production path: the direct-session routes, the
 * canonical `authorizeOrFail`, `createEvidence`, the canonical part presign
 * route, `completeEvidence` (server hashing, fingerprint, custody, billing
 * settlement) and the trust-event chain. Only the outermost adapters are
 * doubled: the object store (in-process), the evidence signer (a deterministic
 * test signer — never a real key) and the TSA (not configured → null, the
 * production behaviour when no TSA is set).
 *
 * WHAT IT PROVES
 *   * acquisition is recorded at creation and survives completion unchanged
 *     (web upload and mobile session), while captureMethod stays a structure
 *     field;
 *   * a session is server-issued (nonce returned once, only its hash stored),
 *     bound to exactly one Evidence, sealed only through its session, and bound
 *     by exactly ONE CAPTURE_SESSION_BOUND event mirrored to custody;
 *   * a digest mismatch is refused BEFORE signing and interrupts the session;
 *   * replay, wrong session, reused/expired sessions, forged/modified signed
 *     payloads and cross-workspace / non-member / viewer callers are refused
 *     without leaking existence;
 *   * the retired receipt-only mobile ingest and the citizen routes answer 410;
 *   * attestation cannot be forged: client metadata never yields a verified
 *     verdict, a missing/malformed assertion fails closed, a replayed nonce is
 *     refused, and legacy positive rows re-project as UNVERIFIED;
 *   * the public Verify projection states acquisition neutrally, never carries
 *     a session or device id, and a legacy record reads "Not recorded".
 */
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { IntegrationHarness } from "./integration-harness.js";

// -----------------------------------------------------------------------------
// Outermost adapters
// -----------------------------------------------------------------------------

const objects = vi.hoisted(() => new Map<string, Buffer>());

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://uc0-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
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
        signatureBase64: Buffer.from(`uc0-test-signature:${hex}`).toString("base64"),
        keyId: "uc0-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

const BUCKET = "uc0-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("UC-0 acquisition + direct capture — live PostgreSQL 16", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    // The fixture Organization workspace has no paid plan, and the canonical
    // commercial gate (correctly) refuses evidence creation in it. Give it one
    // for this suite; restored in afterAll.
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

  let originalBilling: Record<string, unknown> | null = null;

  afterAll(async () => {
    if (harness && originalBilling) {
      await prisma.team
        .update({ where: { id: harness.fixtures.teamA.teamId }, data: originalBilling as never })
        .catch(() => undefined);
    }
    await harness?.cleanup();
  }, 120_000);

  function call(
    method: "GET" | "POST",
    url: string,
    token: string,
    payload?: unknown,
  ) {
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

  /** Open → reserve → presign part 0 (canonical route) → store bytes. */
  async function stageSession(
    bytes: Buffer,
    opts: { deviceId?: string | null; token?: string; teamId?: string } = {},
  ) {
    const token = opts.token ?? owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: opts.teamId ?? owner().teamId,
      deviceId: opts.deviceId ?? null,
    });
    expect(open.statusCode, open.body).toBe(201);
    const session = open.json().session as {
      captureSessionId: string;
      nonceHex: string;
      expiresAtUtc: string;
    };
    const reserve = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/evidence`,
      token,
      { type: "PHOTO", mimeType: "image/jpeg" },
    );
    expect(reserve.statusCode, reserve.body).toBe(201);
    const evidenceId = reserve.json().evidence.evidenceId as string;
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex: 0,
      mimeType: "image/jpeg",
      originalFileName: "camera.jpg",
    });
    expect(part.statusCode, part.body).toBe(201);
    const { bucket, key } = part.json().upload as { bucket: string; key: string };
    objects.set(`${bucket}/${key}`, bytes);
    return { token, session, evidenceId };
  }

  async function bindEvents(sessionId: string) {
    return prisma.captureTrustEventRecord.findMany({
      where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" },
      select: { evidenceId: true, payload: true },
    });
  }

  // ===========================================================================
  // Acquisition authority through the real routes
  // ===========================================================================

  it("web upload records PROOVRA_WEB_UPLOAD and completion never changes it", async () => {
    const token = owner().ownerToken;
    const created = await call("POST", "/v1/evidence", token, {
      type: "PHOTO",
      mimeType: "image/jpeg",
      teamId: owner().teamId,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const before = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { acquisitionMode: true, acquisitionModeSource: true, storageBucket: true, storageKey: true },
    });
    expect(before.acquisitionMode).toBe("PROOVRA_WEB_UPLOAD");
    expect(before.acquisitionModeSource).toBe("RECORDED_AT_CREATION");

    // Two parts → a multipart record, the case that used to rewrite
    // captureMethod to MULTIPART_PACKAGE.
    for (const i of [0, 1]) {
      const part = await call("POST", `/v1/evidence/${id}/parts`, token, {
        partIndex: i,
        mimeType: "image/jpeg",
        originalFileName: `Screenshot_2026-09-16_${i}.png`,
      });
      expect(part.statusCode, part.body).toBe(201);
      const u = part.json().upload;
      objects.set(`${u.bucket}/${u.key}`, Buffer.from(`web-part-${i}-${randomBytes(4).toString("hex")}`));
    }
    const done = await call("POST", `/v1/evidence/${id}/complete`, token, {});
    expect(done.statusCode, done.body).toBe(200);

    const after = await prisma.evidence.findUniqueOrThrow({
      where: { id },
      select: { status: true, acquisitionMode: true, acquisitionModeSource: true, captureMethod: true },
    });
    expect(after.status).toBe("SIGNED");
    // The acquisition is untouched by completion; the file name that looks
    // like a screenshot changed nothing.
    expect(after.acquisitionMode).toBe("PROOVRA_WEB_UPLOAD");
    expect(after.acquisitionModeSource).toBe("RECORDED_AT_CREATION");
    // captureMethod is the STRUCTURE field and says so.
    expect(after.captureMethod).toBe("MULTIPART_PACKAGE");

    // The creation custody event carries the acquisition.
    const createdEvent = await prisma.custodyEvent.findFirstOrThrow({
      where: { evidenceId: id, eventType: "EVIDENCE_CREATED" },
      select: { payload: true },
    });
    expect((createdEvent.payload as Record<string, unknown>).acquisitionMode).toBe(
      "PROOVRA_WEB_UPLOAD",
    );

    // Library projection + filter use the same authority.
    const list = await call(
      "GET",
      `/v1/evidence?scope=all&acquisition=UPLOAD&limit=50`,
      token,
    );
    expect(list.statusCode, list.body).toBe(200);
    const items = (list.json().items ?? []) as Array<{ id: string; acquisition?: { mode: string } }>;
    const mine = items.find((x) => x.id === id);
    expect(mine?.acquisition?.mode).toBe("PROOVRA_WEB_UPLOAD");
    const intakeOnly = await call(
      "GET",
      `/v1/evidence?scope=all&acquisition=SECURE_INTAKE&limit=50`,
      token,
    );
    expect(((intakeOnly.json().items ?? []) as Array<{ id: string }>).some((x) => x.id === id)).toBe(false);
  });

  it("a mobile session records PROOVRA_MOBILE_APP, seals through its session and binds exactly once", async () => {
    const bytes = Buffer.from(`mobile-photo-${randomBytes(8).toString("hex")}`);
    const { token, session, evidenceId } = await stageSession(bytes);

    // The nonce is returned once; only its hash is stored.
    const stored = await prisma.captureSession.findUniqueOrThrow({
      where: { id: session.captureSessionId },
      select: { nonceSha256: true, status: true, finalizedEvidenceId: true, acquisitionMode: true },
    });
    expect(stored.nonceSha256).toBe(sha256(session.nonceHex));
    expect(stored.status).toBe("ACTIVE");
    expect(stored.finalizedEvidenceId).toBe(evidenceId);

    // Completing through the generic route is refused: the session must seal it.
    const generic = await call("POST", `/v1/evidence/${evidenceId}/complete`, token, {});
    expect(generic.statusCode).toBe(409);

    // Completion without a declaration is refused before signing.
    const undeclared = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/complete`,
      token,
    );
    expect(undeclared.statusCode).toBe(409);
    expect(undeclared.json().denial).toBe("CAPTURE_PART_DECLARATION_MISMATCH");
    // …which interrupted the session: its claims no longer match.
    const s2 = await prisma.captureSession.findUniqueOrThrow({
      where: { id: session.captureSessionId },
      select: { status: true },
    });
    expect(s2.status).toBe("INTERRUPTED");
    expect(
      (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } })).status,
    ).not.toBe("SIGNED");

    // A fresh session, done properly.
    const good = await stageSession(Buffer.from(`mobile-photo-${randomBytes(8).toString("hex")}`));
    const goodBytes = objects.get(
      [...objects.keys()].find((k) => k.includes(good.evidenceId))!,
    )!;
    const declare = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/parts/0/declaration`,
      good.token,
      { sha256: sha256(goodBytes), clientReportedSource: "CAMERA", signed: null },
    );
    expect(declare.statusCode, declare.body).toBe(201);
    // Idempotent re-declaration of the same digest; a different one is refused.
    const again = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/parts/0/declaration`,
      good.token,
      { sha256: sha256(goodBytes), clientReportedSource: "CAMERA", signed: null },
    );
    expect(again.statusCode).toBe(200);
    const conflicting = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/parts/0/declaration`,
      good.token,
      { sha256: "f".repeat(64), clientReportedSource: "CAMERA", signed: null },
    );
    expect(conflicting.statusCode).toBe(409);

    const done = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/complete`,
      good.token,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result).toMatchObject({ bound: true, alreadyBound: false, digestsConfirmed: 1 });

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: good.evidenceId },
      select: { status: true, acquisitionMode: true, acquisitionModeSource: true, fileSha256: true },
    });
    expect(ev.status).toBe("SIGNED");
    expect(ev.acquisitionMode).toBe("PROOVRA_MOBILE_APP");
    expect(ev.acquisitionModeSource).toBe("RECORDED_AT_CREATION");
    expect(ev.fileSha256).toBe(sha256(goodBytes));

    // Exactly ONE bind event, mirrored to custody once.
    const binds = await bindEvents(good.session.captureSessionId);
    expect(binds).toHaveLength(1);
    expect(binds[0]!.evidenceId).toBe(good.evidenceId);
    const custodyBinds = (
      await prisma.custodyEvent.findMany({
        where: { evidenceId: good.evidenceId, eventType: "CAPTURE_TRUST_EVENT" },
        select: { payload: true },
      })
    ).filter((e) => (e.payload as Record<string, unknown>).code === "CAPTURE_SESSION_BOUND");
    expect(custodyBinds).toHaveLength(1);

    // Replaying completion binds nothing new.
    const replay = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/complete`,
      good.token,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().result.alreadyBound).toBe(true);
    expect(await bindEvents(good.session.captureSessionId)).toHaveLength(1);

    // A completed session cannot be reused.
    const reuse = await call(
      "POST",
      `/v1/capture/direct-sessions/${good.session.captureSessionId}/evidence`,
      good.token,
      { type: "PHOTO" },
    );
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().denial).toBe("SESSION_NOT_ACTIVE");

    // The provenance chain (private) and the public projection agree.
    const chainRes = await harness.app.inject({
      method: "GET",
      url: `/v1/provenance/${good.evidenceId}`,
      headers: { authorization: `Bearer ${good.token}` },
    });
    // The provenance route resolves the CURRENT workspace pointer; either it
    // answers with the chain or refuses — it never guesses.
    if (chainRes.statusCode === 200) {
      const chain = chainRes.json().chain;
      expect(chain.schemaVersion).toBe("PROOVRA_PROVENANCE_CHAIN_V2");
      expect(chain.capture.mode).toBe("PROOVRA_MOBILE_APP");
      expect(chain.captureSession.status).toBe("BOUND");
    }
    const { loadPublicVerifyAcquisition, loadProvenanceChain } = await import("@proovra/shared-runtime");
    const chain = await loadProvenanceChain(prisma, good.evidenceId);
    expect(chain.acquisition.mode).toBe("PROOVRA_MOBILE_APP");
    expect(chain.captureSession?.digestsConfirmed).toBe(1);
    const pub = await loadPublicVerifyAcquisition(prisma, good.evidenceId);
    expect(pub.acquisition.mode).toBe("PROOVRA_MOBILE_APP");
    expect(pub.acquisition.isDirectCapture).toBe(false);
    expect(pub.captureSession?.outcome).toBe("BOUND");
    expect(pub.deviceAttestation.verified).toBe(false);
    expect(pub.integrity.establishedAtUtc).not.toBeNull();
    expect(pub.artifacts).toEqual({ original: 1, captureRecord: 0, derived: 0 });
    const serialized = JSON.stringify(pub);
    expect(serialized).not.toContain(good.session.captureSessionId);
    expect(serialized).not.toContain(good.session.nonceHex);
    expect(serialized).not.toMatch(/verified at source|authentic|tamper-proof/i);
  });

  it("a digest mismatch is refused before signing and interrupts the session", async () => {
    const bytes = Buffer.from(`real-bytes-${randomBytes(8).toString("hex")}`);
    const { token, session, evidenceId } = await stageSession(bytes);
    const declare = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/parts/0/declaration`,
      token,
      { sha256: sha256("different bytes"), clientReportedSource: "CAMERA", signed: null },
    );
    expect(declare.statusCode).toBe(201);
    const done = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/complete`,
      token,
    );
    expect(done.statusCode).toBe(409);
    expect(done.json().denial).toBe("CAPTURE_DIGEST_MISMATCH");

    const ev = await prisma.evidence.findUniqueOrThrow({
      where: { id: evidenceId },
      select: { status: true, signatureBase64: true, fileSha256: true },
    });
    expect(ev.status).not.toBe("SIGNED");
    expect(ev.signatureBase64).toBeNull();
    expect(
      await prisma.custodyEvent.count({ where: { evidenceId, eventType: "SIGNATURE_APPLIED" } }),
    ).toBe(0);
    const s = await prisma.captureSession.findUniqueOrThrow({
      where: { id: session.captureSessionId },
      select: { status: true, endReason: true },
    });
    expect(s).toEqual({ status: "INTERRUPTED", endReason: "CAPTURE_DIGEST_MISMATCH" });
    expect(await bindEvents(session.captureSessionId)).toHaveLength(0);
    // The failure is recorded as a bounded trust event.
    const failures = await prisma.captureTrustEventRecord.count({
      where: { captureSessionId: session.captureSessionId, code: "CAPTURE_ARTIFACT_VERIFICATION_FAILED" },
    });
    expect(failures).toBe(1);
    // And nothing can seal it afterwards.
    const retry = await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/complete`,
      token,
    );
    expect(retry.statusCode).toBe(409);
    const generic = await call("POST", `/v1/evidence/${evidenceId}/complete`, token, {});
    expect(generic.statusCode).toBe(409);
  });

  it("replay, reservation reuse and expiry are refused", async () => {
    const token = owner().ownerToken;
    const open = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
    });
    const sid = open.json().session.captureSessionId as string;
    const first = await call("POST", `/v1/capture/direct-sessions/${sid}/evidence`, token, { type: "PHOTO" });
    expect(first.statusCode).toBe(201);
    const second = await call("POST", `/v1/capture/direct-sessions/${sid}/evidence`, token, { type: "PHOTO" });
    expect(second.statusCode).toBe(409);
    expect(second.json().denial).toBe("SESSION_ALREADY_RESERVED");

    // Expired.
    const open2 = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
    });
    const sid2 = open2.json().session.captureSessionId as string;
    await prisma.captureSession.update({
      where: { id: sid2 },
      data: { expiresAtUtc: new Date(Date.now() - 1000) },
    });
    const expired = await call("POST", `/v1/capture/direct-sessions/${sid2}/evidence`, token, { type: "PHOTO" });
    expect(expired.statusCode).toBe(409);
    expect(expired.json().denial).toBe("SESSION_EXPIRED");
    expect(
      (await prisma.captureSession.findUniqueOrThrow({ where: { id: sid2 }, select: { status: true } })).status,
    ).toBe("INTERRUPTED");

    // Client-chosen fields that are not part of the contract are rejected.
    const smuggled = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: owner().teamId,
      acquisitionMode: "SECURE_INTAKE_LINK",
    });
    expect(smuggled.statusCode).toBeGreaterThanOrEqual(400);
    const badMode = await call("POST", "/v1/capture/direct-sessions", token, {
      mode: "PROOVRA_WEB_UPLOAD",
      teamId: owner().teamId,
    });
    expect(badMode.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("authorization: cross-workspace, non-owner, viewer and outsider are refused without leaking existence", async () => {
    const a = owner();
    const b = harness.fixtures.teamB;
    // Opening a session in a workspace the caller is not a member of.
    const cross = await call("POST", "/v1/capture/direct-sessions", a.ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: b.teamId,
    });
    expect(cross.statusCode).toBe(404);
    // A viewer may not create evidence.
    const viewer = await call("POST", "/v1/capture/direct-sessions", a.viewerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: a.teamId,
    });
    expect([403, 404]).toContain(viewer.statusCode);

    // A session belongs to its owner only: another member of the SAME
    // workspace, and an outsider, get the same 404 as an unknown id.
    const open = await call("POST", "/v1/capture/direct-sessions", a.ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: a.teamId,
    });
    const sid = open.json().session.captureSessionId as string;
    for (const token of [a.memberToken, b.ownerToken]) {
      const r = await call("POST", `/v1/capture/direct-sessions/${sid}/evidence`, token, { type: "PHOTO" });
      expect(r.statusCode).toBe(404);
      expect(r.json().denial).toBe("SESSION_NOT_FOUND");
    }
    const unknown = await call(
      "POST",
      `/v1/capture/direct-sessions/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/evidence`,
      a.ownerToken,
      { type: "PHOTO" },
    );
    expect(unknown.statusCode).toBe(404);

    // A member whose membership ends mid-session loses the session.
    const memberOpen = await call("POST", "/v1/capture/direct-sessions", a.memberToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: a.teamId,
    });
    expect(memberOpen.statusCode, memberOpen.body).toBe(201);
    const msid = memberOpen.json().session.captureSessionId as string;
    await prisma.teamMember.update({
      where: { teamId_userId: { teamId: a.teamId, userId: a.memberUserId } },
      data: { status: "SUSPENDED" },
    });
    try {
      const r = await call("POST", `/v1/capture/direct-sessions/${msid}/evidence`, a.memberToken, { type: "PHOTO" });
      expect([401, 403, 404]).toContain(r.statusCode);
      expect(
        (await prisma.captureSession.findUniqueOrThrow({ where: { id: msid }, select: { finalizedEvidenceId: true } }))
          .finalizedEvidenceId,
      ).toBeNull();
    } finally {
      await prisma.teamMember.update({
        where: { teamId_userId: { teamId: a.teamId, userId: a.memberUserId } },
        data: { status: "ACTIVE" },
      });
    }
  });

  it("device-bound sessions require a signature over THIS session's nonce and digest", async () => {
    const { canonicalize } = await import("../src/services/capture-trust/canonical-json.js");
    const a = owner();
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const rawPub = Buffer.from(
      (publicKey.export({ format: "jwk" }) as { x: string }).x,
      "base64url",
    ).toString("hex");
    const device = await prisma.device.create({
      data: {
        teamId: a.teamId,
        ownerUserId: a.ownerUserId,
        label: "UC-0 test device",
        publicKeyHex: rawPub,
        publicKeyFingerprint: sha256(rawPub),
        attestationProvider: "NONE",
        signatureAlgorithm: "Ed25519",
      },
      select: { id: true },
    });

    const bytes = Buffer.from(`signed-photo-${randomBytes(8).toString("hex")}`);
    const { token, session, evidenceId } = await stageSession(bytes, { deviceId: device.id });
    const url = `/v1/capture/direct-sessions/${session.captureSessionId}/parts/0/declaration`;
    const payload = {
      schemaVersion: "PROOVRA_CAPTURE_SIG_V1" as const,
      assetHash: sha256(bytes),
      captureMode: "PROOVRA_MOBILE_APP" as const,
      provenanceClass: "B" as const,
      deviceKeyId: device.id,
      algorithm: "Ed25519" as const,
      captureSessionId: session.captureSessionId,
      signedAtUtc: new Date().toISOString(),
      signedAtMonotonicNs: "1",
      nonceHex: session.nonceHex,
      metadata: {
        deviceModel: "test",
        osVersion: "test",
        appVersion: "test",
        networkState: "ONLINE" as const,
        locationPolicy: "OFF" as const,
        location: null,
        camera: null,
        sensor: null,
        operatorContext: null,
      },
    };
    const signOf = (p: unknown) =>
      cryptoSign(null, Buffer.from(canonicalize(p), "utf8"), privateKey).toString("hex");

    // No signature at all.
    let r = await call("POST", url, token, { sha256: sha256(bytes), clientReportedSource: "CAMERA", signed: null });
    expect(r.json().denial).toBe("SIGNATURE_REQUIRED");
    // A client-generated nonce (not the server's).
    const foreignNonce = { ...payload, nonceHex: randomBytes(32).toString("hex") };
    r = await call("POST", url, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: { payload: foreignNonce, signatureHex: signOf(foreignNonce) },
    });
    expect(r.json().denial).toBe("NONCE_MISMATCH");
    // A payload signed for another session.
    const otherSession = { ...payload, captureSessionId: evidenceId };
    r = await call("POST", url, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: { payload: otherSession, signatureHex: signOf(otherSession) },
    });
    expect(r.json().denial).toBe("PAYLOAD_SESSION_MISMATCH");
    // A payload modified after signing.
    const signature = signOf(payload);
    const tampered = { ...payload, signedAtUtc: new Date(Date.now() + 1000).toISOString() };
    r = await call("POST", url, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: { payload: tampered, signatureHex: signature },
    });
    expect(r.json().denial).toBe("SIGNATURE_INVALID");
    // The genuine one.
    r = await call("POST", url, token, {
      sha256: sha256(bytes),
      clientReportedSource: "CAMERA",
      signed: { payload, signatureHex: signature },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().declaration.signatureVerdict).toBe("VALID");

    const done = await call("POST", `/v1/capture/direct-sessions/${session.captureSessionId}/complete`, token);
    expect(done.statusCode, done.body).toBe(200);

    const { loadProvenanceChain } = await import("@proovra/shared-runtime");
    const chain = await loadProvenanceChain(prisma, evidenceId);
    // The failed attempts are recorded, but the accepted declaration verified.
    expect(chain.capture.deviceSignatureVerdict).toBe("VALID");
    expect(chain.capture.provenanceClass).toBe("B");
    expect(chain.trustEventSummary.failures).toBeGreaterThanOrEqual(2);
  });

  it("session attestation is bound to the server nonce and never verifies", async () => {
    const a = owner();
    const device = await prisma.device.create({
      data: {
        teamId: a.teamId,
        ownerUserId: a.ownerUserId,
        label: "UC-0 attesting device",
        publicKeyHex: randomBytes(32).toString("hex"),
        publicKeyFingerprint: randomBytes(32).toString("hex"),
        attestationProvider: "GOOGLE_PLAY_INTEGRITY",
        signatureAlgorithm: "Ed25519",
      },
      select: { id: true },
    });
    const bound = await call("POST", "/v1/capture/direct-sessions", a.ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: a.teamId,
      deviceId: device.id,
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const s = bound.json().session as { captureSessionId: string; nonceHex: string };
    const url = `/v1/capture/direct-sessions/${s.captureSessionId}/attestation`;
    const token = Buffer.from("t".repeat(400)).toString("base64");
    const now = new Date().toISOString();

    // Client-side "verdict" fields are not even accepted by the contract.
    const smuggled = await call("POST", url, a.ownerToken, {
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: token,
      nonceHex: s.nonceHex,
      assertedAtUtc: now,
      providerMetadata: { deviceIntegrityLabel: "MEETS_STRONG_INTEGRITY" },
    });
    expect(smuggled.statusCode).toBeGreaterThanOrEqual(400);

    // A nonce that is not this session's.
    const wrongNonce = await call("POST", url, a.ownerToken, {
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: token,
      nonceHex: randomBytes(32).toString("hex"),
      assertedAtUtc: now,
    });
    expect(wrongNonce.statusCode).toBe(422);
    expect(wrongNonce.json().denial).toBe("NONCE_MISMATCH");

    // The genuine nonce: recorded, and UNVERIFIED.
    const ok = await call("POST", url, a.ownerToken, {
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: token,
      nonceHex: s.nonceHex,
      assertedAtUtc: now,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().attestation).toEqual({
      verdict: "UNVERIFIED",
      failureReason: "CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE",
    });
    // Replaying the same nonce is refused by the verifier.
    const replay = await call("POST", url, a.ownerToken, {
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: token,
      nonceHex: s.nonceHex,
      assertedAtUtc: now,
    });
    expect(replay.json().attestation).toEqual({
      verdict: "FAILED",
      failureReason: "ASSERTION_REPLAYED",
    });
    const codes = (
      await prisma.captureTrustEventRecord.findMany({
        where: { captureSessionId: s.captureSessionId },
        select: { code: true },
      })
    ).map((r) => r.code);
    expect(codes).toContain("ATTESTATION_UNVERIFIED");
    expect(codes).toContain("ATTESTATION_REPLAY_DETECTED");
    expect(codes).not.toContain("ATTESTATION_VERIFIED");

    // An unbound session has no device to attest.
    const unbound = await call("POST", "/v1/capture/direct-sessions", a.ownerToken, {
      mode: "PROOVRA_MOBILE_APP",
      teamId: a.teamId,
    });
    const u = unbound.json().session as { captureSessionId: string; nonceHex: string };
    const noDevice = await call(
      "POST",
      `/v1/capture/direct-sessions/${u.captureSessionId}/attestation`,
      a.ownerToken,
      { provider: "APPLE_APP_ATTEST", rawAssertionBase64: token, nonceHex: u.nonceHex, assertedAtUtc: now },
    );
    expect(noDevice.statusCode).toBe(400);
    expect(noDevice.json().denial).toBe("DEVICE_NOT_BOUND");
  });

  it("the retired receipt-only mobile ingest and the citizen routes answer 410", async () => {
    const ingest = await call("POST", "/v1/capture/mobile/ingest", owner().ownerToken, {});
    expect(ingest.statusCode).toBe(410);
    expect(ingest.json().denial).toBe("INGEST_RETIRED");
    // The citizen limiter runs before the 410 and its per-IP bucket is shared
    // with every other suite in the run (phase13-public-write-bounds drives it
    // to the limit on purpose), so each request comes from its own IPv6
    // documentation address (RFC 3849). Nothing is dialled.
    const freshClient = () => `2001:db8:${randomBytes(2).toString("hex")}:${randomBytes(2).toString("hex")}::1`;
    const citizenOpen = await harness.app.inject({
      method: "POST",
      url: "/v1/intake/citizen/sessions",
      remoteAddress: freshClient(),
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ intakeTokenId: "x", publicKeyHex: "a".repeat(64) }),
    });
    expect(citizenOpen.statusCode).toBe(410);
    const citizenCapture = await harness.app.inject({
      method: "POST",
      url: `/v1/intake/citizen/sessions/${owner().evidenceId}/capture`,
      remoteAddress: freshClient(),
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({}),
    });
    expect(citizenCapture.statusCode).toBe(410);
  });

  // ===========================================================================
  // Attestation cannot be forged
  // ===========================================================================

  it("client metadata never yields a verified attestation; missing, malformed and replayed assertions fail closed", async () => {
    const { verifyDeviceAttestation } = await import(
      "../src/services/capture-trust/attestation-verifier.service.js"
    );
    const a = owner();
    const device = await prisma.device.create({
      data: {
        teamId: a.teamId,
        ownerUserId: a.ownerUserId,
        label: "UC-0 attestation device",
        publicKeyHex: randomBytes(32).toString("hex"),
        publicKeyFingerprint: randomBytes(32).toString("hex"),
        attestationProvider: "GOOGLE_PLAY_INTEGRITY",
      },
      select: { id: true },
    });
    const base = {
      prisma: prisma as never,
      teamId: a.teamId,
      deviceId: device.id,
      captureSessionId: null,
      assertedAtUtc: new Date().toISOString(),
      expiresAtUtc: null,
    };
    const token = Buffer.from("x".repeat(300)).toString("base64");

    // Everything the old providers trusted, and nothing else.
    const forged = [
      { provider: "GOOGLE_PLAY_INTEGRITY" as const, providerMetadata: { deviceIntegrityLabel: "MEETS_STRONG_INTEGRITY", packageName: "x" } },
      { provider: "GOOGLE_PLAY_INTEGRITY" as const, providerMetadata: { deviceIntegrityLabel: "MEETS_DEVICE_INTEGRITY", verdict: "VERIFIED_STRONG", verified: true } },
      { provider: "APPLE_APP_ATTEST" as const, providerMetadata: { chainVerifiedByWorker: true, teamId: "T", bundleId: "B" } },
      { provider: "APPLE_APP_ATTEST" as const, providerMetadata: {} },
      { provider: "TEE_ONLY" as const, providerMetadata: { trustLevel: "STRONG" } },
    ];
    for (const f of forged) {
      const r = await verifyDeviceAttestation({
        ...base,
        ...f,
        rawAssertionBase64: token,
        nonceHex: randomBytes(32).toString("hex"),
      });
      expect(r.verdict).toBe("UNVERIFIED");
      expect(["VERIFIED_STRONG", "VERIFIED_BASIC", "TEE_ONLY"]).not.toContain(r.verdict);
      expect(r.failureReason).toBe("CRYPTOGRAPHIC_VERIFIER_UNAVAILABLE");
    }

    // Missing token.
    const missing = await verifyDeviceAttestation({
      ...base,
      provider: "APPLE_APP_ATTEST",
      rawAssertionBase64: "",
      nonceHex: randomBytes(32).toString("hex"),
    });
    expect(missing.verdict).toBe("FAILED");
    expect(missing.failureReason).toBe("ASSERTION_MALFORMED");

    // Malformed token (not base64 at all decodes to nothing useful).
    const malformed = await verifyDeviceAttestation({
      ...base,
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: "@@@@",
      nonceHex: randomBytes(32).toString("hex"),
      providerMetadata: { deviceIntegrityLabel: "MEETS_STRONG_INTEGRITY" },
    });
    expect(["FAILED", "UNVERIFIED"]).toContain(malformed.verdict);

    // Replayed nonce.
    const nonce = randomBytes(32).toString("hex");
    await verifyDeviceAttestation({ ...base, provider: "GOOGLE_PLAY_INTEGRITY", rawAssertionBase64: token, nonceHex: nonce });
    const replay = await verifyDeviceAttestation({
      ...base,
      provider: "GOOGLE_PLAY_INTEGRITY",
      rawAssertionBase64: token,
      nonceHex: nonce,
      providerMetadata: { deviceIntegrityLabel: "MEETS_STRONG_INTEGRITY" },
    });
    expect(replay.verdict).toBe("FAILED");
    expect(replay.failureReason).toBe("ASSERTION_REPLAYED");

    // Every row the verifier wrote carries its (non-cryptographic) version.
    const rows = await prisma.captureDeviceAttestation.findMany({
      where: { deviceId: device.id },
      select: { verdict: true, verifierVersion: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.verifierVersion === "FAIL_CLOSED_NO_CRYPTOGRAPHIC_VERIFIER_V1")).toBe(true);
    expect(rows.some((x) => x.verdict.startsWith("VERIFIED"))).toBe(false);
  });

  it("a legacy positive attestation row and a legacy record re-project neutrally", async () => {
    const a = owner();
    const bytes = Buffer.from(`legacy-${randomBytes(8).toString("hex")}`);
    const { token, session, evidenceId } = await stageSession(bytes);
    await call(
      "POST",
      `/v1/capture/direct-sessions/${session.captureSessionId}/parts/0/declaration`,
      token,
      { sha256: sha256(bytes), clientReportedSource: "CAMERA", signed: null },
    );
    const device = await prisma.device.create({
      data: {
        teamId: a.teamId,
        ownerUserId: a.ownerUserId,
        label: "legacy",
        publicKeyHex: randomBytes(32).toString("hex"),
        publicKeyFingerprint: randomBytes(32).toString("hex"),
        attestationProvider: "APPLE_APP_ATTEST",
      },
      select: { id: true },
    });
    // What the pre-UC-0 verifier wrote on the client's word.
    await prisma.captureDeviceAttestation.create({
      data: {
        deviceId: device.id,
        teamId: a.teamId,
        captureSessionId: session.captureSessionId,
        nonceHex: randomBytes(32).toString("hex"),
        provider: "APPLE_APP_ATTEST",
        verdict: "VERIFIED_STRONG",
        attestedAtUtc: new Date(),
        verifierVersion: null,
      },
    });
    await call("POST", `/v1/capture/direct-sessions/${session.captureSessionId}/complete`, token);
    const { loadPublicVerifyAcquisition } = await import("@proovra/shared-runtime");
    const pub = await loadPublicVerifyAcquisition(prisma, evidenceId);
    expect(pub.deviceAttestation.verdict).toBe("UNVERIFIED");
    expect(pub.deviceAttestation.verified).toBe(false);

    // A record created before UC-0: nothing recorded, nothing failed.
    const legacy = await loadPublicVerifyAcquisition(prisma, a.evidenceId);
    expect(legacy.acquisition).toMatchObject({
      mode: "LEGACY_NOT_RECORDED",
      recorded: false,
      recordedBy: null,
      label: "Not recorded",
    });
    expect(legacy.deviceSignature).toEqual({ applicable: false, verdict: "MISSING" });
    expect(legacy.deviceAttestation).toMatchObject({ applicable: false, verified: false });
    expect(legacy.captureSession).toBeNull();
  });
});
