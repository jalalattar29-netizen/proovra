/**
 * PUBLIC VERIFY — web parity sections (apps/web/app/verify/[token]/page.tsx).
 *
 * Every fixture below follows the REAL reply of GET /public/verify/:id,
 * field for field (services/api/src/routes/evidence.routes.ts, final
 * `reply.code(200).send({...})` at ~:13807):
 *   trustDecision            :13815  (TrustDecision, packages/shared/src/trust-decision.ts)
 *   trustDecisionConsistency :13816  (trust-decision-consistency.service.ts)
 *   verificationSnapshot     :13817  (public-verify-consistency.service.ts)
 *   liveAnchoring            :13818  (public-verify-consistency.service.ts)
 *   verificationPackageIntegrity :13819 (built :12913-13020)
 *   outputContext            :13845
 *   contentAccessPolicy      :13861, contentExposureDecision :13862
 *   overview / humanSummary  :13875-13876 (buildPublicVerifyOverview / HumanSummary)
 *   evidenceContent          :13878  (items: buildPublicEvidenceContent :3692)
 *   integrityProof           :13885  (:13566)
 *   custodyLifecycle         :13886  (mapPublicCustodyEvent :4430)
 *   custodyDisplayCounts     :13887  (:13639)
 *   storageAndTimestamping   :13892
 *   technicalMaterials       :13942  (buildTechnicalMaterials :4361)
 *   redaction                :13813  (verify-redaction-projection.service.ts)
 *
 * Each section is asserted to appear only when its field is present, and
 * never to claim more than the field says.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadModule, renderComponent, React, act } from "./support/render.mjs";

const h = React.createElement;
let M;
let answer = () => ({ status: 200, body: {} });

before(async () => {
  M = await loadModule("app/verify.tsx", ["test/support/providers.tsx", "test/support/expo-stub.mjs", "src/product/public-verify.ts"]);
});
beforeEach(() => {
  globalThis.__EXPO_PARAMS__ = { id: "5b0a3c1e-0000-4000-8000-000000000001" };
  globalThis.__LINKING_OPENED__ = [];
  globalThis.fetch = async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    const res = path.startsWith("/public/verify/") ? answer() : { status: 200, body: {} };
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } });
  };
});

async function render() {
  const r = await renderComponent(h(M.TestProviders, null, h(M.default, {})));
  for (let i = 0; i < 3; i += 1) await act(async () => { await new Promise((x) => setTimeout(x, 0)); });
  return r;
}

const SHA = "a1".repeat(32);
const FP = "b2".repeat(32);
const TXID = "c3".repeat(32);

const signal = (key, label, status, tone, summary, detail) => ({ key, label, status, tone, points: 10, maxPoints: 10, summary, detail });

/** TrustDecision exactly as packages/shared/src/trust-decision.ts types it. */
function trustDecision(over = {}) {
  return {
    verdict: "VERIFIED",
    level: "standard",
    tone: "success",
    presentationState: "VERIFIED_FINALIZED",
    presentationTone: "success",
    anchoringState: "finalized",
    score: 94,
    maxScore: 100,
    scoreLabel: "94/100",
    verdictLabel: "Recorded integrity verified",
    shortLabel: "Verified",
    title: "Trust decision",
    confidenceLabel: "High",
    anchoringStatusLabel: "OpenTimestamps Bitcoin anchoring verified",
    summary: "Recorded integrity verified.",
    primaryReason: "Core hashes, signature and custody chain are consistent.",
    reviewerAction: "Rely on the recorded integrity state; assess context separately.",
    degradedButUsable: false,
    relianceLevel: "high",
    signals: [
      signal("core_integrity", "Core Integrity", "passed", "success", "Recorded integrity verified", "Fingerprint and file hash agree."),
      signal("signature", "Digital Signature", "passed", "success", "Signature valid", "Ed25519 signature verifies."),
      signal("trusted_timestamp", "Trusted Timestamp", "passed", "success", "RFC 3161 token granted", "Token imprint matches."),
      signal("bitcoin_anchoring", "Bitcoin Anchoring", "passed", "success", "Anchored", "OpenTimestamps proof anchored."),
      signal("immutable_storage", "Immutable Storage", "passed", "success", "Object Lock COMPLIANCE", "Retention active."),
      signal("custody_chain", "Custody Chain", "passed", "success", "Chain continuous", "Every event links."),
    ],
    passedSignals: 6,
    degradedSignals: 0,
    failedSignals: 0,
    ...over,
  };
}

