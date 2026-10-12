/**
 * FINALIZE-TIME RETENTION: AccessDenied IS NOT "ALREADY LOCKED".
 *
 * `applyRetentionOrThrow` used to treat any AccessDenied — and any error whose
 * message merely contained "object lock", "retention" or "legal hold" — as
 * "already locked by an earlier write", counting it as applied and swallowing
 * the error. That swallowed IAM / KMS denials and even
 * `InvalidRequest: Bucket is missing Object Lock Configuration`.
 *
 * The contract pinned here:
 *   - AccessDenied is UNKNOWN. A HEAD of that exact target version decides:
 *     mode COMPLIANCE/GOVERNANCE with a future retain-until → confirmed;
 *     otherwise not confirmed, `retention_access_denied_unconfirmed` (or
 *     `retention_unverifiable` when the HEAD fails), logged, NOT thrown.
 *   - Every other error (including the missing-configuration one) throws.
 *   - `allConfirmed` is true only when every target was applied or confirmed —
 *     the condition EVIDENCE_LOCKED (which speaks for `itemCount` items) needs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyDefaultObjectRetentionMock = vi.fn();
const headObjectMock = vi.fn();
vi.mock("../src/storage.js", () => ({
  applyDefaultObjectRetention: applyDefaultObjectRetentionMock,
  getObjectStream: vi.fn(),
  headObject: headObjectMock,
}));

const logWarnMock = vi.fn();
vi.mock("../src/utils/logger.js", () => ({
  log: vi.fn(),
  warn: logWarnMock,
  error: vi.fn(),
}));

// The rest of evidence-complete's import graph is not exercised here.
vi.mock("../src/db.js", () => ({ prisma: {} }));
vi.mock("../src/crypto.js", () => ({ canonicalJson: () => "", sha256Hex: () => "" }));
vi.mock("../src/signing/signer.js", () => ({ getEvidenceSigner: () => null }));
vi.mock("../src/services/billing-enforcement.service.js", () => ({
  assertWorkspaceAllowsStorageGrowth: vi.fn(),
  consumeWorkspaceCompletionCredits: vi.fn(),
  resolveEnforcementScopeForRequester: vi.fn(),
}));
vi.mock("../src/stream-hash.js", () => ({ sha256HexFromStream: vi.fn() }));
vi.mock("../src/services/timestamp.service.js", () => ({ createEvidenceTimestamp: vi.fn() }));
vi.mock("../src/queue/report-queue.js", () => ({ enqueueGenerateReportJob: vi.fn() }));
vi.mock("../src/services/custody-events.service.js", () => ({
  appendCustodyEvent: vi.fn(),
  appendCustodyEventTx: vi.fn(),
}));
vi.mock("../src/services/integrations/webhook-dispatcher.js", () => ({ emitWebhookEvent: vi.fn() }));
vi.mock("../src/services/security/file-security-scan.service.js", () => ({
  enqueueScan: vi.fn(),
  isMalwareScanningEnabled: () => false,
  runScan: vi.fn(),
}));
vi.mock("../src/services/security/security-event.service.js", () => ({ safeEmitSecurityEvent: vi.fn() }));
vi.mock("../src/services/reliability/upload-session.service.js", () => ({ safeTransitionUploadSession: vi.fn() }));
vi.mock("../src/services/uploads/upload-session.service.js", () => ({ evaluateUploadSessionFinalizeGate: vi.fn() }));

const { applyRetentionOrThrow, isAccessDeniedLike } = await import(
  "../src/services/evidence-complete.service.js"
);

const FUTURE = () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
const PAST = () => new Date(Date.now() - 24 * 60 * 60 * 1000);

function accessDenied(): Error {
  return Object.assign(new Error("Access Denied"), { name: "AccessDenied", Code: "AccessDenied" });
}
function head(mode: string | null, until: Date | null) {
  return {
    sizeBytes: 1,
    versionId: "v-sealed",
    objectLockMode: mode,
    objectLockRetainUntilDate: until,
    objectLockLegalHoldStatus: null,
  };
}

const PRIMARY = { bucket: "b", key: "evidence/x/original", versionId: "v-sealed" };
const PART = { bucket: "b", key: "evidence/x/part-1", versionId: "v-part", evidencePartId: "part-1" };

beforeEach(() => {
  applyDefaultObjectRetentionMock.mockReset();
  headObjectMock.mockReset();
  logWarnMock.mockReset();
});

describe("isAccessDeniedLike — narrow", () => {
  it("matches the S3 AccessDenied shape", () => {
    expect(isAccessDeniedLike(accessDenied())).toBe(true);
    expect(isAccessDeniedLike({ code: "AccessDenied" })).toBe(true);
    expect(isAccessDeniedLike(new Error("Access Denied because object protected by object lock"))).toBe(true);
  });
  it("no longer matches messages that merely mention object lock / retention / legal hold", () => {
    expect(
      isAccessDeniedLike(
        Object.assign(new Error("Bucket is missing Object Lock Configuration"), { name: "InvalidRequest" }),
      ),
    ).toBe(false);
    expect(isAccessDeniedLike(new Error("retention period invalid"))).toBe(false);
    expect(isAccessDeniedLike(new Error("legal hold not permitted"))).toBe(false);
    expect(isAccessDeniedLike({ name: "AccessDeniedSomethingElse" })).toBe(false);
  });
});

describe("applyRetentionOrThrow", () => {
  it("retention written for every target → applied and allConfirmed", async () => {
    applyDefaultObjectRetentionMock.mockResolvedValue({ applied: true });
    const r = await applyRetentionOrThrow([PRIMARY, PART]);
    expect(r).toEqual({ anyApplied: true, allConfirmed: true, reason: null });
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("AccessDenied + HEAD shows NO lock → not applied, retention_access_denied_unconfirmed, logged, no throw", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(accessDenied());
    headObjectMock.mockResolvedValue(head(null, null));
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r).toEqual({ anyApplied: false, allConfirmed: false, reason: "retention_access_denied_unconfirmed" });
    // The HEAD addressed the exact target version.
    expect(headObjectMock).toHaveBeenCalledWith({ bucket: "b", key: "evidence/x/original", versionId: "v-sealed" });
    expect(logWarnMock).toHaveBeenCalledWith(
      "evidence_complete.retention_unconfirmed",
      expect.objectContaining({ reason: "retention_access_denied_unconfirmed" }),
    );
  });

  it("AccessDenied + HEAD shows an EXPIRED retention → not confirmed", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(accessDenied());
    headObjectMock.mockResolvedValue(head("COMPLIANCE", PAST()));
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r.allConfirmed).toBe(false);
    expect(r.anyApplied).toBe(false);
    expect(r.reason).toBe("retention_access_denied_unconfirmed");
  });

  it("AccessDenied + HEAD shows an unknown mode → not confirmed", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(accessDenied());
    headObjectMock.mockResolvedValue(head("SOMETHING", FUTURE()));
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r.allConfirmed).toBe(false);
  });

  for (const mode of ["COMPLIANCE", "GOVERNANCE"] as const) {
    it(`AccessDenied + HEAD confirms ${mode} with a future retain-until → confirmed already locked`, async () => {
      applyDefaultObjectRetentionMock.mockRejectedValue(accessDenied());
      headObjectMock.mockResolvedValue(head(mode, FUTURE()));
      const r = await applyRetentionOrThrow([PRIMARY]);
      expect(r).toEqual({ anyApplied: true, allConfirmed: true, reason: null });
      expect(logWarnMock).not.toHaveBeenCalled();
    });
  }

  it("AccessDenied + the HEAD itself fails → retention_unverifiable, no throw", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(accessDenied());
    headObjectMock.mockRejectedValue(new Error("network"));
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r).toEqual({ anyApplied: false, allConfirmed: false, reason: "retention_unverifiable" });
  });

  it("'Bucket is missing Object Lock Configuration' THROWS (no longer swallowed as success)", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(
      Object.assign(new Error("Bucket is missing Object Lock Configuration"), { name: "InvalidRequest" }),
    );
    await expect(applyRetentionOrThrow([PRIMARY])).rejects.toThrow(/^EVIDENCE_RETENTION_APPLY_FAILED/);
    expect(headObjectMock).not.toHaveBeenCalled();
  });

  it("any other unrecognised error throws as before", async () => {
    applyDefaultObjectRetentionMock.mockRejectedValue(new Error("SlowDown"));
    await expect(applyRetentionOrThrow([PRIMARY])).rejects.toThrow(/EVIDENCE_RETENTION_APPLY_FAILED/);
  });

  it("multipart: primary written, one part denied and unconfirmed → anyApplied but NOT allConfirmed", async () => {
    applyDefaultObjectRetentionMock.mockImplementation(async (t: { key: string }) => {
      if (t.key === PART.key) throw accessDenied();
      return { applied: true };
    });
    headObjectMock.mockResolvedValue(head(null, null));
    const r = await applyRetentionOrThrow([PRIMARY, PART]);
    expect(r).toEqual({ anyApplied: true, allConfirmed: false, reason: "retention_access_denied_unconfirmed" });
    expect(logWarnMock).toHaveBeenCalledWith(
      "evidence_complete.retention_unconfirmed",
      expect.objectContaining({ isPart: true }),
    );
  });

  it("Object Lock disabled → not applied, not confirmed, reason carried through", async () => {
    applyDefaultObjectRetentionMock.mockResolvedValue({ applied: false, reason: "object_lock_disabled" });
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r).toEqual({ anyApplied: false, allConfirmed: false, reason: "object_lock_disabled" });
  });

  it("defaults incomplete → not applied, object_lock_defaults_incomplete carried through", async () => {
    applyDefaultObjectRetentionMock.mockResolvedValue({ applied: false, reason: "object_lock_defaults_incomplete" });
    const r = await applyRetentionOrThrow([PRIMARY]);
    expect(r.allConfirmed).toBe(false);
    expect(r.reason).toBe("object_lock_defaults_incomplete");
  });
});

describe("EVIDENCE_LOCKED requires every target confirmed (source contract)", () => {
  it("lockTrulyApplied includes allConfirmed", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(__dirname, "../src/services/evidence-complete.service.ts"), "utf8");
    expect(src).toMatch(
      /const lockTrulyApplied =\s*retentionResult\.anyApplied === true &&\s*retentionResult\.allConfirmed === true &&/,
    );
    expect(src).not.toContain("isAlreadyObjectLockedLike");
  });
});
