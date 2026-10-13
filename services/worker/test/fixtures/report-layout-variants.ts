/**
 * REPORT LAYOUT VARIANTS (2026-10-12) — the inputs the rendered-report layout
 * tests print through the real renderer (HTML → Chromium → PDF) and read back
 * through the geometric gate. Each variant stresses one thing a page can get
 * wrong: many parts, long unbreakable values, a supersession block, every
 * OpenTimestamps truth state, both timestamp outcomes, full and minimal
 * identity, and the longest realistic limitation text.
 */
import { readFileSync } from "node:fs";

import { buildEvidenceAcquisitionContext, toPublicAcquisition } from "@proovra/shared-runtime/technical-metadata";

import type { ReportEvidenceAsset, ReportV2Input } from "../../src/report-v2/types.js";
import { reportInputFixture } from "./report-v2-input.js";
import { upgradedProof } from "../../../../packages/shared/tests/helpers/ots-fixtures.mjs";

const PROOFS = JSON.parse(
  readFileSync(new URL("../../../../packages/shared/tests/fixtures/ots-proofs.json", import.meta.url), "utf8"),
) as { boundFingerprintCanonicalJson: string; boundFingerprintHash: string; boundProofBase64: string; otherProofBase64: string };

const AT = "2026-10-01T09:15:00.000Z";
const LONG_HASH = "9f2c4e7a1b3d5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7";
export const LONG_EMAIL = "investigations.coordinator.international-compliance@very-long-subdomain.example-organisation.co.uk";
export const LONG_TITLE =
  "Recorded statement and supporting material concerning the procurement review of the regional infrastructure programme, submitted for independent verification by the compliance office";
export const LONG_FILENAME =
  "2026-10-01_procurement-review_regional-infrastructure-programme_supporting-material_final-signed-copy_v12_REDACTED-for-disclosure.pdf";
export const LONG_MANIFEST_URL =
  "https://records.example-municipality.gov/archive/2026/procurement/regional-infrastructure-programme/supporting-material/viewer?document=0f9e8d7c6b5a49382716051f2e3d4c5b6a798897a6b5c4d3e2f1&session=a1b2c3d4e5f60718293a4b5c6d7e8f90&utm_source=compliance-review&utm_medium=evidence&page=17#section-4.2.1-annex-B";
export const MAX_LIMITATION =
  "This report verifies the recorded integrity, preservation and custody state of the record only. It does not establish the factual truth of the content, who created it, when or where it was created before submission, whether it was edited before submission, or its legal admissibility or evidentiary weight in any jurisdiction. Those questions require separate review by a qualified person with access to the surrounding facts, the original source and the applicable rules of evidence.";

function asset(i: number, kind: "text" | "pdf" | "image" | "video", longName: boolean): ReportEvidenceAsset {
  const mime = { text: "text/plain", pdf: "application/pdf", image: "image/jpeg", video: "video/mp4" }[kind];
  const name = longName && i === 0 ? LONG_FILENAME : `part-${String(i + 1).padStart(3, "0")}.${kind === "text" ? "txt" : kind === "pdf" ? "pdf" : kind === "image" ? "jpg" : "mp4"}`;
  const sha = createDigest(i);
  return {
    id: `item-${i + 1}`,
    index: i,
    label: i === 0 ? "Primary evidence" : `Supporting part ${i + 1}`,
    originalFileName: name,
    mimeType: mime,
    kind,
    sizeBytes: String(1024 * (i + 3)),
    durationMs: kind === "video" ? 42_000 : null,
    sha256: sha,
    isPrimary: i === 0,
    previewable: kind === "text",
    downloadable: true,
    viewUrl: null,
    displaySizeLabel: `${i + 3} KB`,
    previewRole: i === 0 ? "primary_preview" : "supporting_preview",
    embedPreference: kind === "text" ? "text_excerpt" : "metadata_only",
    artifactRole: i === 0 ? "primary_evidence" : "supporting_evidence",
    originalPreservationNote: "Original preserved.",
    reviewerRepresentationLabel: kind === "text" ? "Rendered excerpt" : "Metadata only",
    reviewerRepresentationNote: "Reviewer-facing representation only.",
    verificationMaterialsNote: "See technical appendix.",
    previewTextExcerpt: kind === "text" ? `Excerpt of part ${i + 1}.` : null,
    previewCaption: kind === "text" ? "Text excerpt" : null,
    previewDataUrl: null,
  } as ReportEvidenceAsset;
}

