/**
 * UC-STR-001 / UC-STR-002 / UC-STR-003 / UC-STR-006 / UC-ARCH-001 /
 * UC-EXT-010 / UC-PROV-003 / UC-AND-008 — the server is the authority for what
 * a direct-capture seal may claim. Live PostgreSQL 16, real routes.
 *
 * On the pre-remediation tree:
 *   - a continuous manifest listing 3 of 4 recorded segments sealed as
 *     COMPLETE_SESSION (the server never knew how many were recorded);
 *   - a segment declaration could land between the seal's cross-check and its
 *     bind (declarations did not take the session lock);
 *   - the completeness was written in a second statement after the bind, so a
 *     failure there left an interrupted recording reading as complete;
 *   - part index 199 was the literal route ceiling while the client allowed 600;
 *   - the declaration answered no expiry, so the client kept the open-time one;
 *   - any signed-in token could open an "extension" or "iOS app" session;
 *   - open-session refused a caseId (strict body) and nothing filed a capture;
 *   - validated manifest facts were dropped after the seal;
 *   - UC-2/UC-1 classed their manifest part AFTER the seal.
 *
 * Object store and signer are doubled in-process; PostgreSQL 16 is real.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_EVIDENCE_PARTS,
  SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
  SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
  WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
  captureCompletenessNote,
  captureCompletenessRows,
  selectCaptureManifestFacts,
} from "@proovra/shared";

import type { IntegrationHarness } from "./integration-harness.js";

const objects = new Map<string, Buffer>();
/** Set to a trust-event code to make its emission throw once (failure injection). */
const failEmit: { code: string | null } = { code: null };
/** F-17 — set to a code: that emission SUCCEEDS, then the caller fails right after it. */
const failAfterEmit: { code: string | null } = { code: null };
/** When set, the next storage READ (the seal's hash) fails once — a transient hash failure. */
const failRead = { once: false };

vi.mock("../src/storage.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const id = (p: { bucket: string; key: string }) => `${p.bucket}/${p.key}`;
  return {
    ...actual,
    getPublicBaseUrl: () => null,
    presignPutObject: async (p: { bucket: string; key: string }) =>
      `https://uc3c-test-store.invalid/${encodeURIComponent(id(p))}`,
    headObject: async (p: { bucket: string; key: string }) => {
      const b = objects.get(id(p));
      if (!b) throw Object.assign(new Error("NotFound"), { name: "NotFound" });
      return {
        sizeBytes: b.length,
        contentType: "application/octet-stream",
        etag: null,
        metadata: null,
        objectLockMode: null,
        objectLockRetainUntilDate: null,
        objectLockLegalHoldStatus: null,
      };
    },
    getObjectStream: async (p: { bucket: string; key: string }) => {
      if (failRead.once) {
        failRead.once = false;
        throw Object.assign(new Error("injected storage read failure"), { name: "ServiceUnavailable" });
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
        signatureBase64: Buffer.from(`uc3c-test-signature:${hex}`).toString("base64"),
        keyId: "uc3c-test-key",
        keyVersion: 1,
      }),
    }),
  };
});

vi.mock("../src/services/timestamp.service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createEvidenceTimestamp: async () => null };
});

vi.mock("../src/services/capture-trust/trust-event.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/capture-trust/trust-event.service.js")>();
  return {
    ...actual,
    emitCaptureTrustEvent: async (input: Parameters<typeof actual.emitCaptureTrustEvent>[0]) => {
      if (failEmit.code && input.code === failEmit.code) {
        failEmit.code = null;
        throw new Error("injected trust-event failure");
      }
      const out = await actual.emitCaptureTrustEvent(input);
      if (failAfterEmit.code && input.code === failAfterEmit.code) {
        failAfterEmit.code = null;
        throw new Error("injected failure after the trust event was appended");
      }
      return out;
    },
  };
});

