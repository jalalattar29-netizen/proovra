/**
 * PROOVRA Phase 2 — Canonical Evidence Materials tests.
 *
 * Pin the canonical materials contract: every section is produced,
 * the trust decision is delegated to buildEvidenceTrustDecision (no
 * duplicate verdict logic), reviewer evidence type is delegated to
 * getReviewerEvidenceTypeLabel (no duplicate category logic), the
 * workspace scope correctly distinguishes personal-Team workspaces
 * from team-account workspaces, OTS honesty-rule downgrades a fake
 * ANCHORED status without txid/anchored-at, and snapshot vs live
 * semantics are encoded per-material.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  CANONICAL_SNAPSHOT_LIVE_SEMANTICS,
  CANONICAL_WORKSPACE_SCOPES,
  CANONICAL_OUTPUT_TYPES,
  deriveCanonicalWorkspaceScope,
  describeCanonicalWorkspaceScope,
  buildCanonicalEvidenceMaterials,
  buildCanonicalEvidenceMaterialsWithTrustInput,
  buildCanonicalLegalBoundaryMaterial,
  deriveCanonicalMaterialAvailability,
  deriveCanonicalOutputContext,
  buildEvidenceTrustDecision,
} from "../dist/index.js";

/** Minimal trust-decision input that exercises the real shared builder. */
function trustInputFor(evidence) {
  return {
    evidence: {
      fileSha256: evidence.fileSha256,
      fingerprintHash: evidence.fingerprintHash,
      signatureBase64: evidence.signatureBase64,
      signingKeyId: evidence.signingKeyId,
      tsaStatus: evidence.tsaStatus,
      otsStatus: evidence.otsStatus,
      otsBitcoinTxid: evidence.otsBitcoinTxid,
      otsAnchoredAtUtc: evidence.otsAnchoredAtUtc,
      otsHash: evidence.otsHash,
      storageImmutable: evidence.storageObjectLockMode === "COMPLIANCE",
      storageObjectLockMode: evidence.storageObjectLockMode,
      storageObjectLockRetainUntilUtc:
        evidence.storageObjectLockRetainUntilUtc,
      verificationStatus: evidence.verificationStatus,
      recordedIntegrityVerifiedAtUtc:
        evidence.recordedIntegrityVerifiedAtUtc,
      verificationPackageVersion: 1,
      identityLevelSnapshot: evidence.identityLevelSnapshot,
      tsaFailureReason: null,
      fingerprintCanonicalJson: evidence.fingerprintCanonicalJsonPresent
        ? "{}"
        : null,
    },
    custodyEvents: [],
  };
}

function fullEvidenceInput() {
  return {
    id: "ev_canon_1",
    status: "REPORTED",
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    captureMethod: "UPLOADED_FILE",
    uploadedAtUtc: "2026-01-01T00:00:00.000Z",
    signedAtUtc: "2026-01-01T00:00:01.000Z",
    recordedIntegrityVerifiedAtUtc: "2026-01-01T00:01:00.000Z",
    fileSha256: "a".repeat(64),
    fingerprintHash: "b".repeat(64),
    fingerprintCanonicalJsonPresent: true,
    hashSemantics: "single_file",
    multipartManifestSha256: null,
    signatureBase64: "sigbase64",
    signingKeyId: "key-1",
    signingKeyVersion: 1,
    tsaStatus: "STAMPED",
    tsaTokenBase64Present: true,
    tsaSerialNumber: "TSA-1",
    tsaGenTimeUtc: "2026-01-01T00:00:02.000Z",
    tsaInputDigestHex: "c".repeat(64),
    tsaInputKind: "FILE_SHA256",
    storageObjectLockMode: "COMPLIANCE",
    storageObjectLockRetainUntilUtc: "2030-01-01T00:00:00.000Z",
    storageObjectLockLegalHoldStatus: "OFF",
    otsStatus: "ANCHORED",
    otsHash: "d".repeat(64),
    otsBitcoinTxid: "e".repeat(64),
    otsAnchoredAtUtc: "2026-01-02T00:00:00.000Z",
    otsUpgradedAtUtc: "2026-01-02T00:00:01.000Z",
    otsProofPresent: true,
    identityLevelSnapshot: "ORGANIZATION_ACCOUNT",
    workspaceNameSnapshot: "Workspace Snapshot Name",
    organizationNameSnapshot: "Org Inc.",
    organizationVerifiedSnapshot: false,
    teamId: "team_personal_1",
  };
}