const item = (over = {}) => ({
  id: "part-1",
  index: 0,
  label: "roof.jpg",
  originalFileName: "IMG_0042.JPG",
  mimeType: "image/jpeg",
  kind: "image",
  sizeBytes: "2048",
  durationMs: null,
  sha256: SHA,
  isPrimary: true,
  artifactRole: "primary_evidence",
  artifactRoleLabel: "Primary evidence",
  artifactRoleSource: "fallback_single",
  checklistStepId: null,
  checklistStepLabel: null,
  previewable: true,
  downloadable: false,
  viewUrl: "https://s3.example/roof.jpg?sig=1",
  displaySizeLabel: "2 KB",
  previewRole: "primary_preview",
  originalPreservationNote: "The original roof.jpg is preserved unchanged.",
  reviewerRepresentationLabel: "Image preview",
  reviewerRepresentationNote: "The preview is a reviewer-facing rendering.",
  verificationMaterialsNote: "Hashes below refer to the original file.",
  previewDataUrl: null,
  previewTextExcerpt: null,
  previewCaption: null,
  ...over,
});

/** The full reply, key for key. */
function reply(over = {}) {
  return {
    evidenceId: "5b0a3c1e-0000-4000-8000-000000000001",
    mediaIntelligenceAdvisory: null,
    acquisition: null,
    redaction: null,
    technicalMetadata: null,
    trustDecision: trustDecision(),
    trustDecisionConsistency: { source: "REPORT_SNAPSHOT", consistentWithSnapshot: true, tone: "neutral", accessOnly: false, integrityCritical: false, reasons: [] },
    verificationSnapshot: {
      source: "REPORT_SNAPSHOT",
      generatedAtUtc: "2026-09-01T10:05:00.000Z",
      reportVersion: 2,
      packageVersion: 1,
      trustDecisionSnapshot: trustDecision(),
      otsStatusAtGeneration: "PENDING",
      reportSignature: { status: "SIGNED", signedAtUtc: "2026-09-01T10:05:01.000Z" },
      verificationPackageSignature: { manifestPresent: true, manifestSigned: true, packageType: "FORENSIC" },
    },
    liveAnchoring: {
      currentOtsStatus: "ANCHORED",
      otsAnchoredAtUtc: "2026-09-02T08:00:00.000Z",
      otsBitcoinTxid: TXID,
      lastUpdatedAtUtc: "2026-09-02T08:00:00.000Z",
      hasAdvancedSinceSnapshot: true,
      newerReportAvailable: false,
      newerPackageAvailable: false,
      autoRefreshRecommended: false,
    },
    verificationPackageIntegrity: {
      available: true, version: 1, generatedAtUtc: "2026-09-01T10:06:00.000Z", packageType: "FORENSIC",
      manifestPresent: true, signedManifestPresent: true, manifestDigestPresent: true, checksumIndexPresent: true,
      auditExportIncluded: true, custodyExportIncluded: true, accessExportIncluded: false,
    },
    trustDecisionSource: "REPORT_SNAPSHOT",
    trustDecisionSnapshot: { reportVersion: 2, reportGeneratedAtUtc: "2026-09-01T10:05:00.000Z", verificationPackageVersion: 1, verificationPackageGeneratedAtUtc: "2026-09-01T10:06:00.000Z" },
    outputContext: {
      outputType: "PUBLIC_VERIFY_LIVE",
      isSnapshotOutput: false,
      isLiveOutput: true,
      snapshotGeneratedAtUtc: "2026-09-01T10:05:00.000Z",
      liveObservedAtUtc: "2026-09-25T09:00:00.000Z",
      liveDeltaMaterials: ["custodyChain", "otsAnchoring"],
      legalBoundary: "Public verification reflects the recorded technical state only.",
    },
    contentAccessPolicy: { mode: "preview_only", allowContentView: true, allowDownload: false },
    contentExposureDecision: {
      mode: "preview_only", allowContentView: true, allowDownload: false,
      rationale: "Public verification access allows controlled preview without unrestricted download.",
    },
    certifications: { custodian: null, qualifiedPerson: null },
    display: { displayTitle: "Roof photo", displayDescription: null },
    captureContext: null,
    overview: {
      recordStatus: "Reported", recordLifecycleStatus: "REPORTED",
      verificationStatus: "Recorded integrity state verified", verificationStatusCode: "RECORDED_INTEGRITY_VERIFIED",
      integrityHeadline: "Recorded integrity verified", evidenceTitle: "Roof photo", evidenceId: "5b0a3c1e-0000-4000-8000-000000000001",
      evidenceType: "Photo", evidenceStructure: "Single evidence item", itemCount: 1, captureMethod: "Direct upload",
      mimeType: "image/jpeg", submittedByEmail: null, submittedByAuthProvider: "Google", identityLevel: "OAuth-backed identity",
      workspaceName: null, organizationName: null, organizationVerified: null,
      createdAt: "2026-09-01T09:59:00.000Z", capturedAtUtc: "2026-09-01T10:00:00.000Z", uploadedAtUtc: "2026-09-01T10:00:30.000Z",
      signedAtUtc: "2026-09-01T10:01:00.000Z", lastVerifiedAtUtc: "2026-09-01T10:05:00.000Z",
      lastPublicVerifyViewAtUtc: null, currentPublicVerifyViewAtUtc: "2026-09-25T09:00:00.000Z",
      verificationPackageGeneratedAtUtc: "2026-09-01T10:06:00.000Z", verificationPackageVersion: 1,
      reviewerSummaryVersion: null, reportVersion: 2, reportGeneratedAtUtc: "2026-09-01T10:05:00.000Z",
      timestampStatus: "Timestamp granted", otsStatus: "Anchored", storageProtection: "Immutable", chainOfCustodyPresent: true,
    },
    humanSummary: {
      integrityStatus: "Recorded integrity verified", recordStatus: "Reported", verificationStatus: "Recorded integrity state verified",
      summary: "The recorded integrity checks passed.",
      whatIsVerified:
        "This verification checks the recorded integrity state of the evidence record, including fingerprint consistency, signature validation, recorded custody chain continuity, timestamp linkage, and OpenTimestamps linkage where available.",
      evidenceTitle: "Roof photo", evidenceId: "5b0a3c1e-0000-4000-8000-000000000001", evidenceType: "Photo", evidenceStructure: "Single evidence item",
      fileType: "image/jpeg", submittedBy: null, authProvider: "Google", identityLevel: "OAuth-backed identity",
      organization: null, workspace: null, organizationVerified: null,
    },
    evidenceContent: {
      summary: { structure: "single", itemCount: 1, previewableItemCount: 1, downloadableItemCount: 0, imageCount: 1, videoCount: 0, audioCount: 0, pdfCount: 0, textCount: 0, otherCount: 0, primaryKind: "image", primaryMimeType: "image/jpeg", totalSizeBytes: "2048", totalSizeDisplay: "2 KB" },
      items: [item()],
      primaryItem: item(),
      defaultPreviewItemId: "part-1",
      previewPolicy: {
        contentVisible: true, previewEnabled: true, downloadableFromVerify: false,
        rationale: "This verification flow may expose reviewer-facing preview access to the evidence content while technical verification separately validates the recorded integrity state.",
        privacyNotice: "Anyone with access to this verification flow may be able to preview evidence items exposed here, but download access may remain restricted.",
      },
    },
    integrityProof: {
      overallIntegrity: true, canonicalHashMatches: true, signatureValid: true, custodyChainValid: true,
      custodyChainMode: "v2", custodyChainFailureReason: null, timestampDigestMatches: true, otsHashMatches: true,
    },
    custodyLifecycle: {
      forensicEventCount: 2,
      accessEventCount: 1,
      forensicEvents: [
        { sequence: 1, atUtc: "2026-09-01T10:00:00.000Z", eventType: "EVIDENCE_CREATED", payloadSummary: "Evidence record created", prevEventHash: null, eventHash: "e1".repeat(32), category: "forensic" },
        { sequence: 2, atUtc: "2026-09-01T10:01:00.000Z", eventType: "EVIDENCE_SIGNED", payloadSummary: "Evidence signed • Event hash: e2e2", prevEventHash: "e1".repeat(32), eventHash: "e2".repeat(32), category: "forensic" },
      ],
      accessEvents: [
        { sequence: 3, atUtc: "2026-09-02T12:00:00.000Z", eventType: "VERIFY_VIEWED", payloadSummary: "Public verification page viewed", prevEventHash: "e2".repeat(32), eventHash: "e3".repeat(32), category: "access" },
      ],
      chronologyNote: "Forensic events describe integrity-relevant lifecycle actions. Access events describe later viewing, download, or verification access activity.",
    },
    custodyDisplayCounts: {
      forensicAtReportGeneration: 2, currentForensicEvents: 2, currentForensic: 2, accessAfterReportGeneration: 1,
      currentAccessEvents: 1, totalDisplayedEvents: 3, totalDisplayedNow: 3, reportGeneratedAtUtc: "2026-09-01T10:05:00.000Z",
    },
    legalAssessment: { limitations: { short: "s", detailed: "d" }, reviewGuidance: {} },
    storageAndTimestamping: {
      storage: { immutable: true, mode: "COMPLIANCE", retainUntil: "2033-09-01T00:00:00.000Z", legalHold: null, region: "eu-central-1", verified: true },
      tsa: {
        status: "GRANTED", provider: "DigiCert", url: "https://tsa.example", serialNumber: "0x1f", genTimeUtc: "2026-09-01T10:01:05.000Z",
        hashAlgorithm: "SHA-256", messageImprint: SHA, inputDigestHex: SHA, inputKind: "FILE_SHA256", legacyMode: false, failureReason: null,
        digestMatchesTimestampInput: true, digestMatchesFileHash: true, digestCheckConclusive: true, timestampAvailable: true,
        timestampedDigestLabel: "Timestamped Digest / Original File SHA-256", timestampedDigestNote: null,
      },
      ots: {
        status: "ANCHORED", hash: FP, calendar: "https://alice.btc.calendar.opentimestamps.org", bitcoinTxid: TXID,
        anchoredAtUtc: "2026-09-02T08:00:00.000Z", upgradedAtUtc: "2026-09-02T08:00:00.000Z", failureReason: null, proofPresent: true, hashMatchesFingerprintHash: true,
      },
      anchor: { mode: "off", provider: null, configured: false, anchorHash: null, transactionId: null, anchoredAtUtc: null },
    },
    technicalMaterials: {
      fileSha256: SHA, fileSha256Label: "SHA-256 of the original file", multipartManifestSha256: null, hashSemantics: "single_file",
      fingerprintHash: FP, signatureBase64: "c2lnbmF0dXJl", publicKeyPem: "-----BEGIN PUBLIC KEY-----", signingKeyId: "key-7", signingKeyVersion: 3,
      tsaMessageImprint: SHA, tsaInputDigestHex: SHA, tsaInputKind: "FILE_SHA256", legacyMode: false, otsProofPresent: true,
    },
    versioning: { latestReportVersion: 2, latestReportGeneratedAtUtc: "2026-09-01T10:05:00.000Z", verificationPackageVersion: 1, verificationPackageGeneratedAtUtc: "2026-09-01T10:06:00.000Z", reviewerSummaryVersion: null },
    ...over,
  };
}