function createDigest(i: number): string {
  return (i.toString(16).padStart(4, "0") + LONG_HASH).slice(0, 64);
}

function parts(n: number, longName = false): Partial<ReportV2Input["evidence"]> {
  const kinds = ["text", "pdf", "image", "video"] as const;
  const items = Array.from({ length: n }, (_, i) => asset(i, kinds[i % kinds.length]!, longName));
  const count = (k: string) => items.filter((a) => a.kind === k).length;
  return {
    itemCount: n,
    evidenceStructure: n > 1 ? "multipart" : "single",
    contentItems: items,
    primaryContentItem: items[0]!,
    defaultPreviewItemId: items[0]!.id,
    contentSummary: {
      structure: n > 1 ? "multipart" : "single",
      itemCount: n,
      previewableItemCount: count("text"),
      downloadableItemCount: n,
      imageCount: count("image"),
      videoCount: count("video"),
      audioCount: 0,
      pdfCount: count("pdf"),
      textCount: count("text"),
      otherCount: 0,
      primaryKind: "text",
      primaryMimeType: "text/plain",
      totalSizeBytes: String(items.reduce((s, a) => s + Number(a.sizeBytes), 0)),
      totalSizeDisplay: `${n * 4} KB`,
    } as never,
    embeddedPreviewsSnapshot: items
      .filter((a) => a.kind === "text")
      .map((a) => ({ id: a.id, previewTextExcerpt: a.previewTextExcerpt, previewCaption: a.previewCaption })) as never,
  };
}

/**
 * Custody events shaped like a real record's: the event types a Web Upload
 * produces, with the long details the timeline prints. (A real 14-event chain
 * of this shape is what first produced a stranded heading and a blank page.)
 */
const CUSTODY_SHAPES: ReadonlyArray<[string, string]> = [
  ["EVIDENCE_CREATED", "Evidence record created."],
  ["IDENTITY_SNAPSHOT_RECORDED", `Authenticated workspace user identity was recorded at submission. Identity snapshot recorded • Authenticated email account • Personal workspace • Organization verification: not established • Email: ${LONG_EMAIL}`],
  ["UPLOAD_AUTHORIZED", "Upload authorization recorded (presigned URL issued; bytes not yet confirmed) • Mode: web upload authorization"],
  ["UPLOAD_COMPLETED", "Single evidence item completed • Items: 1 • Size: 46 bytes • technical digest recorded in appendix"],
  ["SIGNATURE_APPLIED", "Cryptographic signature applied • Key: rga-ed25519 • Version: 1 • technical digest recorded in appendix • Timestamp: not validated • TSA: RGA LOCAL TEST TSA"],
  ["TIMESTAMP_APPLIED", "Timestamp token obtained, not validated (no trust anchor was available) • Reviewer should rely on the recorded digest, signature, custody history, and available verification materials."],
  ["EVIDENCE_COMPLETED", "Evidence record completed • Completed by the record owner • Submitted through: PROOVRA Web Upload"],
  ["STORAGE_PROTECTION_UNAVAILABLE", "Storage protection was attempted, but Object Lock retention was not actually applied. Treat storage immutability as not asserted for this record."],
  ["IDENTITY_CONTEXT_RECORDED", "The report recorded which identity snapshot it states (the one recorded when the record was created)."],
  ["REPORT_GENERATED", "Verification report generated • Version: 1 • Verification: recorded integrity verified • Capture: PROOVRA Web Upload"],
];