test("CANONICAL_SNAPSHOT_LIVE_SEMANTICS values are stable and named", () => {
  assert.deepEqual(
    [...CANONICAL_SNAPSHOT_LIVE_SEMANTICS].sort(),
    [
      "internal-metric-only",
      "live",
      "live-append-only",
      "live-updating-after-snapshot",
      "package-snapshot-only",
      "report-snapshot-only",
    ],
  );
});

test("CANONICAL_WORKSPACE_SCOPES has exactly the three Phase 2 values", () => {
  assert.deepEqual(
    [...CANONICAL_WORKSPACE_SCOPES].sort(),
    [
      "ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED",
      "PERSONAL_ACCOUNT_WORKSPACE",
      "TEAM_ACCOUNT_WORKSPACE",
    ],
  );
});

test("deriveCanonicalWorkspaceScope: teamId existence does NOT imply TEAM_ACCOUNT_WORKSPACE", () => {
  // The Phase 0 audit revealed this exact bug: every record has a
  // teamId because personal workspaces are stored as Team rows.
  // Phase 2 invariant: only isPersonalTeam===false should resolve
  // to TEAM_ACCOUNT_WORKSPACE.
  assert.equal(
    deriveCanonicalWorkspaceScope({ teamId: "t1", isPersonalTeam: true }),
    "PERSONAL_ACCOUNT_WORKSPACE",
  );
  assert.equal(
    deriveCanonicalWorkspaceScope({ teamId: "t1", isPersonalTeam: false }),
    "TEAM_ACCOUNT_WORKSPACE",
  );
  assert.equal(
    deriveCanonicalWorkspaceScope({ teamId: "t1", isPersonalTeam: null }),
    "PERSONAL_ACCOUNT_WORKSPACE",
    "unknown isPersonal must default to PERSONAL (safer wording)",
  );
  assert.equal(
    deriveCanonicalWorkspaceScope({ teamId: null, isPersonalTeam: null }),
    "PERSONAL_ACCOUNT_WORKSPACE",
  );
  assert.equal(
    deriveCanonicalWorkspaceScope({
      teamId: "t1",
      isPersonalTeam: false,
      organizationId: "org-1",
    }),
    "ORGANIZATION_WORKSPACE_RESERVED_OR_DISABLED",
  );
});

test("describeCanonicalWorkspaceScope returns a human-safe meaning", () => {
  for (const scope of CANONICAL_WORKSPACE_SCOPES) {
    const msg = describeCanonicalWorkspaceScope(scope);
    assert.ok(typeof msg === "string" && msg.length > 16, `bad describe for ${scope}`);
  }
});