const has = (r, s) => assert.ok(r.hasText(s), `missing: ${s}`);
const lacks = (r, s) => assert.ok(!r.hasText(s), `unexpected: ${s}`);
/** Text nodes inside one testID'd section (the legacy Integrity card repeats some raw values). */
function textsIn(r, id) {
  const [node] = r.byTestId(id);
  assert.ok(node, `no ${id}`);
  const flat = (c) =>
    c == null || c === false ? [] : typeof c === "string" ? [c] : typeof c === "number" ? [String(c)] : Array.isArray(c) ? c.flatMap(flat) : c.props ? flat(c.props.children) : [];
  return node.findAll((n) => n.type === "Text").map((n) => flat(n.props.children).join(""));
}

/* ------------------------------------------------ trust decision batch */

test("trustDecision renders the web Evidence Trust Decision card, verbatim, through the shared getters", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  assert.equal(r.byTestId("verify-trust-decision").length, 1);
  for (const s of [
    "Evidence Trust Decision",
    "Overall Trust Decision",
    "Recorded integrity verified",
    "Technical Confidence",
    "High",
    "Verification Classification",
    "RECORDED INTEGRITY VERIFIED",
    "Decision Basis",
    "Core hashes, signature and custody chain are consistent.",
    "Publication posture: OpenTimestamps Bitcoin anchoring verified.",
    "Rely on the recorded integrity state; assess context separately.",
  ]) has(r, s);
  // getTrustNarrative(VERIFIED_FINALIZED), packages/shared/src/trust-decision.ts.
  has(r, "Recorded integrity is verified across the returned cryptographic, custody, storage, timestamp, and anchoring materials.");
});