function custody(n: number): ReportV2Input["custodyEvents"] {
  return Array.from({ length: n }, (_, i) => ({
    sequence: i + 1,
    atUtc: new Date(Date.parse(AT) + i * 60_000).toISOString(),
    eventType: CUSTODY_SHAPES[i % CUSTODY_SHAPES.length]![0],
    payloadSummary: CUSTODY_SHAPES[i % CUSTODY_SHAPES.length]![1],
    eventHash: createDigest(1000 + i),
    prevEventHash: i === 0 ? null : createDigest(999 + i),
  }));
}

type Identity = "full" | "minimal";
function identity(kind: Identity): Partial<ReportV2Input["evidence"]> {
  if (kind === "minimal") {
    return {
      acquisitionIdentity: {
        basis: "UNAVAILABLE",
        recordedAtUtc: null,
        identityLevel: null,
        authProvider: null,
        emailVerified: null,
        workspaceKind: "NOT_RECORDED",
        workspaceName: null,
        organizationName: null,
        organizationVerified: null,
        submittedByEmail: null,
        submittedByUserId: null,
        actorKind: "NOT_RECORDED",
        accountRole: "NOT_RECORDED",
        contributorEmailProvided: null,
      },
    };
  }
  return {
    submittedByEmail: LONG_EMAIL,
    submittedByAuthProvider: "EMAIL",
    workspaceNameSnapshot: "International Compliance and Procurement Oversight Directorate — Regional Review Team",
    organizationNameSnapshot: "Example Organisation for Public Infrastructure Accountability and Transparency",
    organizationVerifiedSnapshot: false,
    acquisitionIdentity: {
      basis: "OBSERVED_AT_CAPTURE",
      recordedAtUtc: AT,
      identityLevel: "EMAIL_VERIFIED",
      authProvider: "EMAIL",
      emailVerified: true,
      workspaceKind: "SHARED",
      workspaceName: "International Compliance and Procurement Oversight Directorate — Regional Review Team",
      organizationName: "Example Organisation for Public Infrastructure Accountability and Transparency",
      organizationVerified: false,
      submittedByEmail: LONG_EMAIL,
      submittedByUserId: "user-1",
      actorKind: "ACCOUNT_USER",
      accountRole: "SUBMITTER",
      contributorEmailProvided: null,
    },
  };
}

/** The canonical OpenTimestamps states (ots-anchoring.ts), on real proof bytes. */
export type OtsVariant =
  | "none"
  | "pending"
  /** An upgraded proof whose executed path derives the txid. */
  | "anchored"
  /** An upgraded proof with no transaction step: anchored, no txid. */
  | "anchored_no_txid"
  /** A pending proof the upgrade budget gave up on. */
  | "budget_failed"
  /** A stored status with no proof bytes. */
  | "unavailable"
  /** A proof committed to ANOTHER digest, recorded FAILED by the worker. */
  | "proof_invalid";

export const ANCHORED_PROOF = upgradedProof({ blockHeight: 860_000 });
const ANCHORED_NO_TXID_PROOF = upgradedProof({ blockHeight: 860_000, withTransaction: false });