test("buildCanonicalEvidenceMaterials returns all required sections", () => {
  const evidence = fullEvidenceInput();
  const td = buildEvidenceTrustDecision(trustInputFor(evidence));
  const m = buildCanonicalEvidenceMaterials({
    evidence,
    team: {
      id: "team_personal_1",
      name: "Jalal's Personal Workspace",
      evidenceWorkspaceLabel: "Personal Workspace",
      isPersonal: true,
    },
    parts: [
      { partIndex: 0, sha256: "f".repeat(64), sizeBytes: 12345, mimeType: "video/mp4" },
      { partIndex: 1, sha256: "0".repeat(64), sizeBytes: 9999, mimeType: "image/jpeg" },
    ],
    custodyEvents: [
      { eventType: "EVIDENCE_CREATED", atUtc: "2026-01-01T00:00:00.000Z" },
      { eventType: "VERIFY_VIEWED", atUtc: "2026-01-03T00:00:00.000Z" },
      { eventType: "SIGNATURE_APPLIED", atUtc: "2026-01-01T00:00:01.000Z" },
    ],
    trustDecision: td,
    mediaIntelligence: { observationCount: 5, advisory: null },
    outputType: "VERIFICATION_PACKAGE_SNAPSHOT",
    snapshotGeneratedAtUtc: "2026-01-02T00:00:00.000Z",
  });

  // Every section is present.
  for (const k of [
    "evidenceRecord",
    "fingerprint",
    "partIndex",
    "custodySnapshot",
    "identitySnapshot",
    "timestampState",
    "storageState",
    "otsState",
    "mediaIntelligenceSnapshot",
    "trustDecision",
    "legalBoundary",
    "issues",
  ]) {
    assert.ok(k in m, `bundle missing section ${k}`);
  }

  // Reviewer evidence type uses the shared helper — multipart image+video → "Mixed Media Evidence Package".
  assert.equal(m.evidenceRecord.reviewerEvidenceTypeLabel, "Mixed Media Evidence Package");

  // Trust decision delegated; verdict comes from the shared function, not duplicated here.
  assert.equal(m.trustDecision.decision, td);

  // Workspace scope: personal Team row → PERSONAL_ACCOUNT_WORKSPACE (NOT team_governed).
  assert.equal(m.identitySnapshot.workspaceScope, "PERSONAL_ACCOUNT_WORKSPACE");
  assert.equal(m.identitySnapshot.workspaceLabelAtPackageTime, "Personal Workspace");

  // Custody counts split forensic vs access.
  assert.equal(m.custodySnapshot.forensicEventCount, 2);
  assert.equal(m.custodySnapshot.accessEventCount, 1);

  // Snapshot semantics for a snapshot output are package-snapshot-only.
  assert.equal(m.evidenceRecord.snapshotSemantics, "package-snapshot-only");
  assert.equal(m.fingerprint.snapshotSemantics, "package-snapshot-only");
  assert.equal(m.otsState.snapshotSemantics, "package-snapshot-only");

  // Part index reflects the inputs.
  assert.equal(m.partIndex.itemCount, 2);
  assert.equal(m.partIndex.structure, "multipart");
});

test("snapshot vs live semantics: live output uses append-only / live-updating tags", () => {
  const evidence = fullEvidenceInput();
  const td = buildEvidenceTrustDecision(trustInputFor(evidence));
  const m = buildCanonicalEvidenceMaterials({
    evidence,
    team: { id: "t1", name: "n", isPersonal: false },
    parts: [{ partIndex: 0, sha256: null, sizeBytes: null, mimeType: null }],
    custodyEvents: [],
    trustDecision: td,
    outputType: "PUBLIC_VERIFY_LIVE",
  });
  assert.equal(m.evidenceRecord.snapshotSemantics, "live");
  assert.equal(m.custodySnapshot.snapshotSemantics, "live-append-only");
  assert.equal(m.otsState.snapshotSemantics, "live-updating-after-snapshot");
  // Workspace scope for a real team-account row.
  assert.equal(m.identitySnapshot.workspaceScope, "TEAM_ACCOUNT_WORKSPACE");
});

test("OTS honesty rule: ANCHORED without txid AND without anchoredAtUtc downgrades to PENDING", () => {
  const evidence = fullEvidenceInput();
  evidence.otsBitcoinTxid = null;
  evidence.otsAnchoredAtUtc = null;
  const td = buildEvidenceTrustDecision(trustInputFor(evidence));
  const m = buildCanonicalEvidenceMaterials({
    evidence,
    team: null,
    parts: [],
    custodyEvents: [],
    trustDecision: td,
    outputType: "REPORT_SNAPSHOT",
  });
  assert.equal(m.otsState.otsStatus, "ANCHORED");
  assert.equal(m.otsState.effectiveStatus, "PENDING");
  // The downgrade emits a canonical info-level issue.
  assert.ok(
    m.issues.some((i) => i.code === "OTS_STATUS_DOWNGRADED_PENDING"),
    "missing OTS downgrade issue",
  );
});