test("outputContext renders verdict source, snapshot/live times, deltas and its legal boundary", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  assert.equal(r.byTestId("verify-output-context").length, 1);
  has(r, "Verdict source: Live (recomputed at request time)");
  assert.ok(r.texts().some((t) => t.startsWith("Snapshot generated: ")));
  assert.ok(r.texts().some((t) => t.startsWith("Live observed: ")));
  has(r, "May have advanced since snapshot: custodyChain, otsAnchoring");
  has(r, "Public verification reflects the recorded technical state only.");
});

test("Trust Signal Breakdown lists each server signal with the web presentation label", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  has(r, "Trust Signal Breakdown");
  has(r, "Why this decision was reached");
  assert.equal(r.byTestId("verify-signal-core_integrity").length, 1);
  has(r, "Fingerprint and file hash agree.");
  assert.ok(r.byLabel("Verified").length >= 6, "passed+success signals read 'Verified' (getTrustSignalPresentationLabel)");
});

test("a clean integrityProof yields the web's verified legal boundary and the default reviewer action — no issue block", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  has(r, "Legal Review Boundary");
  has(r, "The available cryptographic, custody, timestamping, and storage signals returned in this verification response support the recorded integrity state. This does not independently prove factual truth, authorship, legal admissibility, or the real-world meaning of the evidence content.");
  has(r, "Recommended Reviewer Actions");
  has(r, "1. Review the displayed record identity, evidence hash, custody chain, timestamping materials, and access activity before external legal or operational reliance.");
  assert.equal(r.byTestId("verify-integrity-issues").length, 0);
  lacks(r, "Integrity Issue Explanation");
});

