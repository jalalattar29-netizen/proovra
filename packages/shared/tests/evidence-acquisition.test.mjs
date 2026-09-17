import test from "node:test";
import assert from "node:assert/strict";

// UC-0 — the acquisition authority and the attestation reader gate.
//
// Coverage:
//   - resolveEvidenceAcquisition: every persisted mode, legacy null, and
//     unknown / forged stored values (never guessed)
//   - no statement or label overclaims (claims-matrix forbidden patterns)
//   - category ↔ mode mapping used by the library filter
//   - timestamp label chosen from the authority
//   - projectRecordedAttestationVerdict: no positive verdict survives without
//     a cryptographic verifier version
//   - search projection: contributorScoped + derived-text marking come from
//     the authority, never from captureMethod

import {
  ACQUISITION_NOT_RECORDED,
  CRYPTOGRAPHIC_ATTESTATION_VERIFIER_VERSIONS,
  EVIDENCE_ACQUISITION_MODES,
  acquisitionModesForCategory,
  acquisitionTimestampLabel,
  buildEvidenceProjection,
  derivedAssetTransformationForKind,
  normalizePartArtifactClass,
  projectRecordedAttestationVerdict,
  resolveEvidenceAcquisition,
} from "../dist/index.js";
import { PROOVRA_FORBIDDEN_SURFACE_PATTERNS } from "../../shared-evidence-presentation/dist/index.js";

test("every persisted mode resolves to itself, recorded at creation by default", () => {
  for (const mode of EVIDENCE_ACQUISITION_MODES) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode });
    assert.equal(a.mode, mode);
    assert.equal(a.recorded, true);
    assert.equal(a.recordedBy, "RECORDED_AT_CREATION");
    assert.ok(a.statement.length > 0);
    if (mode === "DIRECT_WEB_CAPTURE_EXTENSION") {
      // UC-1 — the FIRST direct-capture mode. PROOVRA's own adapter produced
      // the bytes, so CREATION_NOT_OBSERVED does not apply; its own web-capture
      // limitations do.
      assert.equal(a.isDirectCapture, true, `${mode} is a direct capture`);
      assert.ok(a.limitations.includes("WEB_CONTENT_TRUTH_NOT_PROVEN"));
      assert.ok(a.limitations.includes("WEB_SERVER_ORIGIN_NOT_PROVEN"));
    } else if (mode === "DIRECT_SCREEN_CAPTURE_ANDROID") {
      // UC-2 — the SECOND direct-capture mode. PROOVRA's own Android adapter
      // produced the frame bytes; its own screen-capture limitations apply.
      assert.equal(a.isDirectCapture, true, `${mode} is a direct capture`);
      assert.ok(a.limitations.includes("SCREEN_CONTENT_TRUTH_NOT_PROVEN"));
      assert.ok(a.limitations.includes("SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED"));
    } else if (mode === "DIRECT_SCREEN_CAPTURE_ANDROID_CONTINUOUS") {
      // UC-3 — the THIRD direct-capture mode. PROOVRA's own Android adapter
      // produced the segment bytes of a continuous session; its screen-capture
      // limitations apply, plus the session-continuity caveat.
      assert.equal(a.isDirectCapture, true, `${mode} is a direct capture`);
      assert.ok(a.limitations.includes("SCREEN_CONTENT_TRUTH_NOT_PROVEN"));
      assert.ok(a.limitations.includes("SCREEN_DEVICE_INTEGRITY_NOT_VERIFIED"));
      assert.ok(a.limitations.includes("SCREEN_SESSION_CONTINUITY_LIMITED"));
    } else {
      assert.equal(a.isDirectCapture, false, `${mode} is not a direct capture in UC-0`);
      assert.ok(a.limitations.includes("CREATION_NOT_OBSERVED_BY_PROOVRA"));
    }
  }
});

test("UC-1 direct web capture resolves to a direct-capture projection", () => {
  const a = resolveEvidenceAcquisition({ acquisitionMode: "DIRECT_WEB_CAPTURE_EXTENSION" });
  assert.equal(a.mode, "DIRECT_WEB_CAPTURE_EXTENSION");
  assert.equal(a.category, "DIRECT_WEB_CAPTURE");
  assert.equal(a.isDirectCapture, true);
  assert.equal(a.label, "Captured from the web with PROOVRA");
  assert.equal(acquisitionTimestampLabel("DIRECT_WEB_CAPTURE_EXTENSION", false), "Captured from the web at (server UTC)");
});

test("a backfilled value says so", () => {
  const a = resolveEvidenceAcquisition({
    acquisitionMode: "SECURE_INTAKE_LINK",
    acquisitionModeSource: "BACKFILL_INTAKE_SESSION_LINK",
  });
  assert.equal(a.recordedBy, "BACKFILL_INTAKE_SESSION_LINK");
});

test("legacy null, unknown and legacy-vocabulary values are NOT RECORDED — never guessed", () => {
  for (const stored of [
    null,
    undefined,
    "",
    "WEB_APP",
    "MOBILE_APP",
    "UPLOADED_FILE",
    "EXTERNAL_INTAKE_UPLOAD",
    "OPERATOR_NATIVE",
    "CITIZEN_PWA",
    "DIRECT_SCREEN_CAPTURE",
    "LEGACY_NOT_RECORDED",
  ]) {
    const a = resolveEvidenceAcquisition({
      acquisitionMode: stored,
      acquisitionModeSource: "RECORDED_AT_CREATION",
    });
    assert.equal(a.mode, ACQUISITION_NOT_RECORDED, String(stored));
    assert.equal(a.recorded, false);
    assert.equal(a.recordedBy, null);
    assert.equal(a.label, "Not recorded");
    assert.equal(a.category, "NOT_RECORDED");
    assert.deepEqual([...a.limitations], ["ACQUISITION_NOT_RECORDED"]);
  }
});

