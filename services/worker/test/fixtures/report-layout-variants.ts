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

const PROOFS = JSON.parse(
  readFileSync(new URL("../../../../packages/shared/tests/fixtures/ots-proofs.json", import.meta.url), "utf8"),
) as { boundFingerprintCanonicalJson: string; boundFingerprintHash: string; boundProofBase64: string; otherProofBase64: string };

/** A real calendar proof with a Bitcoin attestation at its root (`ots upgrade`'s serialization). */
function withBitcoinAttestation(proofBase64: string, height: number): string {
  const bytes = Buffer.from(proofBase64, "base64");
  const headerLen = 31 + 1 + 1 + 32;
  const varuint: number[] = [];
  for (let n = height; ; ) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      varuint.push(b);
      break;
    }
    varuint.push(b | 0x80);
  }
  const attestation = Buffer.from([0xff, 0x00, 0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01, varuint.length, ...varuint]);
  return Buffer.concat([bytes.subarray(0, headerLen), attestation, bytes.subarray(headerLen)]).toString("base64");
}

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

export type OtsVariant =
  | "none"
  | "pending"
  | "attestation_not_verified"
  | "verification_unavailable"
  | "verification_failed"
  | "chain_verified"
  /** A proof committed to ANOTHER digest, recorded FAILED by the worker. */
  | "proof_invalid";

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
  if (kind === "proof_invalid") {
    return {
      ...base,
      otsStatus: "FAILED",
      otsFailureReason: "PROOF_HASH_MISMATCH",
      otsProofBase64: withBitcoinAttestation(PROOFS.otherProofBase64, 860_000),
      otsUpgradedAtUtc: "2026-10-01T12:00:00.000Z",
    };
  }
  const attested = {
    ...base,
    otsStatus: "ANCHORED",
    otsProofBase64: withBitcoinAttestation(PROOFS.boundProofBase64, 860_000),
    otsBitcoinTxid: "c".repeat(64),
    otsAnchoredAtUtc: "2026-10-01T12:00:00.000Z",
    otsUpgradedAtUtc: "2026-10-01T12:00:00.000Z",
    otsAttestationRecordedAtUtc: "2026-10-01T12:00:00.000Z",
    otsAttestationBlockHeight: 860_000,
    otsAnchorCheck: "PROOF_STRUCTURE",
    otsAnchorCheckedAtUtc: "2026-10-01T12:00:00.000Z",
  };
  if (kind === "attestation_not_verified") return { ...attested, otsChainVerificationStatus: "NOT_CONFIGURED", otsChainCheckedAtUtc: "2026-10-01T12:00:00.000Z" };
  if (kind === "verification_unavailable") return { ...attested, otsChainVerificationStatus: "UNAVAILABLE", otsChainCheckedAtUtc: "2026-10-01T12:00:00.000Z" };
  if (kind === "verification_failed") {
    return {
      ...attested,
      otsChainVerificationStatus: "FAILED",
      otsChainCheckedAtUtc: "2026-10-01T12:00:00.000Z",
      otsChainFailureCode: "ATTESTATION_NOT_IN_BLOCK",
    };
  }
  return {
    ...attested,
    otsAnchorCheck: "BITCOIN_VERIFIED",
    otsChainVerificationStatus: "VERIFIED",
    otsChainCheckedAtUtc: "2026-10-01T13:00:00.000Z",
    otsChainVerifiedAtUtc: "2026-10-01T13:00:00.000Z",
    otsChainBlockHeight: 860_000,
    otsChainBlockHash: "00000000000000000001ec3f183cf87a623516376df048fed10a1696ed0f328f",
    otsChainBlockTimeUtc: "2026-10-01T11:48:12.000Z",
    otsChainConfirmations: 12,
    otsChainVerifier: "bitcoind-rpc/opentimestamps-client 0.7.2",
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
  { name: "v2 · supersession · long values", supersession: true, longValues: true, ots: "attestation_not_verified" },
  { name: "5 parts · attestation present, not verified", parts: 5, ots: "attestation_not_verified" },
  { name: "20 parts · chain verification unavailable", parts: 20, ots: "verification_unavailable", custodyEvents: 40 },
  { name: "100 parts · chain verification failed · TSA unavailable", parts: 100, ots: "verification_failed", tsaStamped: false, custodyEvents: 120 },
  { name: "browser capture · long manifest URL · chain verified", mode: "browser_capture", longValues: true, ots: "chain_verified" },
  { name: "mobile capture · minimal identity · no OTS", mode: "mobile_capture", identity: "minimal", ots: "none" },
  { name: "maximum limitation content · long values", maxLimitation: true, longValues: true, parts: 5 },
  // The shape that first stranded a heading and left a blank page in the
  // production image: an updated (v3) report over a 14-event detailed chain.
  { name: "v3 · supersession · 14 detailed custody events", supersession: true, version: 3, custodyEvents: 14 },
];