test("a failed signature is never presented as verified: Review Required boundary, issue explanation and actions", async () => {
  answer = () => ({
    status: 200,
    body: reply({
      trustDecision: trustDecision({ verdict: "REVIEW_REQUIRED", verdictLabel: "Insufficient verification", presentationState: "REVIEW_REQUIRED", presentationTone: "danger", tone: "danger", confidenceLabel: "Low" }),
      integrityProof: { overallIntegrity: false, canonicalHashMatches: true, signatureValid: false, custodyChainValid: false, custodyChainMode: "v2", custodyChainFailureReason: "Event 2 prevEventHash does not match event 1", timestampDigestMatches: true, otsHashMatches: true },
    }),
  });
  const r = await render();
  has(r, "One or more returned integrity checks did not pass. This page supports review of the recorded system state, but it must not be interpreted as conclusive proof of authenticity, authorship, factual truth, legal admissibility, or absence of tampering.");
  lacks(r, "support the recorded integrity state. This does not independently prove");
  has(r, "Integrity Issue Explanation");
  has(r, "Digital signature invalid");
  has(r, "Custody-chain continuity issue");
  has(r, "Event 2 prevEventHash does not match event 1");
  has(r, "1. Treat this record as requiring technical review before relying on it as a complete integrity verification result.");
  has(r, "Review the digital signature, signing key identifier, key version, and public key material before accepting the signature layer.");
  has(r, "Verification Warning");
  has(r, "Custody chain check reported: Event 2 prevEventHash does not match event 1");
  has(r, "Low");
});

test("a response without trustDecision / outputContext / integrityProof renders none of those sections", async () => {
  answer = () => ({ status: 200, body: { evidenceId: "ev-1", overview: { evidenceTitle: "Roof photo", verificationStatus: "Verified" }, technicalMaterials: { fileSha256: SHA } } });
  const r = await render();
  for (const id of ["verify-trust-decision", "verify-output-context", "verify-trust-signals", "verify-legal-boundary", "verify-reviewer-actions", "verify-supporting-signals", "verify-redaction", "verify-content-review", "verify-snapshot", "verify-live-anchoring"]) {
    assert.equal(r.byTestId(id).length, 0, `${id} rendered without its field`);
  }
  lacks(r, "Overall Trust Decision");
  lacks(r, "Legal Review Boundary");
  lacks(r, "No explicit digest, signature, custody, timestamp, or OTS mismatches were detected in the current verification result.");
});

/* ------------------------------------------------ supporting signals + anchoring batch */

test("Supporting Technical Signals: status pill, executive badges, reviewer action, three panels", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  has(r, "Verification Signal Summary");
  has(r, "Supporting Technical Signals");
  assert.ok(r.byLabel("REPORTED").length === 1, "the web statusTone pill of overview.recordStatus");
  assert.ok(r.byLabel("Core Integrity: Recorded integrity verified").length === 1);
  has(r, "This decision is limited to the recorded technical state. It does not prove factual truth, authorship, intent, context, or court admissibility.");
  has(r, "Legal review outcome");
  has(r, "Forensic custody posture");
  has(r, "Forensic custody at report/package generation: 2. Current forensic custody events: 2. Current access activity events: 1. Total displayed now: 3.");
  has(r, "The record contains 1 access-related event such as viewing, verification, or download activity. These events are informational and are not the same thing as forensic custody events.");
  has(r, "Scope of this page");
  has(r, "This verification checks the recorded integrity state of the evidence record");
  lacks(r, "Publication Posture");
  assert.equal(r.byTestId("verify-divergence").length, 0, "a consistent snapshot shows no divergence");
});

test("Verification package snapshot vs Live anchoring status, with the 'advanced' note", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  assert.equal(r.byTestId("verify-snapshot").length, 1);
  assert.equal(r.byTestId("verify-live-anchoring").length, 1);
  for (const s of [
    "Verification package snapshot",
    "This section reflects the verification package/report generated at the recorded time.",
    "Report snapshot", "v2", "v1", "Signed", "Recorded integrity verified",
    "Live anchoring status",
    "Anchoring has advanced since this package was generated. A newer report/package may be available.",
    "Current OTS Status", "ANCHORED", "Bitcoin Transaction", TXID, "Last Anchoring Update", "No newer report recorded", "No newer package recorded",
  ]) has(r, s);
  lacks(r, "OpenTimestamps public anchoring is pending.");
});

