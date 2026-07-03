/**
 * Phase TECHNICAL-APPENDIX — enterprise "Technical Evidence Context" on the
 * authenticated Evidence Detail page.
 *
 * Two test kinds (matching the web test convention):
 *   1. UNIT — the pure section-model builders run against synthetic inputs
 *      covering intake, capture, multipart, integrity and custody.
 *   2. SOURCE-PIN — the component set is scanned to guarantee the ten
 *      sections are present and that forbidden vocabulary never appears.
 *
 * Forbidden wording (must never render on this page):
 *   C2PA · publication pending · public receipt · receipt URL · public URL ·
 *   MULTIPART_PACKAGE · BULK_IMPORT
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  anchoringStatusLabel,
  buildAcquisitionModel,
  buildCaptureDeviceRows,
  buildClientAdvancedRows,
  buildCustodySummaryRows,
  buildIntegrityRows,
  fmtBytes,
  fmtDurationMs,
  isIntakeEvidence,
  timestampStatusLabel,
} from "../app/(app)/evidence/[id]/_tabs/technical-appendix/sections-model";
import type { TechnicalMetadataInternal } from "../app/(app)/evidence/[id]/_tabs/technical-appendix/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const APPENDIX_DIR = resolve(
  HERE,
  "../app/(app)/evidence/[id]/_tabs/technical-appendix",
);
const readAppendix = (f: string) =>
  readFileSync(resolve(APPENDIX_DIR, f), "utf8");

const FORBIDDEN = [
  "C2PA",
  "publication pending",
  "public receipt",
  "receipt URL",
  "public URL",
  "MULTIPART_PACKAGE",
  "BULK_IMPORT",
];

// ---------------------------------------------------------------------------
// Synthetic inputs
// ---------------------------------------------------------------------------

function intakeTm(): TechnicalMetadataInternal {
  return {
    media: {
      filesAnalyzed: 1,
      filesTotal: 1,
      metadataStatus: "Complete",
      primaryMediaType: "Image",
      resolutionSummary: "4032×3024",
    },
    exif: {
      applicable: true,
      exifPresent: true,
      camera: "Samsung Galaxy S25 FE",
      lensModel: null,
      originalCaptureTime: "2026-06-01T09:00:00Z",
      iso: 100,
      aperture: "f/1.8",
      exposureTime: "1/120",
      shutterSpeed: "1/120",
      whiteBalance: "Auto",
      orientation: 1,
      gpsPresent: true,
      resolution: "4032×3024",
      softwareTag: null,
      metadataStatus: "PRESENT",
    },
    captureEnvironment: {
      uploadSource: "Intake Link Submission",
      captureMethod: "Secure Intake Link",
      browserName: "Chrome",
      browserVersion: "149.0.0.0",
      osName: "Android",
      osVersion: "10",
      deviceClass: "MOBILE",
      engine: null,
      platform: null,
      timezone: "Europe/Berlin",
      locale: "de-DE",
      userAgentHash: "sha256:cafe",
      ipAddressMasked: "203.0.x.x",
    },
    network: null,
    perParts: [
      {
        partIndex: 0,
        filename: "photo.jpg",
        role: "Primary",
        mappingLabel: "Primary image reviewer representation",
        mediaKind: "IMAGE",
        mimeType: "image/jpeg",
        sizeBytes: 4_234_567,
        sha256: "a".repeat(64),
        width: 4032,
        height: 3024,
        durationMs: null,
        codec: null,
        container: null,
        pageCount: null,
        metadataStatusLabel: "Embedded metadata available",
      },
    ],
    acquisition: {
      method: "Secure Intake Link",
      deliveryChannel: "SMS",
      submissionType: "Single contribution",
      submissionStatus: ["Opened", "Submitted"],
      identityVerification: "Not verified",
      consentAccepted: true,
      consentVersion: "v1",
      submittedAtUtc: "2026-06-01T09:05:00Z",
      recipientMasked: "+49 ••• ••• 1234",
      recipientType: "phone",
    },
  };
}

function captureTm(): TechnicalMetadataInternal {
  const t = intakeTm();
  return {
    ...t,
    captureEnvironment: {
      ...t.captureEnvironment!,
      uploadSource: "PROOVRA Web Application",
      captureMethod: "PROOVRA Web Upload",
    },
    acquisition: null,
  };
}

// ---------------------------------------------------------------------------
// UNIT — Section 1 Acquisition (intake)
// ---------------------------------------------------------------------------

test("intake: acquisition model — Secure Intake Link, SMS, Remote Contributor, consent, not verified", () => {
  const tm = intakeTm();
  assert.equal(isIntakeEvidence(tm), true);
  const m = buildAcquisitionModel(tm);
  assert.equal(m.isIntake, true);

  const flat = JSON.stringify(m);
  assert.match(flat, /Secure Intake Link/);
  assert.match(flat, /SMS/);
  assert.match(flat, /Remote Contributor/);
  assert.match(flat, /Accepted/);

  // Role model: contributor identity is explicitly NOT verified; the
  // link creator/requester is the recorded workspace identity.
  const role = JSON.stringify(m.roleModel);
  assert.match(role, /Remote Contributor via Secure Intake Link/);
  assert.match(role, /Not independently verified/);
  assert.match(role, /Workspace identity recorded/);
});

// ---------------------------------------------------------------------------
// UNIT — Section 1 Acquisition (capture) + Section 2 Capture Device
// ---------------------------------------------------------------------------

test("capture: acquisition model — PROOVRA Web Upload, authenticated submitter", () => {
  const tm = captureTm();
  assert.equal(isIntakeEvidence(tm), false);
  const m = buildAcquisitionModel(tm);
  assert.equal(m.isIntake, false);
  const flat = JSON.stringify(m);
  assert.match(flat, /PROOVRA Web Upload/);
  assert.match(flat, /Authenticated workspace user/);
  assert.doesNotMatch(flat, /Remote Contributor/);
});

test("capture device rows expose device/OS/browser/timezone; no empty rows", () => {
  const rows = buildCaptureDeviceRows(captureTm());
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel["Operating system"], "Android 10");
  assert.equal(byLabel["Device type"], "MOBILE");
  assert.equal(byLabel["Browser"], "Chrome 149.0.0.0");
  assert.equal(byLabel["Timezone"], "Europe/Berlin");
  // Every row carries a meaningful value.
  for (const r of rows) assert.ok(r.value && r.value.trim().length > 0);
});

test("client advanced rows carry masked IP + UA hash (never raw)", () => {
  const rows = buildClientAdvancedRows(intakeTm());
  const flat = JSON.stringify(rows);
  assert.match(flat, /203\.0\.x\.x/);
  assert.match(flat, /sha256:cafe/);
});

// ---------------------------------------------------------------------------
// UNIT — Section 9 Security & Integrity
// ---------------------------------------------------------------------------

test("integrity rows: canonical digest, fingerprint, signature, anchoring statuses", () => {
  const rows = buildIntegrityRows({
    multipart: true,
    preservation: {
      recordedIntegrityVerifiedAtUtc: "2026-06-01T09:10:00Z",
      signature: { recorded: true, valid: true, keyId: "key-1", keyVersion: 2 },
      tsa: { status: "STAMPED", provider: "Apple", timestampedDigestLabel: "" },
      ots: {
        effectiveStatus: "PENDING",
        proofPresent: true,
        bitcoinTxid: null,
        anchoredAtUtc: null,
        calendar: null,
      },
      storage: {},
    },
    evidence: {
      evidenceRef: "ev-1",
      fileSha256: "c".repeat(64),
      fingerprintHash: "d".repeat(64),
      tsaSerialNumber: "TSA-1",
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: "2030-01-01T00:00:00Z",
    },
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel["Canonical package digest (SHA-256)"], "c".repeat(64));
  assert.equal(byLabel["Canonical fingerprint hash"], "d".repeat(64));
  assert.equal(byLabel["Recorded integrity"], "Recorded integrity verified");
  assert.equal(byLabel["Digital signature"], "Digital signature recorded");
  assert.equal(byLabel["Trusted timestamp"], "Trusted timestamp recorded");
  assert.equal(
    byLabel["OpenTimestamps / Bitcoin anchoring"],
    "OpenTimestamps proof present; Bitcoin anchoring pending",
  );
  assert.equal(byLabel["Immutable storage"], "Compliance retention lock");
});

test("anchoring label is txid-truthful; timestamp labels map correctly", () => {
  assert.equal(
    anchoringStatusLabel({
      status: "ANCHORED",
      bitcoinTxid: "e".repeat(64),
      anchoredAtUtc: "2026-06-02T00:00:00Z",
      proofPresent: true,
    }),
    "OpenTimestamps Bitcoin anchoring verified",
  );
  assert.equal(
    anchoringStatusLabel({
      status: "PENDING",
      bitcoinTxid: null,
      anchoredAtUtc: null,
      proofPresent: true,
    }),
    "OpenTimestamps proof present; Bitcoin anchoring pending",
  );
  assert.equal(timestampStatusLabel("STAMPED"), "Trusted timestamp recorded");
  assert.equal(timestampStatusLabel("PENDING"), "Trusted timestamp pending");
});

// ---------------------------------------------------------------------------
// UNIT — Section 10 Custody + formatters
// ---------------------------------------------------------------------------

test("custody summary rows: counts, first/latest, hash chain, status", () => {
  const rows = buildCustodySummaryRows({
    forensicEventCount: 7,
    firstEventAtUtc: "2026-06-01T09:00:00Z",
    latestEventAtUtc: "2026-06-01T09:10:00Z",
    latestEventHash: "f".repeat(64),
    hashChainValid: true,
    status: "REPORTED",
  });
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel["Total forensic events"], "7");
  assert.equal(byLabel["Hash chain"], "Recorded");
  assert.equal(byLabel["Latest custody hash"], "f".repeat(64));
  assert.equal(byLabel["Current evidence status"], "REPORTED");
});

test("formatters: bytes + duration", () => {
  assert.equal(fmtBytes(4_234_567), "4.0 MB");
  assert.equal(fmtBytes(0), null);
  assert.equal(fmtDurationMs(42_000), "42s");
  assert.equal(fmtDurationMs(90_000), "1m 30s");
  assert.equal(fmtDurationMs(null), null);
});

// ---------------------------------------------------------------------------
// UNIT — no forbidden wording emitted by the model for any scenario
// ---------------------------------------------------------------------------

test("model output never contains forbidden vocabulary (intake + capture)", () => {
  for (const tm of [intakeTm(), captureTm()]) {
    const payload = JSON.stringify([
      buildAcquisitionModel(tm),
      buildCaptureDeviceRows(tm),
    ]);
    for (const bad of FORBIDDEN) {
      assert.ok(
        !payload.includes(bad),
        `model output must not contain "${bad}"`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// SOURCE-PIN — ten sections present; forbidden wording absent
// ---------------------------------------------------------------------------

test("orchestrator renders all ten appendix sections", () => {
  // Location + integrity sections live in their own component files rendered
  // by the orchestrator; scan the whole set for each section id.
  const src = [
    "EvidenceTechnicalAppendix.tsx",
    "LocationContextCard.tsx",
    "IntegrityContextCard.tsx",
  ]
    .map(readAppendix)
    .join("\n");
  // The orchestrator must actually mount the dedicated cards.
  const orchestrator = readAppendix("EvidenceTechnicalAppendix.tsx");
  assert.match(orchestrator, /<LocationContextCard/);
  assert.match(orchestrator, /<IntegrityContextCard/);
  const sectionIds = [
    "ta-section-acquisition",
    "ta-section-capture-device",
    "ta-section-camera",
    "ta-section-exposure",
    "ta-section-location",
    "ta-section-client-env",
    "ta-section-upload-session",
    "ta-section-technical-metadata",
    "ta-section-integrity",
    "ta-section-custody-summary",
  ];
  for (const id of sectionIds) {
    assert.ok(src.includes(id), `orchestrator must render section ${id}`);
  }
});

test("per-part table renders per-part SHA-256 with role badge", () => {
  const src = readAppendix("EvidencePartMetadataTable.tsx");
  assert.match(src, /ta-part-sha256/);
  assert.match(src, /p\.sha256/);
  assert.match(src, /AppendixBadge/); // role badge
  assert.match(src, /CopyButton/); // copyable hash
});

test("no forbidden wording anywhere in the appendix component set", () => {
  const files = [
    "EvidenceTechnicalAppendix.tsx",
    "TechnicalAppendixCard.tsx",
    "MetadataRow.tsx",
    "EvidencePartMetadataTable.tsx",
    "FullExifAccordion.tsx",
    "LocationContextCard.tsx",
    "IntegrityContextCard.tsx",
    "sections-model.ts",
    "types.ts",
  ];
  for (const f of files) {
    const src = readAppendix(f);
    for (const bad of FORBIDDEN) {
      assert.ok(
        !src.includes(bad),
        `${f} must not contain forbidden wording "${bad}"`,
      );
    }
  }
});

test("empty states use clear language, never blank rows", () => {
  const src = readAppendix("EvidenceTechnicalAppendix.tsx");
  assert.match(src, /No EXIF camera metadata recorded/);
  assert.match(src, /No device metadata was recorded/);
  const loc = readAppendix("LocationContextCard.tsx");
  assert.match(loc, /Location was not provided/);
});
