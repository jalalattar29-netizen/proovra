/**
 * Citizen capture → Evidence row materialisation contract.
 *
 * The audit found that acceptCitizenCapture (services/api/src/services/
 * capture-trust/citizen-capture.service.ts) emitted trust events but
 * never created an Evidence row. Citizen captures were therefore
 * structurally invisible to every investigation surface (graph,
 * timeline, search, dashboards) because the fanout never fired.
 *
 * These tests lock the repair in place:
 *
 *   1. On a VALID verdict, acceptCitizenCapture MUST call the canonical
 *      createEvidence helper AND completeEvidence (the only entry that
 *      triggers the post-finalize fanout).
 *   2. The bytes received from the citizen MUST be PUT to the bucket/key
 *      reserved by createEvidence before completeEvidence runs (so the
 *      stream-hash step sees real bytes).
 *   3. The returned receipt MUST surface the new evidenceId.
 *   4. A persist failure (createEvidence throws / putObjectBuffer
 *      throws / completeEvidence throws) MUST return a bounded
 *      EVIDENCE_PERSIST_FAILED denial — not a silent ok-with-no-row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — bound BEFORE the SUT import.
// ---------------------------------------------------------------------------

const verifyCaptureSignatureMock = vi.fn();
vi.mock("../src/services/capture-trust/signature-verifier.service.js", () => ({
  verifyCaptureSignature: verifyCaptureSignatureMock,
}));

const emitCaptureTrustEventMock = vi.fn(async () => {});
vi.mock("../src/services/capture-trust/trust-event.service.js", () => ({
  emitCaptureTrustEvent: emitCaptureTrustEventMock,
}));

const createEvidenceMock = vi.fn();
vi.mock("../src/services/evidence.service.js", () => ({
  createEvidence: createEvidenceMock,
}));

const completeEvidenceMock = vi.fn();
vi.mock("../src/services/evidence-complete.service.js", () => ({
  completeEvidence: completeEvidenceMock,
}));

const putObjectBufferMock = vi.fn(async () => {});
vi.mock("../src/storage.js", () => ({
  putObjectBuffer: putObjectBufferMock,
}));

vi.mock("../src/db.js", () => ({ prisma: {} }));

// The shared clampProvenanceClass is real; we exercise it as-is to lock
// the citizen-clamp behaviour.
const { acceptCitizenCapture } = await import(
  "../src/services/capture-trust/citizen-capture.service.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidInput(
  overrides: Partial<Parameters<typeof acceptCitizenCapture>[0]> = {},
): Parameters<typeof acceptCitizenCapture>[0] {
  return {
    teamId: "team-1",
    intakeTokenId: "anonymous",
    ownerUserId: "user-1",
    mimeType: "image/jpeg",
    originalFileName: "evidence.jpg",
    payload: {
      schemaVersion: "PROOVRA_CAPTURE_SIG_V1",
      assetHash: "a".repeat(64),
      captureMode: "CITIZEN_PWA",
      provenanceClass: "B",
      deviceKeyId: "00000000-0000-0000-0000-000000000001",
      algorithm: "Ed25519",
      captureSessionId: "00000000-0000-0000-0000-000000000002",
      signedAtUtc: new Date().toISOString(),
      signedAtMonotonicNs: "1",
      nonceHex: "b".repeat(64),
      metadata: {
        deviceModel: "browser",
        osVersion: "web",
        appVersion: "pwa",
        networkState: "ONLINE",
        locationPolicy: "OFF",
        location: null,
        camera: null,
        sensor: null,
        operatorContext: null,
      },
    } as never,
    signatureHex: "deadbeef",
    assetBytes: Buffer.from("hello citizen"),
    ...overrides,
  };
}

beforeEach(() => {
  verifyCaptureSignatureMock.mockReset();
  emitCaptureTrustEventMock.mockReset();
  emitCaptureTrustEventMock.mockResolvedValue(undefined);
  createEvidenceMock.mockReset();
  completeEvidenceMock.mockReset();
  putObjectBufferMock.mockReset();
  putObjectBufferMock.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("acceptCitizenCapture — Evidence materialisation contract", () => {
  it("calls createEvidence + putObjectBuffer + completeEvidence on a VALID verdict", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 256,
      deviceId: "device-1",
    });
    createEvidenceMock.mockResolvedValueOnce({
      id: "evidence-1",
      teamId: "team-1",
      upload: {
        bucket: "proovra-bucket",
        key: "evidence/evidence-1/original-evidence.jpg",
        putUrl: "https://example/put",
        publicUrl: null,
        expiresInSeconds: 600,
      },
    });
    completeEvidenceMock.mockResolvedValueOnce({
      id: "evidence-1",
      status: "SIGNED",
      fileSha256: "a".repeat(64),
      fingerprintHash: "f".repeat(64),
      signatureBase64: "sig",
      signingKeyId: "key-1",
      signingKeyVersion: 1,
    });

    const result = await acceptCitizenCapture(makeValidInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidenceId).toBe("evidence-1");
    expect(result.provenanceClass).toBe("B");

    // Canonical reuse: NOT a custom evidence path.
    expect(createEvidenceMock).toHaveBeenCalledTimes(1);
    const createArgs = (createEvidenceMock.mock.calls[0] as unknown[])[0] as {
      ownerUserId: string;
      teamId: string;
      type: string;
      mimeType: string;
    };
    expect(createArgs.ownerUserId).toBe("user-1");
    expect(createArgs.teamId).toBe("team-1");
    expect(createArgs.type).toBe("PHOTO"); // image/jpeg → PHOTO
    expect(createArgs.mimeType).toBe("image/jpeg");

    // Bytes go to the bucket/key the canonical creator chose.
    expect(putObjectBufferMock).toHaveBeenCalledTimes(1);
    const putArgs = (putObjectBufferMock.mock.calls[0] as unknown[])[0] as {
      bucket: string;
      key: string;
      body: Buffer;
      contentType: string;
    };
    expect(putArgs.bucket).toBe("proovra-bucket");
    expect(putArgs.key).toBe("evidence/evidence-1/original-evidence.jpg");
    expect(Buffer.isBuffer(putArgs.body)).toBe(true);
    expect(putArgs.body.toString()).toBe("hello citizen");
    expect(putArgs.contentType).toBe("image/jpeg");

    // completeEvidence is the SINGLE entry into the integrity + fanout
    // pipeline. We never bypass it.
    expect(completeEvidenceMock).toHaveBeenCalledTimes(1);
    expect((completeEvidenceMock.mock.calls[0] as unknown[])[0]).toEqual({
      evidenceId: "evidence-1",
      ownerUserId: "user-1",
    });
  });

  it("classifies video MIME types as VIDEO", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 0,
      deviceId: "device-1",
    });
    createEvidenceMock.mockResolvedValueOnce({
      id: "evidence-2",
      teamId: "team-1",
      upload: {
        bucket: "b",
        key: "k",
        putUrl: "u",
        publicUrl: null,
        expiresInSeconds: 600,
      },
    });
    completeEvidenceMock.mockResolvedValueOnce({
      id: "evidence-2",
      status: "SIGNED",
      fileSha256: null,
      fingerprintHash: null,
      signatureBase64: null,
      signingKeyId: null,
      signingKeyVersion: null,
    });

    await acceptCitizenCapture(makeValidInput({ mimeType: "video/mp4" }));

    const args = (createEvidenceMock.mock.calls[0] as unknown[])[0] as {
      type: string;
    };
    expect(args.type).toBe("VIDEO");
  });

  it("links the final trust event to the new Evidence id", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 0,
      deviceId: "device-1",
    });
    createEvidenceMock.mockResolvedValueOnce({
      id: "evidence-3",
      teamId: "team-1",
      upload: { bucket: "b", key: "k", putUrl: "u", publicUrl: null, expiresInSeconds: 600 },
    });
    completeEvidenceMock.mockResolvedValueOnce({
      id: "evidence-3",
      status: "SIGNED",
      fileSha256: null,
      fingerprintHash: null,
      signatureBase64: null,
      signingKeyId: null,
      signingKeyVersion: null,
    });

    await acceptCitizenCapture(makeValidInput());

    // Look for a trust event that carries evidenceId = "evidence-3"
    // (the "evidence_materialised" join event added by the repair).
    type TrustEventCall = {
      evidenceId?: string | null;
      code?: string;
      payload?: { stage?: string };
    };
    const calls = emitCaptureTrustEventMock.mock.calls as unknown[][];
    const evidenceLinkedCalls = calls.filter((c) => {
      const arg = c[0] as TrustEventCall;
      return arg && arg.evidenceId === "evidence-3";
    });
    expect(evidenceLinkedCalls.length).toBeGreaterThanOrEqual(1);
    const linked = evidenceLinkedCalls[0]![0] as TrustEventCall;
    expect(linked.code).toBe("CAPTURE_ARTIFACT_RECEIVED");
    expect(linked.payload?.stage).toBe("evidence_materialised");
  });
});

// ---------------------------------------------------------------------------
// Failure paths
// ---------------------------------------------------------------------------

describe("acceptCitizenCapture — failure surfaces a bounded denial", () => {
  it("returns EVIDENCE_PERSIST_FAILED when createEvidence throws", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 0,
      deviceId: "device-1",
    });
    createEvidenceMock.mockRejectedValueOnce(new Error("db down"));

    const result = await acceptCitizenCapture(makeValidInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial).toBe("EVIDENCE_PERSIST_FAILED");
    expect(putObjectBufferMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
  });

  it("returns EVIDENCE_PERSIST_FAILED when putObjectBuffer throws", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 0,
      deviceId: "device-1",
    });
    createEvidenceMock.mockResolvedValueOnce({
      id: "evidence-x",
      teamId: "team-1",
      upload: { bucket: "b", key: "k", putUrl: "u", publicUrl: null, expiresInSeconds: 600 },
    });
    putObjectBufferMock.mockRejectedValueOnce(new Error("s3 down"));

    const result = await acceptCitizenCapture(makeValidInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial).toBe("EVIDENCE_PERSIST_FAILED");
    expect(completeEvidenceMock).not.toHaveBeenCalled();
  });

  it("returns EVIDENCE_PERSIST_FAILED when completeEvidence throws", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "VALID",
      fatal: false,
      computedAssetHash: "a".repeat(64),
      canonicalBytesLength: 0,
      deviceId: "device-1",
    });
    createEvidenceMock.mockResolvedValueOnce({
      id: "evidence-y",
      teamId: "team-1",
      upload: { bucket: "b", key: "k", putUrl: "u", publicUrl: null, expiresInSeconds: 600 },
    });
    completeEvidenceMock.mockRejectedValueOnce(new Error("sign failed"));

    const result = await acceptCitizenCapture(makeValidInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial).toBe("EVIDENCE_PERSIST_FAILED");
  });

  it("does NOT call createEvidence when verifyCaptureSignature returns INVALID_HASH", async () => {
    verifyCaptureSignatureMock.mockResolvedValueOnce({
      verdict: "INVALID_HASH",
      fatal: true,
      computedAssetHash: "z".repeat(64),
      canonicalBytesLength: 0,
      deviceId: null,
    });

    const result = await acceptCitizenCapture(makeValidInput());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.denial).toBe("BYTES_HASH_MISMATCH");
    expect(createEvidenceMock).not.toHaveBeenCalled();
    expect(putObjectBufferMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
  });
});