test("OTS pending: the live pending note and the Publication Posture panel appear", async () => {
  answer = () => ({
    status: 200,
    body: reply({
      trustDecision: trustDecision({ presentationState: "VERIFIED_PENDING_ANCHORING", presentationTone: "warning", anchoringState: "pending", verdictLabel: "Recorded integrity verified; Bitcoin anchoring pending", anchoringStatusLabel: "Bitcoin anchoring pending", confidenceLabel: "High (Bitcoin anchoring pending)" }),
      liveAnchoring: { currentOtsStatus: "PENDING", otsAnchoredAtUtc: null, otsBitcoinTxid: null, lastUpdatedAtUtc: null, hasAdvancedSinceSnapshot: false, newerReportAvailable: false, newerPackageAvailable: false, autoRefreshRecommended: false },
    }),
  });
  const r = await render();
  has(r, "OpenTimestamps public anchoring is pending. This does not invalidate recorded integrity, TSA timestamping, signature, custody, or Object Lock.");
  has(r, "Publication Posture");
  has(r, "Publication posture: Bitcoin anchoring pending.");
  lacks(r, "Anchoring has advanced since this package was generated.");
});

test("a snapshot divergence is surfaced with the server's reasons", async () => {
  answer = () => ({
    status: 200,
    body: reply({
      trustDecisionConsistency: {
        source: "REPORT_SNAPSHOT", consistentWithSnapshot: false, tone: "info", accessOnly: true, integrityCritical: false,
        reasons: [{ code: "ACCESS_ACTIVITY_CHANGED", label: "Access activity changed after the report snapshot", detail: "Later viewing was recorded.", tone: "info", integrityCritical: false }],
      },
    }),
  });
  const r = await render();
  assert.equal(r.byTestId("verify-divergence").length, 1);
  has(r, "Live access activity update");
  has(r, "No integrity mismatch detected. Later page views, downloads, or access activity changed after the fixed report snapshot.");
  has(r, "• Access activity changed after the report snapshot. Later viewing was recorded.");
});

/* ------------------------------------------------ redaction batch */

test("redaction: a published derivative renders the web rows and limitation copy; null renders nothing", async () => {
  answer = () => ({
    status: 200,
    body: reply({
      redaction: {
        hasPublishedDerivative: true, publishedVersionOrdinal: 2, publishedAtUtc: "2026-09-03T12:00:00.000Z", approvalCount: 2,
        videoProvenance: { totalFrames: 120, acceptedTracks: 4 },
        limitations: ["REDACTION_NEVER_MODIFIES_ORIGINAL", "REDACTION_DERIVATIVE_IS_NOT_ORIGINAL", "REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT", "REDACTION_TRACKING_IS_PROVENANCE_ONLY"],
      },
    }),
  });
  const r = await render();
  assert.equal(r.byTestId("verify-redaction").length, 1);
  for (const s of ["Redaction", "Redacted copy published", "Version 2", "Published on", "Approvals recorded", "Video frames reviewed", "120", "Regions approved for masking",
    "• The original file is never changed. A redacted copy is produced alongside it."]) has(r, s);

  answer = () => ({ status: 200, body: reply({ redaction: { hasPublishedDerivative: false, publishedVersionOrdinal: null, publishedAtUtc: null, approvalCount: 0, videoProvenance: null, limitations: [] } }) });
  const r2 = await render();
  has(r2, "None");
  assert.equal(r2.texts().filter((t) => t === "Approvals recorded").length, 0);

  answer = () => ({ status: 200, body: reply() });
  const r3 = await render();
  assert.equal(r3.byTestId("verify-redaction").length, 0, "no projection → no 'not redacted' claim");
});

/* ------------------------------------------------ content review batch */

test("Evidence Content Review renders the server item, policy notes and what changed", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  assert.equal(r.byTestId("verify-content-review").length, 1);
  for (const s of [
    "Evidence Content Review",
    "Image review surface",
    "This verification flow may expose reviewer-facing preview access to the evidence content while technical verification separately validates the recorded integrity state.",
    "Single evidence item • 2 KB • 1 item",
    "Controlled preview access",
    "Reviewer access note",
    "Public verification access allows controlled preview without unrestricted download.",
    "What changed since completion",
    "Report artifact version: 2.",
    "Verification package version: 1.",
    "Timestamp / mismatch review",
    "No explicit digest, signature, custody, timestamp, or OTS mismatches were detected in the current verification result.",
    "Representation note",
    "Selected Evidence Item",
    "Kind: Image",
    "MIME Type: image/jpeg",
    "Size: 2 KB",
    "Access role: Primary reviewer preview",
    `SHA-256: ${SHA}`,
    "Original: The original roof.jpg is preserved unchanged.",
    "Reviewer surface: Image preview",
    "Reviewer representation note",
    "Verification materials note",
  ]) has(r, s);
  assert.equal(r.root.findAll((n) => n.type === "Image").length, 1, "the image item is shown from its view URL");
  await r.press("Open preserved evidence");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://s3.example/roof.jpg?sig=1"]);
  assert.equal(r.byLabel("Download evidence").length, 0, "preview_only never offers a download");
});