test("legal boundary material is shared across outputs (no duplicate copy)", () => {
  const b = buildCanonicalLegalBoundaryMaterial();
  assert.equal(b.reportBoundary, b.packageBoundary);
  assert.equal(b.reportBoundary, b.publicVerifyBoundary);
  assert.ok(b.offlinePackageReviewBoundary.startsWith(b.reportBoundary));
});

test("deriveCanonicalOutputContext encodes snapshot vs live correctly", () => {
  const evidence = fullEvidenceInput();
  const td = buildEvidenceTrustDecision(trustInputFor(evidence));
  const m = buildCanonicalEvidenceMaterials({
    evidence,
    team: null,
    parts: [],
    custodyEvents: [],
    trustDecision: td,
    outputType: "PUBLIC_VERIFY_LIVE",
  });

  const live = deriveCanonicalOutputContext(m, "PUBLIC_VERIFY_LIVE", {
    snapshotGeneratedAtUtc: "2026-01-02T00:00:00.000Z",
    liveObservedAtUtc: "2026-02-01T00:00:00.000Z",
  });
  assert.equal(live.isSnapshotOutput, false);
  assert.equal(live.isLiveOutput, true);
  assert.equal(live.snapshotGeneratedAtUtc, "2026-01-02T00:00:00.000Z");
  assert.equal(live.liveObservedAtUtc, "2026-02-01T00:00:00.000Z");
  assert.ok(live.liveDeltaMaterials.includes("custodyChain"));
  assert.ok(live.liveDeltaMaterials.includes("otsAnchoring"));

  const snap = deriveCanonicalOutputContext(m, "REPORT_SNAPSHOT", {
    snapshotGeneratedAtUtc: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(snap.isSnapshotOutput, true);
  assert.equal(snap.isLiveOutput, false);
  assert.equal(snap.liveObservedAtUtc, null);
  assert.deepEqual(snap.liveDeltaMaterials, []);
});

test("deriveCanonicalMaterialAvailability reflects presence honestly", () => {
  const evidence = fullEvidenceInput();
  evidence.fileSha256 = null;
  evidence.signatureBase64 = null;
  const td = buildEvidenceTrustDecision(trustInputFor(evidence));
  const m = buildCanonicalEvidenceMaterials({
    evidence,
    team: null,
    parts: [],
    custodyEvents: [],
    trustDecision: td,
    outputType: "PUBLIC_VERIFY_LIVE",
  });
  const a = deriveCanonicalMaterialAvailability(m);
  assert.equal(a.evidenceRecord, true);
  assert.equal(a.fingerprint, false);
  assert.equal(a.partIndex, false);
  assert.equal(a.legalBoundary, true);
});

test("buildCanonicalEvidenceMaterialsWithTrustInput invokes shared verdict builder", () => {
  const evidence = fullEvidenceInput();
  const m = buildCanonicalEvidenceMaterialsWithTrustInput({
    evidence,
    team: null,
    parts: [],
    custodyEvents: [],
    mediaIntelligence: null,
    outputType: "REPORT_SNAPSHOT",
    trustDecisionInput: trustInputFor(evidence),
  });
  assert.ok(m.trustDecision.decision);
});

test("output types are exhaustive and stable", () => {
  assert.deepEqual([...CANONICAL_OUTPUT_TYPES].sort(), [
    "INTERNAL_OPERATIONAL_PROJECTION",
    "OFFLINE_PACKAGE_REVIEW",
    "PUBLIC_VERIFY_LIVE",
    "REPORT_SNAPSHOT",
    "VERIFICATION_PACKAGE_SNAPSHOT",
  ]);
});
