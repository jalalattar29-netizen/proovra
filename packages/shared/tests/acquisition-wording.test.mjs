/**
 * PHASE 9 — capture-source wording. One mapping for report, package, Public
 * Verify, web and native; every mode states separately what PROOVRA observed,
 * what was attested, and what preceded PROOVRA's visibility, and no mode (or
 * an unknown value) reads as a capture PROOVRA performed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_ACQUISITION_MODES,
  evidenceLocationSourceLabel,
  resolveEvidenceAcquisition,
} from "../dist/index.js";

const ALL = [...EVIDENCE_ACQUISITION_MODES, "LEGACY_NOT_RECORDED"];
const OVERCLAIM = /secure capture|captured by proovra|proovra captured|proovra (?:observed|witnessed) the (?:creation|capture)|tamper-?proof|guarantee/i;

test("every mode states mechanism, observation, attestation and pre-visibility separately", () => {
  for (const mode of ALL) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode === "LEGACY_NOT_RECORDED" ? null : mode });
    for (const field of ["label", "statement", "observedByProovra", "attested", "beforeProovraVisibility"]) {
      assert.equal(typeof a[field], "string", `${mode}.${field}`);
      assert.ok(a[field].trim().length > 3, `${mode}.${field}`);
      assert.doesNotMatch(a[field], OVERCLAIM, `${mode}.${field}`);
    }
    assert.ok(a.limitations.length > 0, `${mode} limitations`);
  }
});

test("PROOVRA Web Upload says exactly what PROOVRA did and did not observe", () => {
  const a = resolveEvidenceAcquisition({ acquisitionMode: "PROOVRA_WEB_UPLOAD" });
  assert.equal(
    a.statement,
    "Files submitted through PROOVRA Web Upload. PROOVRA did not observe creation or editing before submission.",
  );
  assert.equal(a.isDirectCapture, false);
  assert.equal(a.provenanceTier, "IMPORTED_EXISTING_MEDIA");
  assert.match(a.beforeProovraVisibility, /editing before submission/);
});

test("only the direct-capture channels are direct captures, and they are client-attested", () => {
  for (const mode of EVIDENCE_ACQUISITION_MODES) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: mode });
    if (a.isDirectCapture) {
      assert.equal(a.provenanceTier, "CLIENT_ATTESTED_CAPTURE", mode);
      assert.ok(a.limitations.includes("CAPTURE_CLIENT_ATTESTED"), mode);
      assert.match(a.attested, /reported|recorded/i, mode);
    } else {
      assert.ok(a.limitations.includes("CREATION_NOT_OBSERVED_BY_PROOVRA") || mode === "LEGACY_NOT_RECORDED", mode);
    }
  }
});

test("a new or malformed mode can never fall back to a stronger claim", () => {
  for (const value of ["PROOVRA_SECURE_CAMERA", "DIRECT_WEB_CAPTURE", "", null, undefined, 42]) {
    const a = resolveEvidenceAcquisition({ acquisitionMode: value });
    assert.equal(a.mode, "LEGACY_NOT_RECORDED", String(value));
    assert.equal(a.recorded, false);
    assert.equal(a.isDirectCapture, false);
  }
});

test("browser-reported coordinates are never labelled a secure capture", () => {
  for (const source of ["CAPTURE_BROWSER_GEOLOCATION", null, "UNKNOWN"]) {
    assert.doesNotMatch(evidenceLocationSourceLabel(source), /secure capture/i);
  }
});
