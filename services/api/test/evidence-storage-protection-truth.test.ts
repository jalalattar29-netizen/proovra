/**
 * EVIDENCE-OUTPUT INCIDENT (2026-10-05) — "Storage protection incomplete".
 *
 * Finalization HEADs the exact object version and records its Object Lock
 * mode / retain-until on the row. ET-PKG-06 made the review summary report such
 * a RECORDED snapshot as `verified: false` (it was not observed just now) — and
 * the review alert fired on `!verified`. So every record whose lock was
 * correctly recorded at sealing was told "Storage object lock or legal hold
 * settings are not fully configured". The alert now follows the ONE shared
 * classification (`classifyStorageProtection`), with provenance kept separate.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  prisma: { custodyEvent: { findMany: async () => [] } },
}));

const { buildEvidenceIntelligence } = await import("../src/services/evidence-intelligence.service.js");

const FUTURE = "2036-01-01T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function evidence() {
  return {
    id: "ev-1",
    status: "SIGNED",
    verificationStatus: null,
    signedAtUtc: "2026-08-01T00:00:00Z",
    capturedAtUtc: null,
    uploadedAtUtc: null,
    lastAccessedAtUtc: null,
    lastVerifiedAtUtc: null,
    recordedIntegrityVerifiedAtUtc: null,
    captureMethod: null,
    identityLevelSnapshot: null,
    submittedByEmail: null,
    submittedByAuthProvider: null,
    uploadedByUserId: null,
    createdByUserId: null,
    workspaceNameSnapshot: null,
    organizationNameSnapshot: null,
    organizationVerifiedSnapshot: null,
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    signatureBase64: "sig",
    signingKeyId: "k",
    signingKeyVersion: 1,
    tsaStatus: "STAMPED",
    otsStatus: "PENDING",
    otsAnchoredAtUtc: null,
    otsAnchorCheck: null,
    reportGeneratedAtUtc: null,
    verificationPackageGeneratedAtUtc: null,
    latestReportVersion: null,
    verificationPackageVersion: null,
    createdAt: "2026-08-01T00:00:00Z",
    deviceTimeIso: null,
    lat: null,
    lng: null,
    accuracyMeters: null,
    lockedAt: null,
    archivedAt: null,
    deletedAt: null,
    deleteScheduledForUtc: null,
    retentionUntilUtc: null,
    storageBucket: "b",
    storageKey: "k",
    storageRegion: "eu",
    storageObjectLockMode: null,
    storageObjectLockRetainUntilUtc: null,
    storageObjectLockLegalHoldStatus: null,
  };
}

const OUTPUTS = {
  report: { state: "NOT_INCLUDED", notApplicableReason: null },
  verificationPackage: { state: "NOT_INCLUDED", notApplicableReason: null },
} as const;

async function alertsFor(storage: Record<string, unknown> | null) {
  const i = await buildEvidenceIntelligence({
    evidenceId: "ev-1",
    evidence: evidence() as never,
    anchor: null,
    storage: storage as never,
    outputs: OUTPUTS as never,
  });
  return i.reviewerAlerts;
}

const label = (alerts: Array<{ label: string }>) => alerts.map((a) => a.label);

describe("storage protection alert — one classification, provenance kept separate", () => {
  it("a COMPLIANCE lock RECORDED at sealing and still in force is NOT flagged (the incident's false alarm)", async () => {
    const alerts = await alertsFor({
      immutable: true,
      mode: "COMPLIANCE",
      retainUntil: FUTURE,
      legalHold: "OFF",
      region: "eu",
      verified: false,
      source: "RECORDED",
    });
    expect(label(alerts)).not.toContain("Storage protection incomplete");
    expect(label(alerts)).not.toContain("Storage protection not confirmed");
    expect(JSON.stringify(alerts)).not.toMatch(/not fully configured/);
  });

  it("an OBSERVED lock in force is not flagged either", async () => {
    const alerts = await alertsFor({
      immutable: false,
      mode: "GOVERNANCE",
      retainUntil: FUTURE,
      legalHold: null,
      region: "eu",
      verified: true,
      source: "OBSERVED",
    });
    expect(label(alerts)).not.toContain("Storage protection incomplete");
  });

  it("no retention and no hold IS flagged, worded as a fact about this object", async () => {
    const alerts = await alertsFor({
      immutable: false,
      mode: null,
      retainUntil: null,
      legalHold: null,
      region: "eu",
      verified: false,
      source: "OBSERVED",
    });
    const hit = alerts.find((a) => a.label === "Storage protection incomplete");
    expect(hit?.detail).toBe("No Object Lock retention or legal hold is applied to this record's stored object.");
  });

  it("expired retention says it ended; an unreadable object says it is not confirmed", async () => {
    expect(
      label(
        await alertsFor({ immutable: false, mode: "COMPLIANCE", retainUntil: PAST, legalHold: null, region: "eu", verified: false, source: "RECORDED", expired: true }),
      ),
    ).toContain("Storage retention ended");
    expect(
      label(
        await alertsFor({ immutable: false, mode: null, retainUntil: null, legalHold: null, region: "eu", verified: false, source: "OBSERVED", readFailed: true }),
      ),
    ).toContain("Storage protection not confirmed");
    expect(label(await alertsFor(null))).toContain("Storage protection not confirmed");
  });
});