function ots(kind: OtsVariant): Partial<ReportV2Input["evidence"]> {
  if (kind === "none") return { otsStatus: null };
  const base = {
    fingerprintCanonicalJson: PROOFS.boundFingerprintCanonicalJson,
    fingerprintHash: PROOFS.boundFingerprintHash,
    otsHash: PROOFS.boundFingerprintHash,
    otsCalendar: "https://alice.btc.calendar.opentimestamps.org",
    otsSubmittedAtUtc: AT,
  };
  if (kind === "pending") return { ...base, otsStatus: "PENDING", otsProofBase64: PROOFS.boundProofBase64 };
  if (kind === "unavailable") return { ...base, otsStatus: "PENDING", otsProofBase64: null };
  if (kind === "budget_failed") {
    return {
      ...base,
      otsStatus: "FAILED",
      otsFailureReason: "OTS_GLOBAL_BUDGET_EXHAUSTED",
      otsProofBase64: PROOFS.boundProofBase64,
      otsUpgradedAtUtc: "2026-10-01T12:00:00.000Z",
    };
  }
  if (kind === "proof_invalid") {
    return {
      ...base,
      otsStatus: "FAILED",
      otsFailureReason: "PROOF_HASH_MISMATCH",
      otsProofBase64: upgradedProof({ base64: PROOFS.otherProofBase64 }).base64,
      otsUpgradedAtUtc: "2026-10-01T12:00:00.000Z",
    };
  }
  const proof = kind === "anchored_no_txid" ? ANCHORED_NO_TXID_PROOF : ANCHORED_PROOF;
  return {
    ...base,
    otsStatus: "ANCHORED",
    otsProofBase64: proof.base64,
    otsBitcoinTxid: proof.txid,
    otsAnchoredAtUtc: "2026-10-01T12:00:00.000Z",
    otsUpgradedAtUtc: "2026-10-01T12:00:00.000Z",
  };
}

function tsa(stamped: boolean): Partial<ReportV2Input["evidence"]> {
  if (!stamped) {
    return { tsaStatus: "UNAVAILABLE", tsaFailureReason: "The timestamp authority could not be reached.", tsaFailureCode: "TSA_UNREACHABLE" };
  }
  return {
    tsaProvider: "Example Qualified Timestamp Authority (RFC 3161) — European Trust Services",
    tsaUrl: "https://timestamp.example-trust-services.eu/rfc3161/qualified/sha256",
    tsaSerialNumber: "0x4f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c",
    tsaGenTimeUtc: "2026-10-01T09:15:04.000Z",
    tsaHashAlgorithm: "SHA-256",
    tsaMessageImprint: LONG_HASH,
    tsaStatus: "STAMPED",
    tsaValidatedAtUtc: "2026-10-01T09:20:00.000Z",
    tsaTokenBase64: Buffer.from("rfc3161-token-fixture").toString("base64"),
  };
}

function acquisition(mode: "web_upload" | "browser_capture" | "mobile_capture") {
  const acquisitionMode = {
    web_upload: "PROOVRA_WEB_UPLOAD",
    browser_capture: "DIRECT_WEB_CAPTURE_EXTENSION",
    mobile_capture: "PROOVRA_MOBILE_APP",
  }[mode];
  const ctx = buildEvidenceAcquisitionContext({ acquisitionMode, submittedAtUtc: AT } as never);
  return { acquisitionMode, acquisition: ctx ? (toPublicAcquisition(ctx) as never) : null };
}

const BROWSER_MANIFEST = {
  schema: "PROOVRA_CAPTURE_MANIFEST_FACTS_V1",
  kind: "WEB",
  reportedBy: "CAPTURE_CLIENT",
  manifestSchemaVersion: "1.0.0",
  manifestSha256: LONG_HASH,
  manifestPartIndex: 1,
  clientCaptureWindow: { startedAtUtc: AT, endedAtUtc: "2026-10-01T09:16:30.000Z" },
  completeness: "CAPTURED",
  reportedComplete: false,
  limitations: ["DYNAMIC_CONTENT_PRESENT", "CROSS_ORIGIN_FRAMES_NOT_CAPTURED"],
  client: {
    kind: "BROWSER_EXTENSION",
    appVersion: "1.4.2",
    platform: null,
    osVersion: "Windows 11",
    model: null,
    browserName: "Chrome",
    browserVersion: "130",
  },
  web: {
    domain: "records.example-municipality.gov",
    sourceUrlPrivate: LONG_MANIFEST_URL,
    titlePrivate: LONG_TITLE,
    captureMode: "FULL_PAGE",
    pageMutatedDuringCapture: true,
  },
  screen: null,
} as const;