test("metadata_only: no view URL means the web's 'not directly exposed' state and no open/download action", async () => {
  const meta = item({ previewable: false, downloadable: false, viewUrl: null, previewRole: "metadata_only" });
  answer = () => ({
    status: 200,
    body: reply({
      contentAccessPolicy: { mode: "metadata_only", allowContentView: false, allowDownload: false },
      contentExposureDecision: { mode: "metadata_only", allowContentView: false, allowDownload: false, rationale: "Public verification access is restricted to integrity and metadata review." },
      evidenceContent: { ...reply().evidenceContent, items: [meta], primaryItem: meta },
    }),
  });
  const r = await render();
  has(r, "Evidence content is not directly exposed here");
  has(r, "Metadata-only verification");
  has(r, "Access role: Metadata-only access");
  assert.equal(r.byLabel("Open preserved evidence").length, 0);
  assert.equal(r.byLabel("Download evidence").length, 0);
});

test("multipart: the item picker switches the selected item and offers a jump back to the primary", async () => {
  const primary = item();
  const clip = item({ id: "part-2", index: 1, label: "clip.mp4", kind: "video", mimeType: "video/mp4", isPrimary: false, artifactRole: "supporting_evidence", artifactRoleLabel: "Supporting evidence", checklistStepLabel: "Walkthrough", durationMs: 125000, previewRole: "secondary_preview", downloadable: true, viewUrl: "https://s3.example/clip.mp4" });
  answer = () => ({
    status: 200,
    body: reply({
      contentAccessPolicy: { mode: "full_access", allowContentView: true, allowDownload: true },
      evidenceContent: { ...reply().evidenceContent, summary: { ...reply().evidenceContent.summary, structure: "multipart", itemCount: 2 }, items: [primary, clip], primaryItem: primary },
    }),
  });
  const r = await render();
  has(r, "Video • Supporting evidence • Walkthrough");
  await r.press("clip.mp4");
  has(r, "Video review surface");
  has(r, "Duration: 2:05");
  has(r, "Primary evidence item");
  await r.press("Download evidence");
  assert.deepEqual(globalThis.__LINKING_OPENED__, ["https://s3.example/clip.mp4"]);
  await r.press("Jump to primary item");
  has(r, "Image review surface");
  has(r, "Direct evidence access");
});

/* ------------------------------------------------ technical materials batch */

test("Technical Review Materials: Record tab rows from overview/humanSummary; no false 'Submitted By'", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  has(r, "Technical Review Materials");
  has(r, "Forensic Review Mode");
  has(r, "Enable to expand raw hashes, signatures, public key material, custody hashes, and timestamp proof fields.");
  assert.equal(r.byTestId("verify-tab-record").length, 1);
  for (const s of ["Evidence Status At Report Generation", "Reported", "Verification Status", "Recorded integrity state verified", "Integrity Status", "Recorded Integrity Verified",
    "Evidence Type", "Photo Evidence", "Evidence Structure", "Auth Provider", "Google", "Identity Level", "OAuth-backed identity", "Report Version",
    "Verification Package Version", "Last meaningful verification", "Current public verify page view", "File Type"]) has(r, s);
  lacks(r, "Submitted By");
  lacks(r, "Last public verify page view");
});

test("Integrity tab: material fields, status cards, and failure notes only when the server sends them", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  await r.press("Integrity");
  assert.equal(r.byTestId("verify-tab-integrity").length, 1);
  for (const s of ["Integrity scope", "Original File SHA-256", "SHA-256 digest of the original preserved evidence file.", "Canonical Fingerprint Hash", "Digital Signature",
    "Public Key", "Signature Status", "Fingerprint Status", "Custody Chain", "OpenTimestamps", "Immutable Storage Locked", "Timestamp Status", "GRANTED",
    "Timestamp Provider", "DigiCert", "Hash Algorithm", "Signing Key", "Signing Key Version", "OTS Calendar", "OTS Proof", "Proof Present", "OTS Hash Check", "Hash Matches"]) has(r, s);
  lacks(r, "Timestamped Digest / Original File SHA-256"); // inputDigestHex === fileSha256: web hides it
  lacks(r, "Timestamp Failure Reason");
  lacks(r, "OpenTimestamps Status Note");
  lacks(r, "OpenTimestamps Proof"); // web reads ots.proofBase64, which the route never sends
  lacks(r, "Legacy mode:");

  answer = () => ({
    status: 200,
    body: reply({
      storageAndTimestamping: {
        ...reply().storageAndTimestamping,
        tsa: { ...reply().storageAndTimestamping.tsa, status: "FAILED", failureReason: "TSA HTTP 503", inputDigestHex: FP, inputKind: "FINGERPRINT_SHA256", legacyMode: true, timestampedDigestLabel: null, digestMatchesTimestampInput: null },
        ots: { ...reply().storageAndTimestamping.ots, status: "FAILED", failureReason: "request   timed out", bitcoinTxid: null, proofPresent: false },
      },
      integrityProof: { ...reply().integrityProof, timestampDigestMatches: null },
    }),
  });
  const r2 = await render();
  await r2.press("Integrity");
  for (const s of ["File Digest (SHA-256)", "Timestamped Digest / Original File SHA-256", "Legacy mode: this record predates explicit timestamp-input digest storage",
    "Timestamp Failure Reason", "TSA HTTP 503", "OpenTimestamps Status Note",
    "OpenTimestamps request timed out before the calendar service returned a result.", "Not Present"]) has(r2, s);
  assert.ok(!r2.texts().includes("request timed out"), "technical detail hidden until asked for");
  await r2.press("Show technical details");
  assert.ok(r2.texts().includes("request timed out"), "whitespace-normalised technical detail");
  // TSA failed → never a clean verified boundary.
  has(r2, "Review timestamp availability. The timestamp provider did not return a usable token, so no timestamp digest match or mismatch can be concluded.");
});