const BUCKET = "uc3c-capture-test-bucket";
process.env.S3_BUCKET = BUCKET;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("direct-capture seal authority (live PostgreSQL 16)", () => {
  let harness: IntegrationHarness;
  let prisma: (typeof import("../src/db.js"))["prisma"];
  let app: IntegrationHarness["app"];
  let extensionToken: string;
  const originalBilling = new Map<string, Record<string, unknown>>();
  const provisionedPolicies: string[] = [];

  beforeAll(async () => {
    const { bootIntegrationHarness } = await import("./integration-harness.js");
    harness = await bootIntegrationHarness();
    ({ prisma } = await import("../src/db.js"));
    app = harness.app;
    for (const teamId of [harness.fixtures.teamA.teamId]) {
      originalBilling.set(
        teamId,
        (await prisma.team.findUniqueOrThrow({
          where: { id: teamId },
          select: { billingPlan: true, billingStatus: true },
        })) as unknown as Record<string, unknown>,
      );
      await prisma.team.update({ where: { id: teamId }, data: { billingPlan: "ENTERPRISE", billingStatus: "ACTIVE" } as never });
    }
    // UC-SEC-004 — an extension capture is checked against the TARGET
    // Organization's security policy, and an Organization with no provisioned
    // policy fails closed (POLICY_NOT_PROVISIONED). Production Organizations
    // are provisioned; the disposable fixture ones are provisioned here (and
    // only the rows created here are removed afterwards).
    for (const fixtureTeamId of [harness.fixtures.teamA.teamId, harness.fixtures.teamB.teamId]) {
      const t = await prisma.team.findUniqueOrThrow({ where: { id: fixtureTeamId }, select: { organizationId: true } });
      if (t.organizationId && !(await prisma.organizationSecurityPolicy.findUnique({ where: { organizationId: t.organizationId } }))) {
        await prisma.organizationSecurityPolicy.create({ data: { organizationId: t.organizationId } });
        provisionedPolicies.push(t.organizationId);
      }
    }
    const { signJwt } = await import("../src/services/jwt.js");
    const { EXTENSION_CAPTURE_SCOPE } = await import("../src/services/auth/extension-scope.js");
    const A = harness.fixtures.teamA;
    const u = await prisma.user.findUniqueOrThrow({ where: { id: A.ownerUserId }, select: { email: true } });
    extensionToken = signJwt(
      {
        sub: A.ownerUserId,
        provider: "EMAIL",
        email: u.email,
        authMethod: "PASSWORD",
        authAt: Math.floor(Date.now() / 1000),
        scope: EXTENSION_CAPTURE_SCOPE,
      } as never,
      process.env.AUTH_JWT_SECRET!,
      3600,
    );
  }, 600_000);

  afterAll(async () => {
    for (const organizationId of provisionedPolicies) {
      await prisma.organizationSecurityPolicy.delete({ where: { organizationId } }).catch(() => undefined);
    }
    for (const [teamId, billing] of originalBilling) {
      await prisma.team.update({ where: { id: teamId }, data: billing as never }).catch(() => undefined);
    }
    await harness?.cleanup();
  });

  const owner = () => harness.fixtures.teamA;

  // This suite opens more sessions than the per-user open limit allows per
  // minute; the limiter is not what it tests, so each case starts from zero.
  beforeEach(async () => {
    const { clearAllRateLimitBuckets } = await import("../src/services/rate-limit.js");
    await clearAllRateLimitBuckets();
  });

  async function call(method: string, url: string, token: string, body?: unknown) {
    return app.inject({
      method: method as never,
      url,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  }

  async function open(mode: string, token = owner().ownerToken, extra: Record<string, unknown> = {}) {
    return call("POST", "/v1/capture/direct-sessions", token, { mode, teamId: owner().teamId, deviceId: null, ...extra });
  }

  async function openAndReserve(mode: string, token = owner().ownerToken, extra: Record<string, unknown> = {}) {
    const o = await open(mode, token, extra);
    expect(o.statusCode, o.body).toBe(201);
    const sessionId = o.json().session.captureSessionId as string;
    const r = await call("POST", `/v1/capture/direct-sessions/${sessionId}/evidence`, token, {
      type: mode === "DIRECT_WEB_CAPTURE_EXTENSION" || mode === "DIRECT_SCREEN_CAPTURE_ANDROID" ? "PHOTO" : "VIDEO",
      mimeType: mode === "DIRECT_WEB_CAPTURE_EXTENSION" || mode === "DIRECT_SCREEN_CAPTURE_ANDROID" ? "image/png" : "video/mp4",
    });
    expect(r.statusCode, r.body).toBe(201);
    return { sessionId, evidenceId: r.json().evidence.evidenceId as string, openBody: o.json().session };
  }

  async function put(token: string, evidenceId: string, partIndex: number, bytes: Buffer) {
    const part = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex,
      mimeType: "application/octet-stream",
      originalFileName: `part-${partIndex}.bin`,
    });
    expect(part.statusCode, part.body).toBe(201);
    const { bucket, key } = part.json().upload as { bucket: string; key: string };
    objects.set(`${bucket}/${key}`, bytes);
  }

  async function declare(token: string, sessionId: string, partIndex: number, digest: string, source: string, recordedThrough?: number) {
    return call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/${partIndex}/declaration`, token, {
      sha256: digest,
      clientReportedSource: source,
      ...(recordedThrough !== undefined ? { recordedThrough } : {}),
      signed: null,
    });
  }

  // AUD-24 (2026-10-20): a segment is declared with the recorder's running
  // count, as the current apps send it (own count by default); `null` is a
  // legacy client that sends none.
  async function uploadAndDeclare(token: string, evidenceId: string, sessionId: string, partIndex: number, bytes: Buffer, source: string, recordedThrough?: number | null) {
    await put(token, evidenceId, partIndex, bytes);
    const through = recordedThrough === null ? undefined : (recordedThrough ?? (source === "SCREEN_SEGMENT" ? partIndex + 1 : undefined));
    const d = await declare(token, sessionId, partIndex, sha256(bytes), source, through);
    expect(d.statusCode, d.body).toBe(201);
    return { partIndex, sha256: sha256(bytes), sizeBytes: bytes.length };
  }

  type Seg = { partIndex: number; sha256: string; sizeBytes: number };

  function continuousManifest(
    sessionId: string,
    segs: Seg[],
    o: {
      recorded: number;
      completeness?: "COMPLETE_SESSION" | "INTERRUPTED_SESSION";
      termination?: string;
      limitations?: string[];
      duplicateSequenceOf?: number;
      digestOverride?: { partIndex: number; sha256: string };
    },
  ) {
    const start = Date.now();
    return JSON.stringify({
      schemaVersion: SCREEN_CONTINUOUS_MANIFEST_SCHEMA_VERSION,
      captureSessionId: sessionId,
      captureStartedAtUtc: new Date(start).toISOString(),
      captureEndedAtUtc: new Date(start + o.recorded * 1000).toISOString(),
      device: {
        platform: "android",
        osVersion: "14",
        model: "Pixel 7",
        appVersion: "1.0.0",
        screenW: 1080,
        screenH: 2400,
        densityDpi: 420,
        orientation: "portrait",
      },
      osConsentGranted: true,
      totalDurationMs: o.recorded * 1000,
      recordedSegmentCount: o.recorded,
      segments: segs.map((s) => ({
        role: "screen_segment",
        partIndex: s.partIndex,
        sequence: o.duplicateSequenceOf !== undefined && s.partIndex === segs[segs.length - 1]!.partIndex ? o.duplicateSequenceOf : s.partIndex,
        expectedSha256: o.digestOverride?.partIndex === s.partIndex ? o.digestOverride.sha256 : s.sha256,
        sizeBytes: s.sizeBytes,
        mediaType: "video/mp4",
        startedAtOffsetMs: s.partIndex * 1000,
        durationMs: 1000,
        widthPx: 1080,
        heightPx: 2400,
        orientation: "portrait",
      })),
      sessionCompleteness: o.completeness ?? "COMPLETE_SESSION",
      terminationReason: o.termination ?? "USER_STOPPED",
      limitations: o.limitations ?? [],
      notes: [],
    });
  }

  /**
   * Record `recorded` segments, upload+declare the ones in `declaredIdx`.
   * `recordedThrough(i)` is the running recorder count a current client sends
   * with segment i (omitted: a legacy client).
   */
  async function stageSegments(recorded: number, declaredIdx: number[], recordedThrough?: (i: number) => number | null) {
    const token = owner().ownerToken;
    const { sessionId, evidenceId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
    const segs: Seg[] = [];
    for (let i = 0; i < recorded; i += 1) {
      if (!declaredIdx.includes(i)) continue;
      segs.push(await uploadAndDeclare(token, evidenceId, sessionId, i, Buffer.from(`seg-${i}-${randomBytes(6).toString("hex")}`), "SCREEN_SEGMENT", recordedThrough?.(i)));
    }
    return { token, sessionId, evidenceId, segs };
  }

  async function stageManifest(token: string, sessionId: string, evidenceId: string, manifestJson: string, partIndex: number) {
    await uploadAndDeclare(token, evidenceId, sessionId, partIndex, Buffer.from(manifestJson, "utf8"), "CONTINUOUS_MANIFEST");
  }

  const seal = (token: string, sessionId: string, manifestJson: string) =>
    call("POST", `/v1/capture/direct-sessions/${sessionId}/continuous-complete`, token, { manifestJson });

  const statusOf = async (evidenceId: string) =>
    (await prisma.evidence.findUniqueOrThrow({ where: { id: evidenceId }, select: { status: true } })).status;

  // ---------------------------------------------------------------- UC-STR-002

  it("UC-STR-002 missing LAST part: a COMPLETE claim is refused; the honest INTERRUPTED + SEGMENT_UPLOAD_LOST seals", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(4, [0, 1, 2]);
    const lying = continuousManifest(sessionId, segs, { recorded: 4 });
    await stageManifest(token, sessionId, evidenceId, lying, 3);
    const refused = await seal(token, sessionId, lying);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
    expect(await statusOf(evidenceId)).not.toBe("SIGNED");

    // A COMPLETE manifest that hides the loss by under-stating the recorded count
    // is refused too when the server holds a declaration it does not list.
    // With the running counts the current apps declare, the server refuses it
    // at the manifest check (recorded below the declared count) …
    const s2c = await stageSegments(4, [0, 1, 2, 3]);
    const hidesCounted = continuousManifest(s2c.sessionId, s2c.segs.slice(0, 3), { recorded: 3 });
    await stageManifest(s2c.token, s2c.sessionId, s2c.evidenceId, hidesCounted, 4);
    const r2c = await seal(s2c.token, s2c.sessionId, hidesCounted);
    expect(r2c.statusCode, r2c.body).toBe(422);
    expect(r2c.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
    // … and without them (a legacy client), at the 1:1 declaration check.
    const s2 = await stageSegments(4, [0, 1, 2, 3], () => null);
    const hides = continuousManifest(s2.sessionId, s2.segs.slice(0, 3), { recorded: 3 });
    await stageManifest(s2.token, s2.sessionId, s2.evidenceId, hides, 4);
    const r2 = await seal(s2.token, s2.sessionId, hides);
    expect(r2.statusCode, r2.body).toBe(422);
    expect(r2.json().denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");

    const s3 = await stageSegments(4, [0, 1, 2]);
    const honest = continuousManifest(s3.sessionId, s3.segs, {
      recorded: 4,
      completeness: "INTERRUPTED_SESSION",
      limitations: ["SEGMENT_UPLOAD_LOST"],
    });
    await stageManifest(s3.token, s3.sessionId, s3.evidenceId, honest, 3);
    const ok = await seal(s3.token, s3.sessionId, honest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await statusOf(s3.evidenceId)).toBe("SIGNED");
    const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: s3.sessionId }, select: { status: true, endReason: true } });
    expect(session).toEqual({ status: "BOUND", endReason: "CONTINUOUS_INTERRUPTED_SESSION" });
  });

  it("UC-STR-002 missing MIDDLE part: never COMPLETE; sealed INTERRUPTED with its gap named", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(4, [0, 1, 3]);
    const complete = continuousManifest(sessionId, segs, { recorded: 4 });
    await stageManifest(token, sessionId, evidenceId, complete, 4);
    const refused = await seal(token, sessionId, complete);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");

    const s2 = await stageSegments(4, [0, 1, 3]);
    const honest = continuousManifest(s2.sessionId, s2.segs, {
      recorded: 4,
      completeness: "INTERRUPTED_SESSION",
      limitations: ["SEGMENT_UPLOAD_LOST"],
    });
    await stageManifest(s2.token, s2.sessionId, s2.evidenceId, honest, 4);
    const ok = await seal(s2.token, s2.sessionId, honest);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().result.manifestPartIndex).toBe(4);
    expect(await prisma.evidencePart.count({ where: { evidenceId: s2.evidenceId } })).toBe(4);
  });

  it("UC-STR-002 duplicate sequence is refused by the validator", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(3, [0, 1, 2]);
    const dup = continuousManifest(sessionId, segs, { recorded: 3, duplicateSequenceOf: 1 });
    await stageManifest(token, sessionId, evidenceId, dup, 3);
    const r = await seal(token, sessionId, dup);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
  });

  it("UC-STR-002 same sequence, different digest: a second declaration is refused and a mismatched manifest cannot seal", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const again = await declare(token, sessionId, 1, "e".repeat(64), "SCREEN_SEGMENT");
    expect(again.statusCode, again.body).toBe(409);
    expect(again.json().denial).toBe("PART_ALREADY_DECLARED");
    const swapped = continuousManifest(sessionId, segs, { recorded: 2, digestOverride: { partIndex: 1, sha256: "e".repeat(64) } });
    await stageManifest(token, sessionId, evidenceId, swapped, 2);
    const r = await seal(token, sessionId, swapped);
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
  });

  it("UC-STR-002 a seal racing a final declaration never yields COMPLETE over an undeclared segment", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { token, sessionId, evidenceId, segs } = await stageSegments(3, [0, 1, 2]);
      const m = continuousManifest(sessionId, segs, { recorded: 3 });
      await stageManifest(token, sessionId, evidenceId, m, 3);
      const late = Buffer.from(`late-${round}-${randomBytes(4).toString("hex")}`);
      const [sealRes, declRes] = await Promise.all([
        seal(token, sessionId, m),
        declare(token, sessionId, 4, sha256(late), "SCREEN_SEGMENT"),
      ]);
      const sealed = sealRes.statusCode === 200;
      const declared = declRes.statusCode === 201;
      // Exactly one wins: the seal (the late declaration then finds it sealed),
      // or the declaration (the seal then sees a segment the manifest omits).
      expect(sealed !== declared, `round ${round}: seal ${sealRes.statusCode} ${sealRes.body} / decl ${declRes.statusCode} ${declRes.body}`).toBe(true);
      if (sealed) {
        // It waited for the seal and found the session sealed — or its bounded
        // lock wait expired first (SESSION_BUSY, retryable). Either way the
        // segment was NOT declared, so nothing was sealed over.
        expect(declRes.statusCode, declRes.body).toBe(409);
        expect(["SESSION_NOT_ACTIVE", "SESSION_BUSY"]).toContain(declRes.json().denial);
        expect(
          (await prisma.captureTrustEventRecord.findMany({ where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_RECEIVED" }, select: { payload: true } }))
            .some((r) => (r.payload as Record<string, unknown>)?.partIndex === 4),
        ).toBe(false);
      } else {
        expect(sealRes.statusCode).toBe(422);
        expect(sealRes.json().denial).toBe("CONTINUOUS_MANIFEST_ARTIFACT_MISMATCH");
        expect(await statusOf(evidenceId)).not.toBe("SIGNED");
      }
    }
  });

  it("UC-STR-002 repeated seal is idempotent: one bind, one end reason", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const m = continuousManifest(sessionId, segs, { recorded: 2 });
    await stageManifest(token, sessionId, evidenceId, m, 2);
    const first = await seal(token, sessionId, m);
    expect(first.statusCode, first.body).toBe(200);
    const second = await seal(token, sessionId, m);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().result.alreadyBound).toBe(true);
    expect(second.json().result.manifestPartIndex).toBe(2);
    expect(await prisma.captureTrustEventRecord.count({ where: { captureSessionId: sessionId, code: "CAPTURE_SESSION_BOUND" } })).toBe(1);
    const s = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
    expect(s.endReason).toBe("CONTINUOUS_COMPLETE_SESSION");
  });

  it("UC-STR-002 an interrupted recording seals as INTERRUPTED", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const m = continuousManifest(sessionId, segs, {
      recorded: 2,
      completeness: "INTERRUPTED_SESSION",
      termination: "PERMISSION_REVOKED",
      limitations: ["CAPTURE_INTERRUPTED"],
    });
    await stageManifest(token, sessionId, evidenceId, m, 2);
    const r = await seal(token, sessionId, m);
    expect(r.statusCode, r.body).toBe(200);
    const s = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
    expect(s.endReason).toBe("CONTINUOUS_INTERRUPTED_SESSION");
  });

  // ---------------------------------------------------------------- AUD-017

  const sealedFacts = async (sessionId: string, manifestJson: string) =>
    selectCaptureManifestFacts(
      await prisma.captureTrustEventRecord.findMany({
        where: { captureSessionId: sessionId },
        orderBy: { sequence: "asc" },
        select: { code: true, payload: true },
      }),
      { manifestSha256: sha256(manifestJson) },
    );

  it("AUD-24 a legacy client that declares no running count cannot seal COMPLETE over a hidden tail; its honest loss still seals", async () => {
    // 2026-10-20 (AUD-24). Characterization (before): with no recordedThrough
    // the server had no boundary of its own, and "recorded 5, uploaded 2,
    // claims 2 COMPLETE" SEALED (only labelled client-reported). COMPLETE now
    // requires every segment to carry the recorder's running count.
    const legacy = await stageSegments(5, [0, 1], () => null);
    const m = continuousManifest(legacy.sessionId, legacy.segs, { recorded: 2 });
    await stageManifest(legacy.token, legacy.sessionId, legacy.evidenceId, m, 2);
    const refused = await seal(legacy.token, legacy.sessionId, m);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().denial).toBe("CONTINUOUS_COMPLETENESS_UNDECLARED");
    expect(await statusOf(legacy.evidenceId)).not.toBe("SIGNED");

    // The same legacy client stating its loss honestly is sealed, client-reported.
    const honest = await stageSegments(5, [0, 1], () => null);
    const im = continuousManifest(honest.sessionId, honest.segs, {
      recorded: 5,
      completeness: "INTERRUPTED_SESSION",
      limitations: ["SEGMENT_UPLOAD_LOST"],
    });
    await stageManifest(honest.token, honest.sessionId, honest.evidenceId, im, 2);
    const ok = await seal(honest.token, honest.sessionId, im);
    expect(ok.statusCode, ok.body).toBe(200);
    const facts = await sealedFacts(honest.sessionId, im);
    expect(facts!.reportedBy).toBe("CAPTURE_CLIENT");
    expect(facts!.screen).toMatchObject({ artifactCount: 2, recordedSegmentCount: 5, declaredRecordedThroughMax: null });
    expect(captureCompletenessNote(facts!)).toMatch(/cannot verify segments the client never declared/);
  });

  it("AUD-017 a recorded count below the declared running recordedThrough is refused (COMPLETE and INTERRUPTED); the honest loss seals with it", async () => {
    // The recorder had produced 5 segments when segment 1 was declared.
    const through = (i: number) => (i === 1 ? 5 : i + 1);
    const lie = await stageSegments(5, [0, 1], through);
    const complete = continuousManifest(lie.sessionId, lie.segs, { recorded: 2 });
    await stageManifest(lie.token, lie.sessionId, lie.evidenceId, complete, 2);
    const refused = await seal(lie.token, lie.sessionId, complete);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");
    expect(await statusOf(lie.evidenceId)).not.toBe("SIGNED");

    const lie2 = await stageSegments(5, [0, 1], through);
    const interruptedLie = continuousManifest(lie2.sessionId, lie2.segs, {
      recorded: 2,
      completeness: "INTERRUPTED_SESSION",
      termination: "INTERRUPTED",
      limitations: ["CAPTURE_INTERRUPTED"],
    });
    await stageManifest(lie2.token, lie2.sessionId, lie2.evidenceId, interruptedLie, 2);
    const r2 = await seal(lie2.token, lie2.sessionId, interruptedLie);
    expect(r2.statusCode, r2.body).toBe(422);
    expect(r2.json().denial).toBe("CONTINUOUS_MANIFEST_INVALID");

    const honest = await stageSegments(5, [0, 1], through);
    const lost = continuousManifest(honest.sessionId, honest.segs, {
      recorded: 5,
      completeness: "INTERRUPTED_SESSION",
      termination: "INTERRUPTED",
      limitations: ["SEGMENT_UPLOAD_LOST"],
    });
    await stageManifest(honest.token, honest.sessionId, honest.evidenceId, lost, 2);
    const ok = await seal(honest.token, honest.sessionId, lost);
    expect(ok.statusCode, ok.body).toBe(200);
    const facts = await sealedFacts(honest.sessionId, lost);
    expect(facts!.screen).toMatchObject({ artifactCount: 2, recordedSegmentCount: 5, declaredRecordedThroughMax: 5 });
    expect(captureCompletenessRows(facts!)[1]!.value).toBe("Segments delivered 2 of 5 recorded (client-reported)");
    // The declaration recorded the client's count as its statement.
    const decl = await prisma.captureTrustEventRecord.findMany({ where: { captureSessionId: honest.sessionId }, select: { payload: true } });
    expect(decl.some((e) => (e.payload as Record<string, unknown>)?.clientReportedRecordedThrough === 5)).toBe(true);
  });

  it("AUD-017 a recordedThrough that cannot be true for its part, or on a non-segment part, is refused at declaration", async () => {
    const { sessionId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
    const token = owner().ownerToken;
    const tooLow = await declare(token, sessionId, 3, "a".repeat(64), "SCREEN_SEGMENT", 3);
    expect(tooLow.statusCode, tooLow.body).toBe(400);
    expect(tooLow.json().denial).toBe("INVALID_RECORDED_THROUGH");
    const onManifest = await declare(token, sessionId, 4, "b".repeat(64), "CONTINUOUS_MANIFEST", 5);
    expect(onManifest.statusCode, onManifest.body).toBe(400);
    expect(onManifest.json().denial).toBe("INVALID_RECORDED_THROUGH");
    const ok = await declare(token, sessionId, 3, "a".repeat(64), "SCREEN_SEGMENT", 4);
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().declaration.recordedThrough).toBe(4);
  });

  // ------------------------------------------------- seal claim (A/B/C steps)

  it("a seal hashes OUTSIDE any transaction: a failed hash releases its claim and the retry seals", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const m = continuousManifest(sessionId, segs, { recorded: 2 });
    await stageManifest(token, sessionId, evidenceId, m, 2);
    failRead.once = true;
    const failed = await seal(token, sessionId, m);
    expect(failed.statusCode).toBeGreaterThanOrEqual(500);
    const released = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
    expect(released).toEqual({ status: "ACTIVE", endReason: null });
    expect(await statusOf(evidenceId)).not.toBe("SIGNED");
    const retried = await seal(token, sessionId, m);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await statusOf(evidenceId)).toBe("SIGNED");
  });

  it("a LIVE seal claim refuses declarations, discards and other seals (SESSION_BUSY); a STALE one is reclaimed", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const m = continuousManifest(sessionId, segs, { recorded: 2 });
    await stageManifest(token, sessionId, evidenceId, m, 2);
    // Another seal holds the claim right now.
    await prisma.captureSession.update({ where: { id: sessionId }, data: { endReason: "SEAL_IN_PROGRESS" } });
    for (const res of [
      await declare(token, sessionId, 3, "d".repeat(64), "SCREEN_SEGMENT"),
      await call("POST", `/v1/capture/direct-sessions/${sessionId}/discard`, token, {}),
      await seal(token, sessionId, m),
    ]) {
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().denial).toBe("SESSION_BUSY");
    }
    // That seal crashed: its claim is older than the lease. The next seal reclaims it.
    await prisma.captureSession.update({
      where: { id: sessionId },
      data: { endReason: "SEAL_IN_PROGRESS", updatedAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    const sealed = await seal(token, sessionId, m);
    expect(sealed.statusCode, sealed.body).toBe(200);
    const s = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
    expect(s).toEqual({ status: "BOUND", endReason: "CONTINUOUS_COMPLETE_SESSION" });
  });

  it("the capture reaper releases a STALE seal claim and never expires a session under a LIVE one", async () => {
    const reaper = await import("../../worker/src/capture-reaper.js");
    const stale = await stageSegments(1, [0]);
    const live = await stageSegments(1, [0]);
    const past = new Date(Date.now() - 60_000);
    await prisma.captureSession.update({
      where: { id: stale.sessionId },
      data: { endReason: "SEAL_IN_PROGRESS", updatedAt: new Date(Date.now() - 11 * 60 * 1000) },
    });
    await prisma.captureSession.update({
      where: { id: live.sessionId },
      data: { endReason: "SEAL_IN_PROGRESS", expiresAtUtc: past },
    });
    const run = await reaper.releaseExpiredReservations({ trigger: "uc-str-002-test" });
    expect(run.staleSealClaimsReleased).toBeGreaterThanOrEqual(1);
    expect(await prisma.captureSession.findUniqueOrThrow({ where: { id: stale.sessionId }, select: { status: true, endReason: true } }))
      .toEqual({ status: "ACTIVE", endReason: null });
    expect(await prisma.captureSession.findUniqueOrThrow({ where: { id: live.sessionId }, select: { status: true, endReason: true } }))
      .toEqual({ status: "ACTIVE", endReason: "SEAL_IN_PROGRESS" });
    // Leave the live one releasable for later suites.
    await prisma.captureSession.update({ where: { id: live.sessionId }, data: { endReason: null } });
  });

  // F-23 (independent forward audit) — a seal that outlived its claim's lease
  // and committed the record SIGNED after the session's expiry. The reaper used
  // to expire that session (the reservation release refuses a sealed record,
  // the expiry did not), so the retry's bind was refused (SESSION_NOT_ACTIVE)
  // and the sealed record never got its session binding or completeness.
  it("F-23: the reaper never expires a session whose record is already sealed; the retry binds it", async () => {
    const reaper = await import("../../worker/src/capture-reaper.js");
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const manifest = continuousManifest(sessionId, segs, { recorded: 2, completeness: "COMPLETE_SESSION" });
    await stageManifest(token, sessionId, evidenceId, manifest, 2);
    // The state a seal leaves when it outlived its claim lease: the record was
    // committed SIGNED, the reaper released the stale claim (endReason null),
    // the bind never ran, and the session passed its expiry.
    const sealedOnce = await seal(token, sessionId, manifest);
    expect(sealedOnce.statusCode, sealedOnce.body).toBe(200);
    await prisma.captureSession.update({
      where: { id: sessionId },
      data: { status: "ACTIVE", endReason: null, finalizedAtUtc: null, endedAtUtc: null, expiresAtUtc: new Date(Date.now() - 60_000) },
    });
    expect(await statusOf(evidenceId)).toBe("SIGNED");
    await reaper.releaseExpiredReservations({ trigger: "f-23-test" });
    const after = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } });
    expect(after.status).not.toBe("EXPIRED");
    const retried = await seal(token, sessionId, manifest);
    expect(retried.statusCode, retried.body).toBe(200);
    const bound = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
    expect(bound.status).toBe("BOUND");
    expect(bound.endReason).toBe("CONTINUOUS_COMPLETE_SESSION");
  });

  // ---------------------------------------------------------------- UC-STR-006

  it("UC-STR-006 the completeness is written by the bind itself: a failure after the bind cannot leave it reading as complete", async () => {
    const { token, sessionId, evidenceId, segs } = await stageSegments(2, [0, 1]);
    const m = continuousManifest(sessionId, segs, {
      recorded: 2,
      completeness: "INTERRUPTED_SESSION",
      termination: "INTERRUPTED",
      limitations: ["CAPTURE_INTERRUPTED"],
    });
    await stageManifest(token, sessionId, evidenceId, m, 2);
    failEmit.code = "CAPTURE_SESSION_BOUND";
    const r = await seal(token, sessionId, m);
    expect(r.statusCode).toBe(500);
    const s = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, endReason: true } });
    expect(s).toEqual({ status: "BOUND", endReason: "CONTINUOUS_INTERRUPTED_SESSION" });
  });

  // ---------------------------------------------------------------- UC-STR-001

  it("UC-STR-001 the part bound is THE shared one: index MAX-1 declares, MAX is refused", async () => {
    const { sessionId, evidenceId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
    const token = owner().ownerToken;
    const last = await declare(token, sessionId, MAX_EVIDENCE_PARTS - 1, "a".repeat(64), "CONTINUOUS_MANIFEST");
    expect(last.statusCode, last.body).toBe(201);
    const over = await declare(token, sessionId, MAX_EVIDENCE_PARTS, "b".repeat(64), "SCREEN_SEGMENT");
    expect(over.statusCode).toBe(400);
    const presign = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
      partIndex: MAX_EVIDENCE_PARTS - 1,
      mimeType: "application/json",
    });
    expect(presign.statusCode, presign.body).toBe(201);
  });

  // ---------------------------------------------------------------- UC-STR-003

  it("UC-STR-003 a declaration answers the server's slid session expiry", async () => {
    const { sessionId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS");
    // The session has been recording for a while: its expiry is 5 minutes out.
    const near = new Date(Date.now() + 5 * 60 * 1000);
    await prisma.captureSession.update({ where: { id: sessionId }, data: { expiresAtUtc: near } });
    const d = await declare(owner().ownerToken, sessionId, 0, "c".repeat(64), "SCREEN_SEGMENT");
    expect(d.statusCode, d.body).toBe(201);
    const answered = Date.parse(d.json().session.expiresAtUtc);
    expect(answered).toBeGreaterThan(near.getTime() + 30 * 60 * 1000);
    const stored = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { expiresAtUtc: true } });
    expect(answered).toBe(stored.expiresAtUtc!.getTime());
  });

  // ---------------------------------------------------------------- UC-ARCH-001

  it("UC-ARCH-001 the credential, not the body, decides the channel a session may claim", async () => {
    const webAsOrdinary = await open("DIRECT_WEB_CAPTURE_EXTENSION");
    expect(webAsOrdinary.statusCode, webAsOrdinary.body).toBe(403);
    expect(webAsOrdinary.json().denial).toBe("MODE_NOT_ALLOWED_FOR_CREDENTIAL");

    for (const mode of ["DIRECT_SCREEN_CAPTURE_IOS", "PROOVRA_MOBILE_APP", "DIRECT_SCREEN_CAPTURE_ANDROID"]) {
      const r = await open(mode, extensionToken);
      expect(r.statusCode, `${mode}: ${r.body}`).toBe(403);
      expect(r.json().denial).toBe("MODE_NOT_ALLOWED_FOR_CREDENTIAL");
    }

    const ext = await open("DIRECT_WEB_CAPTURE_EXTENSION", extensionToken);
    expect(ext.statusCode, ext.body).toBe(201);
    expect(ext.json().session.modeAuthority).toBe("EXTENSION_SCOPED_CREDENTIAL");

    const ios = await open("DIRECT_SCREEN_CAPTURE_IOS");
    expect(ios.statusCode, ios.body).toBe(201);
    expect(ios.json().session.modeAuthority).toBe("CLIENT_DECLARED");
    const started = await prisma.captureTrustEventRecord.findFirstOrThrow({
      where: { captureSessionId: ios.json().session.captureSessionId, code: "CAPTURE_SESSION_STARTED" },
      select: { payload: true },
    });
    expect((started.payload as Record<string, unknown>).modeAuthority).toBe("CLIENT_DECLARED");
  });

  // ---------------------------------------------------------------- UC-SEC-004

  it("UC-SEC-004: an extension token anchored elsewhere is refused by the TARGET organization's SSO mandate", async () => {
    const B = harness.fixtures.teamB;
    const team = await prisma.team.findUniqueOrThrow({ where: { id: B.teamId }, select: { organizationId: true } });
    expect(team.organizationId, "fixture teamB is an Organization workspace").toBeTruthy();
    const orgId = team.organizationId!;
    // teamA's owner (whose extension token is anchored in teamA) is also a
    // member of teamB, so the canonical workspace authorization admits the
    // target; only the target Organization's session policy can refuse it.
    const existingMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: B.teamId, userId: owner().ownerUserId } },
    });
    if (!existingMember) {
      await prisma.teamMember.create({
        data: { teamId: B.teamId, userId: owner().ownerUserId, role: "ADMIN" as never, status: "ACTIVE" as never },
      });
    }
    const priorPolicy = await prisma.organizationSecurityPolicy.findUnique({ where: { organizationId: orgId } });
    await prisma.organizationSecurityPolicy.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, ssoRequired: true },
      update: { ssoRequired: true },
    });
    const openB = () =>
      call("POST", "/v1/capture/direct-sessions", extensionToken, {
        mode: "DIRECT_WEB_CAPTURE_EXTENSION",
        teamId: B.teamId,
        deviceId: null,
      });
    try {
      const before = await prisma.captureSession.count({ where: { teamId: B.teamId, ownerUserId: owner().ownerUserId } });
      const refused = await openB();
      expect(refused.statusCode, refused.body).toBe(401);
      expect(refused.json().denial).toBe("REAUTHENTICATION_REQUIRED");
      expect(await prisma.captureSession.count({ where: { teamId: B.teamId, ownerUserId: owner().ownerUserId } })).toBe(before);
      // Control: the token's own (anchor) workspace, which mandates nothing, still opens.
      const anchor = await open("DIRECT_WEB_CAPTURE_EXTENSION", extensionToken);
      expect(anchor.statusCode, anchor.body).toBe(201);
      // Control: with the mandate lifted the same token may target teamB — so
      // the refusal above was the target's SSO policy, not authorization.
      await prisma.organizationSecurityPolicy.update({ where: { organizationId: orgId }, data: { ssoRequired: false } });
      const lifted = await openB();
      expect(lifted.statusCode, lifted.body).toBe(201);
    } finally {
      if (priorPolicy) {
        await prisma.organizationSecurityPolicy.update({ where: { organizationId: orgId }, data: { ssoRequired: priorPolicy.ssoRequired } });
      } else {
        await prisma.organizationSecurityPolicy.delete({ where: { organizationId: orgId } }).catch(() => undefined);
      }
      if (!existingMember) {
        await prisma.teamMember.delete({ where: { teamId_userId: { teamId: B.teamId, userId: owner().ownerUserId } } }).catch(() => undefined);
      }
    }
  });

  // ---------------------------------------------------------------- UC-EXT-010

  it("UC-EXT-010 a foreign or unknown case is refused at open (anti-enumeration 404)", async () => {
    const foreign = await open("PROOVRA_MOBILE_APP", owner().ownerToken, { caseId: harness.fixtures.teamB.caseId });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(foreign.json().denial).toBe("CASE_NOT_FOUND");
    const unknown = await open("PROOVRA_MOBILE_APP", owner().ownerToken, { caseId: "00000000-0000-4000-8000-00000000abcd" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().denial).toBe("CASE_NOT_FOUND");
    const sessions = await prisma.captureSession.count({ where: { ownerUserId: owner().ownerUserId, acquisitionMode: "PROOVRA_MOBILE_APP", createdAt: { gt: new Date(Date.now() - 60_000) } } });
    expect(sessions).toBe(0);
  });

  it("UC-EXT-010 a capture opened for a case is linked to it in the same transaction as the bind", async () => {
    const token = owner().ownerToken;
    const caseId = owner().caseId;
    const { sessionId, evidenceId, openBody } = await openAndReserve("PROOVRA_MOBILE_APP", token, { caseId });
    expect(openBody.caseId).toBe(caseId);
    await uploadAndDeclare(token, evidenceId, sessionId, 0, Buffer.from(`photo-${randomBytes(6).toString("hex")}`), "CAMERA");
    expect(await prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } })).toBe(0);
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/complete`, token, {});
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().result.caseLink).toEqual({ caseId, linked: true, denial: null });
    expect(await prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } })).toBe(1);
    const again = await call("POST", `/v1/capture/direct-sessions/${sessionId}/complete`, token, {});
    expect(again.statusCode).toBe(200);
    expect(await prisma.caseEvidenceLink.count({ where: { caseId, evidenceId } })).toBe(1);
  });

  // ------------------------------------------------ UC-PROV-003 / UC-AND-008

  it("UC-PROV-003 a web capture's validated facts are persisted on its trust chain; the URL never reaches custody", async () => {
    const { sessionId, evidenceId } = await openAndReserve("DIRECT_WEB_CAPTURE_EXTENSION", extensionToken);
    const shot = await uploadAndDeclare(extensionToken, evidenceId, sessionId, 0, Buffer.from(`shot-${randomBytes(6).toString("hex")}`), "WEB_VIEWPORT");
    const manifestJson = JSON.stringify({
      schemaVersion: WEB_CAPTURE_MANIFEST_SCHEMA_VERSION,
      captureMode: "VIEWPORT",
      captureSessionId: sessionId,
      // AUD-22 (2026-10-20): a believable window (a month-old one is refused).
      captureStartedAtUtc: new Date(Date.now() - 4000).toISOString(),
      captureEndedAtUtc: new Date(Date.now() - 2000).toISOString(),
      page: { domain: "news.example.org", sourceUrlPrivate: "https://news.example.org/story?session=private-token", title: "Private headline" },
      browser: { name: "Chrome", versionBucket: "140", os: "Windows", viewportW: 1280, viewportH: 800, devicePixelRatio: 1 },
      extensionVersion: "2.1.0",
      artifacts: [{ role: "viewport_screenshot", partIndex: 0, expectedSha256: shot.sha256, sizeBytes: shot.sizeBytes, mediaType: "image/png", completeness: "PARTIAL" }],
      completeness: "PARTIAL",
      pageMutatedDuringCapture: true,
      limitations: ["PAGE_MUTATED_DURING_CAPTURE"],
      notes: [],
    });
    await uploadAndDeclare(extensionToken, evidenceId, sessionId, 1, Buffer.from(manifestJson, "utf8"), "WEB_MANIFEST");
    const done = await call("POST", `/v1/capture/direct-sessions/${sessionId}/web-complete`, extensionToken, { manifestJson });
    expect(done.statusCode, done.body).toBe(200);

    const events = await prisma.captureTrustEventRecord.findMany({
      where: { captureSessionId: sessionId },
      orderBy: { sequence: "asc" },
      select: { code: true, payload: true, evidenceId: true },
    });
    const facts = selectCaptureManifestFacts(events, { manifestSha256: sha256(manifestJson) });
    expect(facts).not.toBeNull();
    expect(facts!.web).toEqual({
      domain: "news.example.org",
      sourceUrlPrivate: "https://news.example.org/story?session=private-token",
      titlePrivate: "Private headline",
      captureMode: "VIEWPORT",
      pageMutatedDuringCapture: true,
    });
    expect(facts!.completeness).toBe("PARTIAL");
    expect(facts!.reportedComplete).toBe(false);
    expect(facts!.limitations).toEqual(["PAGE_MUTATED_DURING_CAPTURE"]);
    expect(facts!.client).toMatchObject({ kind: "BROWSER_EXTENSION", appVersion: "2.1.0", browserName: "Chrome" });
    // Written before the bind (covered by its chain head) and never mirrored to custody.
    const factsIdx = events.findIndex((e) => (e.payload as Record<string, unknown>)?.stage === "manifest_facts");
    const boundIdx = events.findIndex((e) => e.code === "CAPTURE_SESSION_BOUND");
    expect(factsIdx).toBeGreaterThanOrEqual(0);
    expect(factsIdx).toBeLessThan(boundIdx);
    expect(events[factsIdx]!.evidenceId).toBeNull();
    const custody = await prisma.custodyEvent.findMany({ where: { evidenceId }, select: { payload: true } });
    expect(JSON.stringify(custody)).not.toContain("private-token");
  });

  it("UC-AND-008 the UC-2 manifest part is classed BEFORE the seal: a failure after the bind leaves it classed", async () => {
    const token = owner().ownerToken;
    const { sessionId, evidenceId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID");
    const frame = await uploadAndDeclare(token, evidenceId, sessionId, 0, Buffer.from(`frame-${randomBytes(6).toString("hex")}`), "SCREEN_FRAME");
    const manifestJson = JSON.stringify({
      schemaVersion: SCREEN_CAPTURE_MANIFEST_SCHEMA_VERSION,
      captureSessionId: sessionId,
      // AUD-22 (2026-10-20): a believable window (a month-old one is refused).
      captureStartedAtUtc: new Date(Date.now() - 4000).toISOString(),
      captureEndedAtUtc: new Date(Date.now() - 2000).toISOString(),
      device: { platform: "android", osVersion: "14", model: "Pixel 7", appVersion: "1.0.0", screenW: 1080, screenH: 2400, densityDpi: 420, orientation: "portrait" },
      osConsentGranted: true,
      artifacts: [{ role: "screen_frame", partIndex: 0, frameIndex: 0, expectedSha256: frame.sha256, sizeBytes: frame.sizeBytes, mediaType: "image/png", widthPx: 1080, heightPx: 2400, capturedAtOffsetMs: 0, completeness: "CAPTURED" }],
      completeness: "CAPTURED",
      stopReason: "USER_STOPPED",
      limitations: [],
      notes: [],
    });
    await uploadAndDeclare(token, evidenceId, sessionId, 1, Buffer.from(manifestJson, "utf8"), "SCREEN_MANIFEST");
    failEmit.code = "CAPTURE_SESSION_BOUND";
    const r = await call("POST", `/v1/capture/direct-sessions/${sessionId}/screen-complete`, token, { manifestJson });
    expect(r.statusCode).toBe(500);
    expect(await statusOf(evidenceId)).toBe("SIGNED");
    const part = await prisma.evidencePart.findFirstOrThrow({ where: { evidenceId, partIndex: 1 }, select: { artifactClass: true } });
    expect(part.artifactClass).toBe("CAPTURE_MANIFEST");
  });

  // ---------------------------------------------------------------- AUD-37
  // A segment DECLARED whose bytes never arrived made the whole session
  // unsealable (the seal expected every declared part and its bytes). It is
  // now stated LOST (append-only) and the session seals INTERRUPTED.
  describe("AUD-37 — a declared-then-lost segment", () => {
    const loss = (token: string, sessionId: string, partIndex: number) =>
      call("POST", `/v1/capture/direct-sessions/${sessionId}/parts/${partIndex}/loss`, token, {});

    /** Segments 0 and 2 stored; segment 1 declared and presigned, its bytes never stored. */
    async function stageWithLostMiddle() {
      const { token, sessionId, evidenceId, segs } = await stageSegments(3, [0, 2]);
      const presign = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
        partIndex: 1,
        mimeType: "application/octet-stream",
        originalFileName: "part-1.bin",
      });
      expect(presign.statusCode, presign.body).toBe(201);
      const d = await declare(token, sessionId, 1, sha256(`never-uploaded-${randomBytes(4).toString("hex")}`), "SCREEN_SEGMENT", 2);
      expect(d.statusCode, d.body).toBe(201);
      return { token, sessionId, evidenceId, segs };
    }

    it("is stated LOST (idempotent) and the session seals INTERRUPTED with the loss", async () => {
      const { token, sessionId, evidenceId, segs } = await stageWithLostMiddle();
      // Without the loss the declared segment has no bytes and nothing seals.
      const blocked = continuousManifest(sessionId, segs, { recorded: 3, completeness: "INTERRUPTED_SESSION", termination: "INTERRUPTED", limitations: ["SEGMENT_UPLOAD_LOST"] });
      await stageManifest(token, sessionId, evidenceId, blocked, 3);
      expect((await seal(token, sessionId, blocked)).statusCode).not.toBe(200);
      expect(await statusOf(evidenceId)).not.toBe("SIGNED");

      const first = await loss(token, sessionId, 1);
      expect(first.statusCode, first.body).toBe(201);
      expect((await loss(token, sessionId, 1)).statusCode).toBe(200);

      const sealed = await seal(token, sessionId, blocked);
      expect(sealed.statusCode, sealed.body).toBe(200);
      expect(await statusOf(evidenceId)).toBe("SIGNED");
      const parts = await prisma.evidencePart.findMany({ where: { evidenceId }, select: { partIndex: true }, orderBy: { partIndex: "asc" } });
      expect(parts.map((p) => p.partIndex)).toEqual([0, 2, 3]);
      const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
      expect(session.endReason).toBe("CONTINUOUS_INTERRUPTED_SESSION");
      const lostEvent = await prisma.captureTrustEventRecord.findFirst({ where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_LOST" } });
      expect(lostEvent?.payload).toMatchObject({ stage: "part_lost", partIndex: 1 });
      // The declaration itself was never withdrawn (append-only chain).
      const declared = await prisma.captureTrustEventRecord.count({ where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_RECEIVED" } });
      expect(declared).toBeGreaterThanOrEqual(4);
    });

    it("a lost segment can never be sealed over as COMPLETE", async () => {
      const { token, sessionId, evidenceId, segs } = await stageWithLostMiddle();
      expect((await loss(token, sessionId, 1)).statusCode).toBe(201);
      const complete = continuousManifest(sessionId, segs, { recorded: 2, completeness: "COMPLETE_SESSION" });
      await stageManifest(token, sessionId, evidenceId, complete, 3);
      const res = await seal(token, sessionId, complete);
      expect(res.statusCode).toBe(422);
      expect(await statusOf(evidenceId)).not.toBe("SIGNED");
    });

    // F-02 (independent forward audit) — the LAST segment lost. The middle-loss
    // case above is refused by the manifest's sequence-hole check; a lost TAIL
    // left no hole once the recorder count was lowered, and the planner read
    // the running count only from the surviving declarations.
    async function stageWithLostTail() {
      const { token, sessionId, evidenceId, segs } = await stageSegments(3, [0, 1]);
      const presign = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, {
        partIndex: 2,
        mimeType: "application/octet-stream",
        originalFileName: "part-2.bin",
      });
      expect(presign.statusCode, presign.body).toBe(201);
      const d = await declare(token, sessionId, 2, sha256(`never-uploaded-${randomBytes(4).toString("hex")}`), "SCREEN_SEGMENT", 3);
      expect(d.statusCode, d.body).toBe(201);
      expect((await loss(token, sessionId, 2)).statusCode).toBe(201);
      return { token, sessionId, evidenceId, segs };
    }

    it("F-02: a lost LAST segment can never be sealed over as COMPLETE (recorder count lowered to hide it)", async () => {
      const { token, sessionId, evidenceId, segs } = await stageWithLostTail();
      const complete = continuousManifest(sessionId, segs, { recorded: 2, completeness: "COMPLETE_SESSION" });
      await stageManifest(token, sessionId, evidenceId, complete, 3);
      const res = await seal(token, sessionId, complete);
      expect(res.statusCode, res.body).toBe(422);
      expect(await statusOf(evidenceId)).not.toBe("SIGNED");
      const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
      expect(session.endReason).not.toBe("CONTINUOUS_COMPLETE_SESSION");
    });

    it("F-02: a lost LAST segment cannot be hidden from an INTERRUPTED seal either; the honest loss seals", async () => {
      const { token, sessionId, evidenceId, segs } = await stageWithLostTail();
      // Recorder count lowered to 2: the loss of segment 2 would be invisible.
      const hidden = continuousManifest(sessionId, segs, { recorded: 2, completeness: "INTERRUPTED_SESSION", termination: "INTERRUPTED" });
      await stageManifest(token, sessionId, evidenceId, hidden, 3);
      expect((await seal(token, sessionId, hidden)).statusCode).toBe(422);
      expect(await statusOf(evidenceId)).not.toBe("SIGNED");
    });

    it("F-02: the honest manifest for a lost tail seals INTERRUPTED with the loss", async () => {
      const { token, sessionId, evidenceId, segs } = await stageWithLostTail();
      const honest = continuousManifest(sessionId, segs, { recorded: 3, completeness: "INTERRUPTED_SESSION", termination: "INTERRUPTED", limitations: ["SEGMENT_UPLOAD_LOST"] });
      await stageManifest(token, sessionId, evidenceId, honest, 3);
      const sealed = await seal(token, sessionId, honest);
      expect(sealed.statusCode, sealed.body).toBe(200);
      const session = await prisma.captureSession.findUniqueOrThrow({ where: { id: sessionId }, select: { endReason: true } });
      expect(session.endReason).toBe("CONTINUOUS_INTERRUPTED_SESSION");
    });

    it("F-17: a loss that fails after its event was appended leaves neither the event nor the withdrawal; the retry states it once", async () => {
      const { token, sessionId, evidenceId } = await stageWithLostMiddle();
      failAfterEmit.code = "CAPTURE_ARTIFACT_LOST";
      const failed = await loss(token, sessionId, 1);
      expect(failed.statusCode).toBeGreaterThanOrEqual(500);
      expect(await prisma.captureTrustEventRecord.count({ where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_LOST" } })).toBe(0);
      expect(await prisma.evidencePart.count({ where: { evidenceId, partIndex: 1 } })).toBe(1);
      const retried = await loss(token, sessionId, 1);
      expect(retried.statusCode, retried.body).toBe(201);
      expect(await prisma.captureTrustEventRecord.count({ where: { captureSessionId: sessionId, code: "CAPTURE_ARTIFACT_LOST" } })).toBe(1);
      expect(await prisma.evidencePart.count({ where: { evidenceId, partIndex: 1 } })).toBe(0);
    });

    it("an index stated lost is never declared again nor re-presigned", async () => {
      const { token, sessionId, evidenceId } = await stageWithLostMiddle();
      expect((await loss(token, sessionId, 1)).statusCode).toBe(201);
      const again = await declare(token, sessionId, 1, sha256("a different digest"), "SCREEN_SEGMENT", 2);
      expect(again.statusCode).toBe(409);
      expect(again.json().denial ?? again.json().error?.code ?? again.body).toMatch(/PART_LOST/);
      const presign = await call("POST", `/v1/evidence/${evidenceId}/parts`, token, { partIndex: 1, mimeType: "application/octet-stream" });
      expect(presign.statusCode).toBe(409);
      expect(presign.body).toMatch(/PART_LOST/);
    });

    it("a segment whose bytes ARE stored is not lost", async () => {
      const { token, sessionId } = await stageSegments(2, [0, 1]);
      const res = await loss(token, sessionId, 0);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatch(/PART_BYTES_PRESENT/);
    });

    it("a never-declared index cannot be stated lost", async () => {
      const { token, sessionId } = await stageSegments(1, [0]);
      const res = await loss(token, sessionId, 5);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatch(/PART_NOT_DECLARED/);
    });

    it("only a continuous session may state a loss", async () => {
      const { sessionId } = await openAndReserve("DIRECT_SCREEN_CAPTURE_ANDROID");
      const res = await loss(owner().ownerToken, sessionId, 0);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatch(/LOSS_NOT_SUPPORTED_FOR_MODE/);
    });
  });

});
