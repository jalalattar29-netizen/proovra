/**
 * PROOVRA Phase 3 — Real canonical-materials wiring (not source pin).
 *
 * The previous Phase 2 closure source-pin only proved that report-v2
 * imports shared helpers. Phase 3 actually invokes the canonical
 * materials builder inside both the report builder and the
 * verification-package builder, and pipes the resulting bundle out:
 *   - Report v2 view model now carries `canonicalMaterials` sealed at
 *     report generation time (snapshotSemantics = report-snapshot-only).
 *   - Verification Package emits `canonical-record.json` containing the
 *     full canonical bundle (snapshotSemantics =
 *     package-snapshot-only).
 *
 * This test calls `buildReportCanonicalMaterials` directly and
 * verifies the returned bundle has all expected sections + the
 * correct snapshot semantics. It also pins the worker source so the
 * wiring cannot silently regress.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildReportCanonicalMaterials } from "../src/report-v2/truth-model.js";
import { buildEvidenceTrustDecision } from "@proovra/shared";

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

function minimalReportEvidence() {
  return {
    id: "ev_phase3_canonical_1",
    type: "DOCUMENT" as const,
    status: "REPORTED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    captureMethod: "UPLOADED_FILE",
    uploadedAtUtc: "2026-01-01T00:00:00.000Z",
    signedAtUtc: "2026-01-01T00:00:01.000Z",
    recordedIntegrityVerifiedAtUtc: "2026-01-01T00:01:00.000Z",
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    fingerprintCanonicalJson: "{}",
    signatureBase64: "sigbase64",
    signingKeyId: "key-1",
    signingKeyVersion: 1,
    publicKeyPem: null,
    tsaStatus: "STAMPED",
    tsaFailureReason: null,
    tsaSerialNumber: "TSA-1",
    tsaGenTimeUtc: "2026-01-01T00:00:02.000Z",
    storageImmutable: true,
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: "2030-01-01T00:00:00.000Z",
    otsStatus: "ANCHORED",
    otsHash: "c".repeat(64),
    otsBitcoinTxid: "d".repeat(64),
    otsAnchoredAtUtc: "2026-01-02T00:00:00.000Z",
    otsCalendar: null,
    otsFailureReason: null,
    identityLevelSnapshot: "ORGANIZATION_ACCOUNT",
    submittedByEmail: null,
    submittedByAuthProvider: null,
    verificationPackageVersion: 1,
    verificationPackageGeneratedAtUtc: "2026-01-02T00:00:00.000Z",
    anchor: null,
    workspaceNameSnapshot: "Workspace",
    organizationNameSnapshot: "Org",
    organizationVerifiedSnapshot: false,
  } as unknown as Parameters<typeof buildReportCanonicalMaterials>[0]["evidence"];
}

function trustInputFor(ev: ReturnType<typeof minimalReportEvidence>) {
  return buildEvidenceTrustDecision({
    evidence: {
      verificationStatus: ev.verificationStatus,
      recordedIntegrityVerifiedAtUtc: ev.recordedIntegrityVerifiedAtUtc,
      fileSha256: ev.fileSha256,
      fingerprintHash: ev.fingerprintHash,
      signatureBase64: ev.signatureBase64,
      signingKeyId: ev.signingKeyId,
      publicKeyPem: ev.publicKeyPem,
      tsaStatus: ev.tsaStatus,
      tsaFailureReason: ev.tsaFailureReason,
      otsStatus: ev.otsStatus,
      otsHash: ev.otsHash,
      otsBitcoinTxid: ev.otsBitcoinTxid,
      otsAnchoredAtUtc: ev.otsAnchoredAtUtc,
      otsCalendar: ev.otsCalendar,
      otsFailureReason: ev.otsFailureReason,
      storageImmutable: ev.storageImmutable,
      storageObjectLockMode: ev.storageObjectLockMode,
      storageObjectLockRetainUntilUtc: ev.storageObjectLockRetainUntilUtc,
      identityLevelSnapshot: ev.identityLevelSnapshot,
      submittedByEmail: ev.submittedByEmail,
      submittedByAuthProvider: ev.submittedByAuthProvider,
      verificationPackageVersion: ev.verificationPackageVersion,
      verificationPackageGeneratedAtUtc:
        ev.verificationPackageGeneratedAtUtc,
      anchor: ev.anchor,
      fingerprintCanonicalJson: ev.fingerprintCanonicalJson,
    } as Parameters<typeof buildEvidenceTrustDecision>[0]["evidence"],
    custodyEvents: [],
  });
}

describe("Phase 3 — buildReportCanonicalMaterials returns a sealed bundle", () => {
  it("REPORT_SNAPSHOT outputType seals every material as report-snapshot-only", () => {
    const ev = minimalReportEvidence();
    const td = trustInputFor(ev);
    const bundle = buildReportCanonicalMaterials({
      evidence: ev,
      custodyEvents: [],
      trustDecision: td,
      snapshotGeneratedAtUtc: "2026-01-02T00:00:00.000Z",
    });
    expect(bundle.evidenceRecord.snapshotSemantics).toBe("report-snapshot-only");
    expect(bundle.fingerprint.snapshotSemantics).toBe("report-snapshot-only");
    expect(bundle.otsState.snapshotSemantics).toBe("report-snapshot-only");
    expect(bundle.legalBoundary.reportBoundary).toMatch(/PROOVRA/);
    expect(bundle.trustDecision.decision).toBe(td);
  });

  it("VERIFICATION_PACKAGE_SNAPSHOT outputType seals every material as package-snapshot-only", () => {
    const ev = minimalReportEvidence();
    const td = trustInputFor(ev);
    const bundle = buildReportCanonicalMaterials({
      evidence: ev,
      custodyEvents: [],
      trustDecision: td,
      outputType: "VERIFICATION_PACKAGE_SNAPSHOT",
    });
    expect(bundle.evidenceRecord.snapshotSemantics).toBe("package-snapshot-only");
    expect(bundle.fingerprint.snapshotSemantics).toBe("package-snapshot-only");
    expect(bundle.otsState.snapshotSemantics).toBe("package-snapshot-only");
    expect(bundle.legalBoundary.packageBoundary).toMatch(/PROOVRA/);
  });
});

describe("Phase 3 — Report v2 view-model exposes canonicalMaterials", () => {
  const viewModelSrc = readSrc("../src/report-v2/build-view-model.ts");
  const typesSrc = readSrc("../src/report-v2/types.ts");
  const truthModelSrc = readSrc("../src/report-v2/truth-model.ts");

  it("ReportViewModel type declares canonicalMaterials", () => {
    expect(typesSrc).toMatch(/canonicalMaterials:\s*import\("@proovra\/shared"\)\.CanonicalEvidenceMaterials/);
  });

  it("build-view-model.ts invokes buildReportCanonicalMaterials right after buildTrustDecision", () => {
    const order =
      viewModelSrc.indexOf("buildTrustDecision({") <
      viewModelSrc.indexOf("buildReportCanonicalMaterials({");
    expect(viewModelSrc).toContain("buildReportCanonicalMaterials({");
    expect(order).toBe(true);
  });

  it("build-view-model.ts returns canonicalMaterials inside the view-model object", () => {
    // The token "canonicalMaterials" appears as a shorthand property in
    // the returned view-model literal.
    expect(viewModelSrc).toMatch(/canonicalMaterials/);
  });

  it("truth-model.ts exports buildReportCanonicalMaterials and accepts outputType", () => {
    expect(truthModelSrc).toContain("export function buildReportCanonicalMaterials(");
    expect(truthModelSrc).toMatch(/outputType\?:\s*\n?\s*\|\s*"REPORT_SNAPSHOT"/);
  });
});

describe("Phase 3 — Verification Package emits canonical-record.json", () => {
  const packageSrc = readSrc("../src/verification-package.ts");
  const processorSrc = readSrc("../src/processor.ts");

  it("createVerificationPackage signature accepts canonicalMaterials", () => {
    expect(packageSrc).toContain(
      "canonicalMaterials?: CanonicalEvidenceMaterials | null;",
    );
  });

  it("emits canonical-record.json into the ZIP when canonicalMaterials is provided", () => {
    expect(packageSrc).toContain('"canonical-record.json"');
    expect(packageSrc).toContain('"proovra.canonical-record/v1"');
    expect(packageSrc).toContain('outputType: "VERIFICATION_PACKAGE_SNAPSHOT"');
  });

  it("the canonical-record entry sources legal boundary from the canonical bundle (no duplicate copy)", () => {
    expect(packageSrc).toContain(
      "data.canonicalMaterials.legalBoundary.packageBoundary",
    );
  });

  it("processor builds the package-snapshot bundle and threads it through to createVerificationPackage", () => {
    expect(processorSrc).toContain("packageCanonicalMaterials =");
    expect(processorSrc).toContain(
      'outputType: "VERIFICATION_PACKAGE_SNAPSHOT"',
    );
    expect(processorSrc).toContain(
      "canonicalMaterials: packageCanonicalMaterials,",
    );
  });
});
