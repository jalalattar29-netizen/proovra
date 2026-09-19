/**
 * GUARD — native evidence-detail projection (Master Program §5/B, M2). Binds the
 * REAL review-workspace shape (custody events, TSA/OTS, signature, relationships,
 * provenance) + technical-metadata + certifications — NOT the non-existent fields
 * the screen used to read (rw.parts / rw.integrity). Pure; nothing fabricated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(HERE, "../src/product/evidence-detail.ts"), "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);

// Mirrors apps/web/.../review-workspace-types.ts (the authoritative shape).
const rw = {
  custodyLifecycle: {
    forensicEvents: [
      { sequence: 1, atUtc: "2026-09-19T10:00:00Z", eventType: "EVIDENCE_SEALED", payloadSummary: "Sealed", category: "forensic" },
      { eventType: "" }, // dropped
    ],
    accessEvents: [{ sequence: 5, atUtc: "2026-09-19T11:00:00Z", eventType: "REPORT_DOWNLOADED", payloadSummary: "Downloaded", category: "access" }],
  },
  preservationMatrix: {
    verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
    verificationStatusLabel: "Integrity verified",
    signature: { recorded: true, valid: true, keyId: "k1" },
    tsa: { status: "GRANTED", provider: "FreeTSA", genTimeUtc: "2026-09-19T10:01:00Z", failureReason: null },
    ots: { status: "PENDING", effectiveStatus: "ANCHORED", proofPresent: true, hashMatches: true, anchoredAtUtc: "2026-09-19T10:05:00Z", bitcoinTxid: "abc123", failureReason: null },
    custodyChain: { valid: true, mode: "HASH_CHAIN", reason: null },
  },
  relationships: {
    items: [
      { id: "r1", relationshipType: "DERIVED_FROM", direction: "outbound", createdAt: "x", updatedAt: "x", linkedEvidence: { id: "ev2", title: "Original", status: "SIGNED" } },
      { id: "r2", relationshipType: "X", linkedEvidence: {} }, // no linked id → dropped
    ],
  },
  sourceContext: { acquisition: { mode: "PROOVRA_MOBILE_APP", category: "MOBILE_APP", label: "Captured with the PROOVRA app", statement: "This record was captured…" } },
  publicVerificationSummary: { state: "PUBLISHED", published: true, disabledReason: null },
};

test("custody events bind from custodyLifecycle (forensic + access), drop malformed", () => {
  const { forensic, access } = mod.projectCustodyEvents(rw);
  assert.equal(forensic.length, 1);
  assert.equal(forensic[0].eventType, "EVIDENCE_SEALED");
  assert.equal(access.length, 1);
  assert.equal(access[0].category, "access");
});

test("preservation binds TSA/OTS/signature/custody-chain from preservationMatrix", () => {
  const p = mod.projectPreservation(rw);
  assert.equal(p.tsa.status, "GRANTED");
  assert.equal(p.tsa.provider, "FreeTSA");
  assert.equal(p.ots.effectiveStatus, "ANCHORED");
  assert.equal(p.ots.bitcoinTxid, "abc123");
  assert.equal(p.signature.recorded, true);
  assert.equal(p.custodyChain.valid, true);
});

test("relationships bind read-only, dropping rows without a linked id", () => {
  const rels = mod.projectRelationships(rw);
  assert.equal(rels.length, 1);
  assert.equal(rels[0].linkedId, "ev2");
  assert.equal(rels[0].linkedTitle, "Original");
});

test("provenance binds from sourceContext.acquisition", () => {
  const prov = mod.projectProvenance(rw);
  assert.equal(prov.label, "Captured with the PROOVRA app");
  assert.equal(prov.mode, "PROOVRA_MOBILE_APP");
});

test("technical + EXIF project from /technical-metadata; certifications from /certifications", () => {
  const tech = mod.projectTechnical({
    technicalMetadata: {
      media: { primaryMediaType: "IMAGE", resolutionSummary: "4032×3024", filesAnalyzed: 1, filesTotal: 1, metadataStatus: "COMPLETE" },
      exif: { exifPresent: true, camera: "Pixel 8", iso: 100, aperture: "f/1.8", gpsPresent: true },
      captureEnvironment: { captureMethod: "SECURE_CAPTURE", deviceClass: "MOBILE", osName: "Android 14", timezone: "Europe/Berlin" },
    },
  });
  assert.equal(tech.primaryMediaType, "IMAGE");
  assert.equal(tech.exif.camera, "Pixel 8");
  assert.equal(tech.exif.gpsPresent, true);
  assert.equal(tech.capture.timezone, "Europe/Berlin");
  assert.equal(mod.projectTechnical({}), null);

  const certs = mod.projectCertifications({ certifications: [{ id: "c1", declarationType: "AUTHENTICITY", status: "ATTESTED", attestorName: "Jane", attestedAtUtc: "x", revokedAtUtc: null }] });
  assert.equal(certs.length, 1);
  assert.equal(certs[0].revoked, false);
});

test("garbage review-workspace fails safe to empty projections", () => {
  assert.deepEqual(mod.projectCustodyEvents(null), { forensic: [], access: [] });
  assert.deepEqual(mod.projectRelationships(null), []);
  assert.equal(mod.projectProvenance(null), null);
});