test("no acquisition label or statement overclaims", () => {
  for (const mode of [...EVIDENCE_ACQUISITION_MODES, null]) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode });
    for (const text of [a.label, a.statement]) {
      for (const re of PROOVRA_FORBIDDEN_SURFACE_PATTERNS) {
        assert.equal(re.test(text), false, `${text} matched ${re}`);
      }
      assert.doesNotMatch(text, /\b(verified|authentic|genuine|court-ready|captured at source)\b/i);
    }
  }
});

test("filter categories partition the projected modes", () => {
  const all = [
    "UPLOAD",
    "SECURE_INTAKE",
    "MOBILE_APP",
    "DIRECT_WEB_CAPTURE",
    "DIRECT_SCREEN_CAPTURE",
    "NOT_RECORDED",
  ].flatMap((c) => [...acquisitionModesForCategory(c)]);
  assert.deepEqual(
    [...all].sort(),
    [...EVIDENCE_ACQUISITION_MODES, ACQUISITION_NOT_RECORDED].sort(),
  );
  assert.deepEqual([...acquisitionModesForCategory("NOT_RECORDED")], [ACQUISITION_NOT_RECORDED]);
});

test("timestamp labels come from the authority", () => {
  assert.equal(acquisitionTimestampLabel("SECURE_INTAKE_LINK", false), "Intake submitted at (server UTC)");
  assert.equal(acquisitionTimestampLabel("LEGACY_NOT_RECORDED", true), "Intake submitted at (server UTC)");
  assert.equal(
    acquisitionTimestampLabel("PROOVRA_MOBILE_APP", false),
    "Recorded at mobile app submission (server UTC)",
  );
  assert.equal(acquisitionTimestampLabel("PROOVRA_WEB_UPLOAD", false), "Recorded at submission (server UTC)");
});

test("artifact class and derivative transformation vocabulary", () => {
  assert.equal(normalizePartArtifactClass("CAPTURE_MANIFEST"), "CAPTURE_MANIFEST");
  assert.equal(normalizePartArtifactClass(null), "ORIGINAL");
  assert.equal(normalizePartArtifactClass("DERIVED"), "ORIGINAL", "a part can never be derived");
  assert.equal(derivedAssetTransformationForKind("image_thumbnail"), "image-thumbnail/v1");
  assert.equal(derivedAssetTransformationForKind("something_new"), "unspecified-legacy");
});

test("no attestation verdict is positive without a cryptographic verifier", () => {
  assert.deepEqual([...CRYPTOGRAPHIC_ATTESTATION_VERIFIER_VERSIONS], []);
  for (const verdict of ["VERIFIED_STRONG", "VERIFIED_BASIC", "TEE_ONLY"]) {
    for (const verifierVersion of [null, undefined, "", "FAIL_CLOSED_NO_CRYPTOGRAPHIC_VERIFIER_V1", "anything"]) {
      assert.equal(projectRecordedAttestationVerdict({ verdict, verifierVersion }), "UNVERIFIED");
    }
  }
  for (const verdict of ["FAILED", "REVOKED", "NOT_ATTEMPTED", "UNVERIFIED"]) {
    assert.equal(projectRecordedAttestationVerdict({ verdict, verifierVersion: null }), verdict);
  }
  assert.equal(projectRecordedAttestationVerdict({ verdict: "SUPER_VERIFIED", verifierVersion: null }), "UNVERIFIED");
});

function projectionFor(evidence, extractedTextChunks) {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    teamId: "00000000-0000-4000-8000-0000000000aa",
    title: "t",
    displayFileName: "f.jpg",
    originalFileName: "f.jpg",
    type: "PHOTO",
    mimeType: "image/jpeg",
    captureMethod: "MULTIPART_PACKAGE",
    caseId: null,
    deletedAt: null,
    lifecycleState: "ACTIVE",
    archivedAt: null,
    publicVerifyState: null,
    storageObjectLockLegalHoldStatus: null,
    retentionPolicySource: null,
    retentionUntilUtc: null,
    reviewReadyAtUtc: null,
    updatedAt: new Date(),
    ...evidence,
  };
  const r = buildEvidenceProjection({
    teamId: base.teamId,
    evidenceId: base.id,
    evidence: base,
    workflowState: null,
    extractedTextChunks,
  });
  assert.equal(r.ok, true);
  return r.projection;
}

test("search: contributorScoped and acquisition come from the authority, not captureMethod", () => {
  const intake = projectionFor({ acquisitionMode: "SECURE_INTAKE_LINK" });
  assert.equal(intake.contributorScoped, true);
  assert.equal(intake.searchableMetadata.acquisitionMode, "SECURE_INTAKE_LINK");
  const oldMarker = projectionFor({ captureMethod: "EXTERNAL_INTAKE_UPLOAD", acquisitionMode: null });
  assert.equal(oldMarker.contributorScoped, false);
  assert.equal(oldMarker.searchableMetadata.acquisitionMode, "LEGACY_NOT_RECORDED");
});

test("search: machine-extracted text is marked derived", () => {
  const withText = projectionFor({ acquisitionMode: "PROOVRA_WEB_UPLOAD" }, ["[OCR] hello"]);
  assert.equal(withText.searchableMetadata.textProvenance, "DERIVED_MACHINE_EXTRACTED");
  assert.ok(withText.searchableTags.includes("derived_text"));
  const without = projectionFor({ acquisitionMode: "PROOVRA_WEB_UPLOAD" }, []);
  assert.equal(without.searchableMetadata.textProvenance ?? null, null);
  assert.equal(without.searchableTags.includes("derived_text"), false);
});