export type LayoutVariant = {
  name: string;
  input: ReportV2Input;
};

type VariantOptions = {
  name: string;
  version?: number;
  parts?: number;
  longValues?: boolean;
  custodyEvents?: number;
  identity?: Identity;
  ots?: OtsVariant;
  tsaStamped?: boolean;
  mode?: "web_upload" | "browser_capture" | "mobile_capture";
  supersession?: boolean;
  maxLimitation?: boolean;
};

export function layoutVariant(o: VariantOptions): LayoutVariant {
  const base = reportInputFixture();
  const acq = acquisition(o.mode ?? "web_upload");
  const long = o.longValues === true;
  const version = o.version ?? (o.supersession ? 2 : 1);
  const evidence = {
    ...base.evidence,
    id: "4f8d2c1a-9b7e-4c3d-8a2f-1e6b5d4c3a29",
    title: long ? LONG_TITLE : "Procurement review — supporting material",
    acquisitionMode: acq.acquisitionMode,
    ...parts(o.parts ?? 1, long),
    ...identity(o.identity ?? "full"),
    ...tsa(o.tsaStamped !== false),
    ...ots(o.ots ?? "pending"),
    latestReportVersion: version,
    ...(o.maxLimitation
      ? {
          limitations: { short: MAX_LIMITATION, detailed: `${MAX_LIMITATION} ${MAX_LIMITATION}` },
          reviewGuidance: {
            reviewerWorkflow: [
              "Confirm the record identifier and report version match the verification page.",
              "Recompute the SHA-256 digest of every original part and compare it with this report.",
              "Verify the record signature with the published public key.",
              "Validate the RFC 3161 timestamp token against the authority's certificate chain.",
              "Inspect the OpenTimestamps proof and, where a Bitcoin node is available, verify it independently.",
              "Review the custody chain for gaps or unexpected access.",
            ],
            contentReviewNote: MAX_LIMITATION,
            legalAssessmentNote: MAX_LIMITATION,
            integrityAssessmentNote: MAX_LIMITATION,
            multipartReviewNote: MAX_LIMITATION,
          },
        }
      : {}),
  } as ReportV2Input["evidence"];
  return {
    name: o.name,
    input: {
      ...base,
      evidence,
      version,
      custodyEvents: custody(o.custodyEvents ?? 8),
      verifyUrl: "https://app.proovra.example/verify/4f8d2c1a-9b7e-4c3d-8a2f-1e6b5d4c3a29",
      publicVerificationPublished: true,
      acquisition: acq.acquisition,
      captureManifest: o.mode === "browser_capture" ? (BROWSER_MANIFEST as never) : null,
      supersession: o.supersession
        ? {
            previousVersion: version - 1,
            previousGeneratedAtUtc: "2026-10-02T08:00:00.000Z",
            changes: [
              "The OpenTimestamps proof gained a Bitcoin attestation after the previous version was generated.",
              "The record signature was re-verified against the published public key.",
              "Three custody events were recorded since the previous version, including two access events.",
              "The verification package was regenerated and now certifies this report version.",
              "The RFC 3161 timestamp token was validated against the authority's certificate chain.",
              "The previous version's wording of the anchoring time was corrected: it named the time PROOVRA recorded the proof.",
            ],
            reason: long
              ? "Corrected wording and layout after review: the previous version described the time PROOVRA recorded the OpenTimestamps proof as a Bitcoin anchor time, and long identifiers overflowed the page."
              : "Corrected wording after review.",
          }
        : null,
    },
  };
}