test("Forensic Review Mode expands long values and reveals custody Prev Hash / Event Hash", async () => {
  const pem = `-----BEGIN PUBLIC KEY-----${"K".repeat(300)}`;
  answer = () => ({ status: 200, body: reply({ technicalMaterials: { ...reply().technicalMaterials, publicKeyPem: pem } }) });
  const r = await render();
  await r.press("Integrity");
  assert.ok(!textsIn(r, "verify-tab-integrity").includes(pem));
  assert.ok(textsIn(r, "verify-tab-integrity").includes(`${pem.slice(0, 180)}...`));
  await r.press("Expand Public Key");
  assert.ok(textsIn(r, "verify-tab-integrity").includes(pem));

  await r.press("Custody Chain");
  assert.equal(r.byTestId("verify-tab-custody").length, 1);
  for (const s of ["Evidence Created", "Evidence Signed", "Verify Viewed", "Forensic 2 • Access 1 • Total 3",
    "Counts are live and may increase after report or package generation as reviewers open, download, or verify materials."]) has(r, s);
  lacks(r, "Event hash: e2e2"); // stripShortHashLines
  lacks(r, "Prev Hash");
  await r.press("Enable Forensic Mode");
  has(r, "Raw technical materials are expanded for forensic review.");
  has(r, `Prev Hash: ${"e1".repeat(32)}`);
  has(r, `Event Hash: ${"e2".repeat(32)}`);
});

test("Package Integrity credits exports only when the server does — never from custody event counts", async () => {
  answer = () => ({
    status: 200,
    body: reply({
      verificationPackageIntegrity: { ...reply().verificationPackageIntegrity, custodyExportIncluded: false, accessExportIncluded: false, auditExportIncluded: false },
    }),
  });
  const r = await render();
  await r.press("Package Integrity");
  assert.equal(r.byTestId("verify-tab-package").length, 1);
  for (const s of ["Verification Package Integrity", "Package Integrity Partial", "A verification package version exists, but this public response has not confirmed every package artifact.",
    "Partial Package", "Package Decision", "Version v1", "Impact on Trust Decision", "Package Manifest", "Ed25519 signature present", "Checksum Index", "Package verification scope"]) has(r, s);
  // The record HAS custody and access events; the package does not include their exports.
  const custodyRow = r.byLabel("Not available");
  assert.ok(custodyRow.length >= 2, "Custody Export and Access / Audit Export read 'Not available'");
  lacks(r, "Package Integrity Complete");
  lacks(r, "Independent Review Enabled");
});

test("Access Activity tab: the boundary and the server's access events", async () => {
  answer = () => ({ status: 200, body: reply() });
  const r = await render();
  await r.press("Access Activity");
  assert.equal(r.byTestId("verify-tab-access").length, 1);
  has(r, "Access Activity Boundary");
  has(r, "Access activity is not part of the evidence integrity verdict.");
  has(r, "1 Event");
  has(r, "Public verification page viewed");

  answer = () => ({ status: 200, body: reply({ custodyLifecycle: { ...reply().custodyLifecycle, accessEventCount: 0, accessEvents: [] } }) });
  const r2 = await render();
  await r2.press("Access Activity");
  has(r2, "No access activity was returned");
});

test("the verification link is selectable text beside the Share flow", async () => {
  const prev = process.env.EXPO_PUBLIC_WEB_BASE;
  process.env.EXPO_PUBLIC_WEB_BASE = "https://proovra.example";
  try {
    answer = () => ({ status: 200, body: reply() });
    const r = await render();
    const url = r.byTestId("verify-share-url");
    assert.equal(url.length, 1);
    assert.equal(url[0].props.selectable, true);
    has(r, "https://proovra.example/verify/5b0a3c1e-0000-4000-8000-000000000001");
    assert.equal(r.byLabel("Share verification link").length, 1);
  } finally {
    if (prev === undefined) delete process.env.EXPO_PUBLIC_WEB_BASE;
    else process.env.EXPO_PUBLIC_WEB_BASE = prev;
  }
});