/** The variants every layout test renders. */
export const LAYOUT_VARIANTS: ReadonlyArray<VariantOptions> = [
  { name: "v1 · web upload · 1 part · OTS pending · TSA stamped · full identity" },
  { name: "v2 · supersession · long values · Bitcoin anchored", supersession: true, longValues: true, ots: "anchored" },
  { name: "5 parts · Bitcoin anchored", parts: 5, ots: "anchored" },
  { name: "20 parts · anchoring unavailable", parts: 20, ots: "unavailable", custodyEvents: 40 },
  { name: "100 parts · anchoring failed (budget) · TSA unavailable", parts: 100, ots: "budget_failed", tsaStamped: false, custodyEvents: 120 },
  { name: "browser capture · long manifest URL · anchored without derivable txid", mode: "browser_capture", longValues: true, ots: "anchored_no_txid" },
  { name: "mobile capture · minimal identity · no OTS", mode: "mobile_capture", identity: "minimal", ots: "none" },
  { name: "maximum limitation content · long values", maxLimitation: true, longValues: true, parts: 5 },
  // The shape that first stranded a heading and left a blank page in the
  // production image: an updated (v3) report over a 14-event detailed chain.
  { name: "v3 · supersession · 14 detailed custody events", supersession: true, version: 3, custodyEvents: 14 },
];

/**
 * THE REGRESSION RECORD (2026-10-13): shaped like evidence
 * ce465a9e-43c2-4702-87e5-32fcb2dc52fc's report v2 — a five-part web upload
 * from a personal email account, 23 forensic custody events, a validated
 * timestamp, COMPLIANCE retention, a verified signature and custody chain, and
 * an upgraded OpenTimestamps proof that executes to a Bitcoin block-header
 * attestation (2026-10-13: "Bitcoin anchoring — Anchored").
 * `location` chooses what the record holds for location.
 */
export function regressionRecordInput(
  location: "absent" | "recorded" | "incomplete" = "absent",
): ReportV2Input {
  const { input } = layoutVariant({
    name: "regression record",
    parts: 5,
    custodyEvents: 23,
    ots: "anchored",
    supersession: true,
  });
  const gps =
    location === "recorded"
      ? { lat: "52.521", lng: "13.405", accuracyMeters: "102", locationSource: null }
      : location === "incomplete"
        ? { lat: "52.521", lng: null, accuracyMeters: "102", locationSource: null }
        : { lat: null, lng: null, accuracyMeters: null, locationSource: null };
  return {
    ...input,
    evidence: {
      ...input.evidence,
      verificationStatus: "RECORDED_INTEGRITY_VERIFIED",
      signatureVerified: true,
      custodyChainValid: true,
      storageImmutable: true,
      storageObjectLockMode: "COMPLIANCE",
      storageObjectLockRetainUntilUtc: "2036-10-08T15:10:02.000Z",
      submittedByEmail: "submitter@example.test",
      submittedByAuthProvider: "EMAIL",
      identityLevelSnapshot: "VERIFIED_EMAIL",
      workspaceNameSnapshot: null,
      organizationNameSnapshot: null,
      organizationVerifiedSnapshot: false,
      acquisitionIdentity: {
        basis: "OBSERVED_AT_CAPTURE",
        recordedAtUtc: "2026-10-08T15:09:52.000Z",
        identityLevel: "VERIFIED_EMAIL",
        authProvider: "EMAIL",
        emailVerified: true,
        workspaceKind: "PERSONAL",
        workspaceName: null,
        organizationName: null,
        organizationVerified: null,
        submittedByEmail: "submitter@example.test",
        submittedByUserId: "user-1",
        actorKind: "ACCOUNT_USER",
        accountRole: "SUBMITTER",
        contributorEmailProvided: null,
      },
      gps,
      // The record carries an anchor record too (the v2 report printed its
      // "Anchor Mode" row — with the PENDING sentence).
      anchorMode: "PUBLIC",
      anchorProvider: "OpenTimestamps",
    } as ReportV2Input["evidence"],
    supersession: input.supersession
      ? { ...input.supersession, changes: [], reason: "OTS STATUS" }
      : null,
  };
}
