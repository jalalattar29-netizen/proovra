/**
 * PUBLIC VERIFY — what the verify screen may claim (T-12 / RC-13).
 *
 * THE DEFECT
 * ----------
 * Any 200 from `GET /public/verify/:token` rendered the success layout with a
 * green badge reading "Verified record" when the server sent no state — even
 * when the response carried no hash, no signature, no evidence item, no
 * overview and no summary. The web shows "Evidence Not Found" in exactly that
 * case (verify/[token]/page.tsx:4626-4640): "The evidence token is invalid,
 * unavailable, or no verification materials were returned."
 *
 * A verification surface is the one place an overclaim is a correctness bug,
 * so the rule is ported exactly and nothing is inferred beyond it. PURE.
 */
import {
  getReviewerEvidenceTypeLabel,
  getTrustDecisionConfidenceLabel,
  getTrustDecisionLabel,
  getTrustDecisionPresentationTone,
  getTrustNarrative,
  getTrustSignalPresentationLabel,
  maskPublicEmailsInText,
  type TrustDecision,
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  CAPTURE_LOCATION_STATUS_LABEL,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  hasCaptureLocationMetadata,
} from "@proovra/shared";
import {
  PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE,
  PROOVRA_MULTIPART_RECOMPUTATION_NOTE,
  PROOVRA_MULTIPART_REVIEWER_EXPLANATION,
} from "@proovra/shared-evidence-presentation";

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** The hash the web shows: technicalMaterials first, then the legacy top-level field (page.tsx:3272). */
export function verifyFileSha256(data: unknown): string | null {
  const d = obj(data);
  return str(obj(d["technicalMaterials"])["fileSha256"]) ?? str(d["fileSha256"]);
}
export function verifyFingerprint(data: unknown): string | null {
  const d = obj(data);
  return str(obj(d["technicalMaterials"])["fingerprintHash"]) ?? str(d["fingerprintHash"]);
}
function verifySignature(data: unknown): string | null {
  const d = obj(data);
  return str(obj(d["technicalMaterials"])["signatureBase64"]) ?? str(d["signatureBase64"]);
}

/**
 * The web's "not found" test, inverted: materials exist when there is a hash,
 * a signature, an evidence item, an overview or a human summary.
 */
export function hasVerificationMaterials(data: unknown): boolean {
  const d = obj(data);
  const items = obj(d["evidenceContent"])["items"];
  return Boolean(
    verifyFileSha256(d) ||
      verifySignature(d) ||
      (Array.isArray(items) && items.length > 0) ||
      (d["overview"] && typeof d["overview"] === "object") ||
      (d["humanSummary"] && typeof d["humanSummary"] === "object"),
  );
}

/** verify/[token]/page.tsx:4612-4638, verbatim. */
export const VERIFY_COPY = {
  failedTitle: "Verification Failed",
  failedFallback: "Verification failed",
  notFoundTitle: "Evidence Not Found",
  notFoundBody: "The evidence token is invalid, unavailable, or no verification materials were returned.",
  tryAgain: "Try Again",
} as const;

// ---------------------------------------------------------------------------
// T-14 — THE VIEW, read from the fields GET /public/verify/:id actually sends.
//
// THE DEFECT: the screen read top-level `type`, `createdAt`, `custodyEvents`,
// `verificationState` and `publicUrl`. None of them is on the response
// (evidence.routes.ts final send: overview, humanSummary, technicalMaterials,
// storageAndTimestamping, evidenceContent, custodyLifecycle,
// technicalMetadata …), so the record's name, type, date, status and chain
// of custody were silently blank on every public verification.
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface VerifyItem {
  id: string;
  label: string;
  kind: string;
  originalFileName: string | null;
  durationMs: number | null;
  sizeLabel: string | null;
  isPrimary: boolean;
  roleLabel: string | null;
}
export interface VerifyView {
  title: string | null;
  evidenceType: string | null;
  statusLabel: string | null;
  integrityHeadline: string | null;
  summary: string | null;
  capturedAt: string | null;
  signedAt: string | null;
  materials: {
    fileSha256: string | null;
    fingerprint: string | null;
    signatureBase64: string | null;
    publicKeyPem: string | null;
    signingKey: string | null;
  };
  tsa: { status: string | null; provider: string | null; genTimeUtc: string | null; serialNumber: string | null };
  ots: { status: string | null; bitcoinTxid: string | null; anchoredAtUtc: string | null; calendar: string | null; proofPresent: boolean };
  anchorTransactionId: string | null;
  items: VerifyItem[];
  custody: Array<{ eventType: string; atUtc: string | null; summary: string | null }>;
  accessEventCount: number | null;
  acquisition: Array<{ label: string; value: string }>;
  device: Array<{ label: string; value: string }>;
}

function meaningful(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = v.trim().toUpperCase();
  return t !== "" && t !== "UNKNOWN" && t !== "N/A";
}

export function parseVerifyView(payload: unknown): VerifyView {
  const d = obj(payload);
  const ov = obj(d["overview"]);
  const hs = obj(d["humanSummary"]);
  const tm = obj(d["technicalMaterials"]);
  const st = obj(d["storageAndTimestamping"]);
  const tsa = obj(st["tsa"]);
  const ots = obj(st["ots"]);
  const anchor = obj(st["anchor"]);
  const content = obj(d["evidenceContent"]);
  const custody = obj(d["custodyLifecycle"]);
  const meta = obj(d["technicalMetadata"]);

  const items: VerifyItem[] = [];
  for (const raw of Array.isArray(content["items"]) ? (content["items"] as unknown[]) : []) {
    const it = obj(raw);
    const id = str(it["id"]);
    if (!id) continue;
    items.push({
      id,
      label: str(it["label"]) ?? str(it["originalFileName"]) ?? "Evidence item",
      kind: str(it["kind"]) ?? "other",
      originalFileName: str(it["originalFileName"]),
      durationMs: num(it["durationMs"]),
      sizeLabel: str(it["displaySizeLabel"]),
      isPrimary: it["isPrimary"] === true,
      roleLabel: str(it["artifactRoleLabel"]),
    });
  }

  const acq = obj(meta["acquisition"]);
  const method = str(acq["method"]);
  const submittedThrough =
    method === "Direct Upload"
      ? "PROOVRA Web Application"
      : method === "Intake Link" || method === "Public Secure Link"
        ? "Secure Intake Link"
        : method;
  const status = Array.isArray(acq["submissionStatus"]) ? (acq["submissionStatus"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const acquisition = (
    [
      ["Submitted through", submittedThrough],
      ["Delivery Channel", str(acq["deliveryChannel"])],
      ["Submission", str(acq["submissionType"])],
      ["Consent", acq["consentAccepted"] === true ? "Accepted" : null],
      ["Submission Status", status.length ? status.join(" • ") : null],
    ] as Array<[string, string | null]>
  )
    .filter((r): r is [string, string] => meaningful(r[1]))
    .map(([label, value]) => ({ label, value }));

  const exif = obj(meta["exif"]);
  const ce = obj(meta["captureEnvironment"]);
  const os = [str(ce["osName"]), str(ce["osVersion"])].filter(Boolean).join(" ") || null;
  const device = (
    [
      ["Capture Device", exif["exifPresent"] === true ? str(exif["camera"]) : null],
      ["Operating system", os],
      ["Device", str(ce["deviceClass"])],
      ["EXIF Original Capture Time", exif["exifPresent"] === true ? str(exif["originalCaptureTime"]) : null],
    ] as Array<[string, string | null]>
  )
    .filter((r): r is [string, string] => meaningful(r[1]))
    .map(([label, value]) => ({ label, value }));

  const forensic = Array.isArray(custody["forensicEvents"]) ? (custody["forensicEvents"] as unknown[]) : [];
  const keyId = str(tm["signingKeyId"]);
  const keyVersion = num(tm["signingKeyVersion"]);
  return {
    title: str(ov["evidenceTitle"]) ?? str(hs["evidenceTitle"]),
    evidenceType: str(ov["evidenceType"]) ?? str(hs["evidenceType"]),
    statusLabel: str(ov["verificationStatus"]) ?? str(hs["verificationStatus"]),
    integrityHeadline: str(ov["integrityHeadline"]) ?? str(hs["integrityStatus"]),
    summary: str(hs["summary"]),
    capturedAt: str(ov["capturedAtUtc"]) ?? str(ov["createdAt"]) ?? str(hs["capturedAtUtc"]),
    signedAt: str(ov["signedAtUtc"]) ?? str(hs["signedAtUtc"]),
    materials: {
      fileSha256: verifyFileSha256(d),
      fingerprint: verifyFingerprint(d),
      signatureBase64: verifySignature(d),
      publicKeyPem: str(tm["publicKeyPem"]) ?? str(d["publicKeyPem"]),
      signingKey: keyId ? `${keyId}${keyVersion !== null ? ` (v${keyVersion})` : ""}` : null,
    },
    tsa: { status: str(tsa["status"]), provider: str(tsa["provider"]), genTimeUtc: str(tsa["genTimeUtc"]), serialNumber: str(tsa["serialNumber"]) },
    ots: {
      status: str(ots["status"]),
      bitcoinTxid: str(ots["bitcoinTxid"]),
      anchoredAtUtc: str(ots["anchoredAtUtc"]),
      calendar: str(ots["calendar"]),
      proofPresent: ots["proofPresent"] === true || tm["otsProofPresent"] === true,
    },
    anchorTransactionId: str(anchor["transactionId"]),
    items,
    custody: forensic.map((raw) => {
      const e = obj(raw);
      return { eventType: str(e["eventType"]) ?? "EVENT", atUtc: str(e["atUtc"]), summary: publicEventSummary(str(e["payloadSummary"])) };
    }),
    accessEventCount: num(custody["accessEventCount"]),
    acquisition,
    device,
  };
}

/** formatDuration (verify/[token]/page.tsx:1123), verbatim: m:ss, or h:mm:ss. */
export function formatVerifyDuration(ms: number | null): string | null {
  if (!ms || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function publicVerifyUrl(origin: string | null, token: string): string | null {
  return origin ? `${origin}/verify/${encodeURIComponent(token)}` : null;
}

// ---------------------------------------------------------------------------
// T-14 — "How this record was acquired" (web VerifyCaptureIntegritySection),
// from the verify response's top-level `acquisition` (PublicVerifyAcquisition).
// Accepted only at its schema version; anything else renders nothing rather
// than a guessed state. Attestation is never called verified unless it was.
// ---------------------------------------------------------------------------

export const PUBLIC_ACQUISITION_SCHEMA = "PROOVRA_PUBLIC_ACQUISITION_V1";

const SIGNATURE_TEXT: Record<string, string> = {
  VALID: "The submitting app's registered device key signed the declared file digest for this session.",
  INVALID_SIGNATURE: "A device signature was supplied but did not verify.",
  INVALID_HASH: "A device signature was supplied for different bytes.",
  INVALID_CANONICAL_JSON: "A device signature was supplied in an invalid form.",
  UNKNOWN_DEVICE: "A device signature was supplied by an unregistered device.",
  ALGORITHM_UNSUPPORTED: "A device signature used an unsupported algorithm.",
};

export interface VerifyCaptureIntegrity {
  label: string;
  statement: string | null;
  backfilled: boolean;
  session: { startedAtIso: string | null; endedAtIso: string | null; digestsConfirmed: number } | null;
  signatureLine: string | null;
  attestationLine: string | null;
  integrityEstablishedAtIso: string | null;
  artifacts: { original: number; captureRecord: number; derived: number };
  limitations: string[];
}

export function parseVerifyCaptureIntegrity(payload: unknown): VerifyCaptureIntegrity | null {
  const v = obj(obj(payload)["acquisition"]);
  if (v["schemaVersion"] !== PUBLIC_ACQUISITION_SCHEMA) return null;
  const a = obj(v["acquisition"]);
  const label = str(a["label"]);
  if (!label) return null;
  const sessionRaw = v["captureSession"];
  const s = obj(sessionRaw);
  const sig = obj(v["deviceSignature"]);
  const att = obj(v["deviceAttestation"]);
  const art = obj(v["artifacts"]);
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    label,
    statement: str(a["statement"]),
    backfilled: a["recordedBy"] === "BACKFILL_INTAKE_SESSION_LINK",
    session: sessionRaw && typeof sessionRaw === "object" ? { startedAtIso: str(s["startedAtUtc"]), endedAtIso: str(s["endedAtUtc"]), digestsConfirmed: n(s["digestsConfirmed"]) } : null,
    signatureLine: sig["applicable"] === true ? SIGNATURE_TEXT[str(sig["verdict"]) ?? ""] ?? "A device signature was supplied." : null,
    attestationLine:
      att["applicable"] === true
        ? att["verified"] === true
          ? "The platform's device attestation was verified by PROOVRA."
          : "Device integrity was not independently verified."
        : null,
    integrityEstablishedAtIso: str(obj(v["integrity"])["establishedAtUtc"]),
    artifacts: { original: n(art["original"]), captureRecord: n(art["captureRecord"]), derived: n(art["derived"]) },
    limitations: (Array.isArray(v["limitations"]) ? v["limitations"] : []).map((l) => str(obj(l)["text"])).filter((x): x is string => x !== null),
  };
}

/** The web artifacts line. */
export function verifyArtifactsLine(a: VerifyCaptureIntegrity["artifacts"]): string {
  return [
    `${a.original} original file${a.original === 1 ? "" : "s"}`,
    a.captureRecord > 0 ? `${a.captureRecord} capture record${a.captureRecord === 1 ? "" : "s"}` : null,
    a.derived > 0 ? `${a.derived} derived review item${a.derived === 1 ? "" : "s"} (generated by PROOVRA, not originals)` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ===========================================================================
// WEB PARITY — the sections of apps/web/app/verify/[token]/page.tsx that read
// fields GET /public/verify/:id actually sends (evidence.routes.ts final
// reply, ~:13807). Every projector returns null when its field is absent, so
// a section never renders from a guess. Wording is the web's, verbatim.
// ===========================================================================

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function upper(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : "";
  return s ? s : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Web tone vocabulary → the native status palette. */
export type VerifyWebTone = "success" | "warning" | "danger" | "info" | "neutral";
export function verifyBadgeTone(tone: VerifyWebTone | string | null): "verified" | "pending" | "risk" | "info" | "neutral" {
  switch (tone) {
    case "success":
      return "verified";
    case "warning":
      return "pending";
    case "danger":
      return "risk";
    case "info":
      return "info";
    default:
      return "neutral";
  }
}

/** verify-v2/_helpers.ts normalizeEventLabel, verbatim. */
export function normalizeEventLabel(value?: string | null): string {
  if (!value) return "Unknown Event";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

/** verify-v2/_helpers.ts statusTone(...).label. */
export function verifyStatusPillLabel(status?: string | null): string {
  const s = (status ?? "").toUpperCase();
  return s || "AVAILABLE";
}

/** verify-v2/_helpers.ts timestampTone. */
export function verifyTimestampTone(status?: string | null): { label: string; tone: VerifyWebTone } {
  const s = (status ?? "").toUpperCase();
  if (s === "STAMPED" || s === "GRANTED" || s === "VERIFIED" || s === "SUCCEEDED") return { label: s, tone: "success" };
  if (s === "PENDING") return { label: "PENDING", tone: "warning" };
  if (s === "FAILED") return { label: "FAILED", tone: "warning" };
  if (s) return { label: s, tone: "warning" };
  return { label: "Unavailable", tone: "neutral" };
}

/** verify-v2/_helpers.ts otsTone. */
export function verifyOtsTone(status?: string | null, bitcoinTxid?: string | null): { label: string; tone: VerifyWebTone } {
  const s = (status ?? "").toUpperCase();
  const hasValidBitcoinTxid = typeof bitcoinTxid === "string" && /^[a-f0-9]{64}$/i.test(bitcoinTxid.trim());
  if (s === "ANCHORED") return hasValidBitcoinTxid ? { label: "ANCHORED", tone: "success" } : { label: "ANCHORING PENDING", tone: "warning" };
  if (s === "PENDING") return { label: "PENDING", tone: "warning" };
  if (s === "FAILED") return { label: "FAILED", tone: "warning" };
  if (s === "DISABLED") return { label: "DISABLED", tone: "neutral" };
  if (s) return { label: s, tone: "info" };
  return { label: "Unavailable", tone: "neutral" };
}

function isPositiveTsa(status?: string | null): boolean {
  return ["STAMPED", "GRANTED", "VERIFIED", "SUCCEEDED"].includes(String(status ?? "").toUpperCase());
}
function isFailedTsa(status?: string | null): boolean {
  return ["FAILED", "UNAVAILABLE", "ERROR"].includes(String(status ?? "").toUpperCase());
}

// ---------------------------------------------------------------- signals

/**
 * The integrity signals the web page derives its verdict, reviewer actions
 * and mismatch explanations from: `integrityProof` (evidence.routes.ts:13566),
 * `storageAndTimestamping.tsa|ots|storage` (:13892). The TSA status is the
 * RAW `storageAndTimestamping.tsa.status` only — the web's fallback to the
 * humanised `overview.timestampStatus` label is not repeated.
 */
export interface VerifyIntegritySignals {
  present: boolean;
  overallIntegrity: boolean | null;
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  custodyChainMode: string | null;
  custodyChainFailureReason: string | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  tsaStatus: string | null;
  otsStatus: string | null;
  storage: { immutable: boolean | null; verified: boolean | null; mode: string | null };
}

export function parseVerifyIntegritySignals(payload: unknown): VerifyIntegritySignals {
  const d = obj(payload);
  const ip = d["integrityProof"];
  const proof = obj(ip);
  const st = obj(d["storageAndTimestamping"]);
  const tsa = obj(st["tsa"]);
  const ots = obj(st["ots"]);
  const storage = obj(st["storage"]);
  return {
    present: Boolean(ip && typeof ip === "object"),
    overallIntegrity: bool(proof["overallIntegrity"]),
    canonicalHashMatches: bool(proof["canonicalHashMatches"]),
    signatureValid: bool(proof["signatureValid"]),
    custodyChainValid: bool(proof["custodyChainValid"]),
    custodyChainMode: str(proof["custodyChainMode"]),
    custodyChainFailureReason: str(proof["custodyChainFailureReason"]),
    timestampDigestMatches: bool(proof["timestampDigestMatches"]) ?? bool(tsa["digestMatchesTimestampInput"]),
    otsHashMatches: bool(proof["otsHashMatches"]) ?? bool(ots["hashMatchesFingerprintHash"]),
    tsaStatus: upper(tsa["status"]),
    otsStatus: upper(ots["status"]),
    storage: { immutable: bool(storage["immutable"]), verified: bool(storage["verified"]), mode: str(storage["mode"]) },
  };
}

// ---------------------------------------------------------- trust decision

export interface VerifyTrustSignalView {
  key: string;
  label: string;
  status: string;
  tone: VerifyWebTone;
  summary: string;
  detail: string;
  presentationLabel: string;
}
export interface VerifyTrustDecisionView {
  verdict: string | null;
  verdictLabel: string;
  narrative: string;
  confidenceLabel: string;
  primaryReason: string | null;
  publicationPostureLine: string;
  reviewerAction: string | null;
  tone: VerifyWebTone;
  presentationState: string | null;
  anchoringState: string | null;
  signals: VerifyTrustSignalView[];
}

/**
 * `trustDecision` (evidence.routes.ts:13815) — the report/package snapshot
 * when one exists, else the live shared decision. Rendered through the SAME
 * @proovra/shared getters the web TrustDecisionCard uses. A reply without a
 * decision renders no trust section: the web's client-side fallback decision
 * is not rebuilt here.
 */
export function parseVerifyTrustDecision(payload: unknown): VerifyTrustDecisionView | null {
  const t = obj(obj(payload)["trustDecision"]);
  const verdictLabel = str(t["verdictLabel"]);
  if (!verdictLabel || !Array.isArray(t["signals"])) return null;
  const verdict = str(t["verdict"]);
  const presentationState =
    str(t["presentationState"]) ??
    (verdict === "PARTIALLY_VERIFIED" ? "PARTIALLY_VERIFIED" : verdict === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : "VERIFIED_WITH_DEGRADED_SIGNALS");
  const signals: VerifyTrustSignalView[] = (t["signals"] as unknown[])
    .map((s) => obj(s))
    .filter((s) => str(s["key"]) && str(s["label"]))
    .map((s) => {
      const status = str(s["status"]) ?? "missing";
      const tone = (str(s["tone"]) ?? "neutral") as VerifyWebTone;
      return {
        key: str(s["key"]) as string,
        label: str(s["label"]) as string,
        status,
        tone,
        summary: str(s["summary"]) ?? "",
        detail: str(s["detail"]) ?? "",
        presentationLabel: getTrustSignalPresentationLabel({
          status: status as TrustDecision["signals"][number]["status"],
          tone: tone as TrustDecision["tone"],
        }),
      };
    });
  const normalized = { ...t, presentationState, signals } as unknown as TrustDecision;
  return {
    verdict,
    verdictLabel: getTrustDecisionLabel({ verdictLabel }),
    narrative: getTrustNarrative(normalized),
    confidenceLabel: getTrustDecisionConfidenceLabel({ ...t, signals } as unknown as TrustDecision),
    primaryReason: str(t["primaryReason"]),
    publicationPostureLine: `Publication posture: ${str(t["anchoringStatusLabel"]) ?? "Bitcoin anchoring status requires review"}.`,
    reviewerAction: str(t["reviewerAction"]),
    tone: getTrustDecisionPresentationTone(normalized) as VerifyWebTone,
    presentationState: str(t["presentationState"]),
    anchoringState: str(t["anchoringState"]),
    signals,
  };
}

/** Web `publicationPendingPosture` (page.tsx:3760). */
export function verifyPublicationPending(d: VerifyTrustDecisionView): boolean {
  return d.presentationState === "VERIFIED_PENDING_ANCHORING" || d.anchoringState === "pending" || d.anchoringState === "degraded";
}

/** Web `executiveBadges` (page.tsx:3765). */
export function verifyExecutiveBadges(d: VerifyTrustDecisionView): Array<{ label: string; tone: VerifyWebTone }> {
  return d.signals.map((s) => ({
    label: `${s.label}: ${s.summary}`,
    tone: s.tone === "success" ? "success" : s.tone === "warning" || s.tone === "danger" ? "warning" : "neutral",
  }));
}

export const VERIFY_TRUST_COPY = {
  pageTitle: "Evidence Trust Decision",
  pageSubtitle:
    "Review the final verification verdict, legal reliance boundary, recommended reviewer actions, cryptographic materials, custody chain, timestamping state, storage protection, and access activity associated with this evidence record.",
  overallKicker: "Overall Trust Decision",
  confidenceKicker: "Technical Confidence",
  classificationKicker: "Verification Classification",
  basisKicker: "Decision Basis",
  breakdownKicker: "Trust Signal Breakdown",
  breakdownTitle: "Why this decision was reached",
  breakdownBody:
    "These signals align the verification page with the PDF report and verification package. A failed or pending timestamp/anchoring layer does not automatically invalidate core hashes, signatures, custody records, or preserved originals.",
  supportingKicker: "Verification Signal Summary",
  supportingTitle: "Supporting Technical Signals",
  supportingBody:
    "The signals below show the recorded verification layers behind the Trust Decision above. They support forensic review, but the overall decision should be read from the classification, reviewer reliance, legal boundary, and reviewer action.",
  reviewerActionKicker: "Reviewer Action",
  reviewerActionBoundary:
    "This decision is limited to the recorded technical state. It does not prove factual truth, authorship, intent, context, or court admissibility.",
  publicationPostureKicker: "Publication Posture",
  publicationPostureBody:
    "Recorded integrity is verified, but independent public anchoring is not finalized yet. Reviewers should treat this as a conditional anchoring state and recheck anchoring later if independent public anchoring matters to the review.",
  verificationWarningKicker: "Verification Warning",
} as const;

// ----------------------------------------------------------- output context

const OUTPUT_SOURCE_LABEL: Record<string, string> = {
  REPORT_SNAPSHOT: "Report snapshot",
  VERIFICATION_PACKAGE_SNAPSHOT: "Verification package snapshot",
  PUBLIC_VERIFY_LIVE: "Live (recomputed at request time)",
  INTERNAL_OPERATIONAL_PROJECTION: "Operational projection",
  OFFLINE_PACKAGE_REVIEW: "Offline package review",
};

export interface VerifyOutputContextView {
  sourceLine: string;
  snapshotGeneratedAtUtc: string | null;
  liveObservedAtUtc: string | null;
  deltas: string[];
  legalBoundary: string | null;
}

/** `outputContext` (evidence.routes.ts:13845) → web OutputContextBadge. */
export function parseVerifyOutputContext(payload: unknown): VerifyOutputContextView | null {
  const c = obj(obj(payload)["outputContext"]);
  const outputType = str(c["outputType"]);
  if (!outputType) return null;
  return {
    sourceLine: `Verdict source: ${OUTPUT_SOURCE_LABEL[outputType] ?? outputType}`,
    snapshotGeneratedAtUtc: str(c["snapshotGeneratedAtUtc"]),
    liveObservedAtUtc: c["isLiveOutput"] === true ? str(c["liveObservedAtUtc"]) : null,
    deltas: arr(c["liveDeltaMaterials"]).filter((x): x is string => typeof x === "string"),
    legalBoundary: str(c["legalBoundary"]),
  };
}

// ------------------------------------------------ verdict / actions / issues

export interface VerifyVerdictView {
  status: "review_required" | "verified" | "partial" | "unavailable";
  label: string;
  actionRequired: string;
  legalStatement: string;
  tone: "danger" | "warning" | "success" | "neutral";
}

/** buildVerificationVerdict (page.tsx:1490), verbatim. */
export function buildVerifyVerdict(trust: VerifyTrustDecisionView | null, s: VerifyIntegritySignals): VerifyVerdictView {
  const core = trust?.signals.find((x) => x.key === "core_integrity");
  const anchoring = trust?.signals.find((x) => x.key === "bitcoin_anchoring");
  const verdictCode = trust?.verdict ?? null;
  const presentationState = trust?.presentationState ?? null;
  const coreExplicitlyVerified = core?.status === "passed";
  const publicAnchoringPending = anchoring?.status === "pending" || anchoring?.status === "partial" || presentationState === "VERIFIED_PENDING_ANCHORING";
  const timestampMismatch = isPositiveTsa(s.tsaStatus) && s.timestampDigestMatches === false;
  const timestampUnavailable = (isFailedTsa(s.tsaStatus) || !String(s.tsaStatus ?? "").trim()) && s.timestampDigestMatches !== true;
  const failedSignals = [s.canonicalHashMatches === false, s.signatureValid === false, s.custodyChainValid === false, timestampMismatch, s.otsHashMatches === false].filter(Boolean).length;
  const passedSignals = [
    s.canonicalHashMatches === true,
    s.signatureValid === true,
    s.custodyChainValid === true,
    s.timestampDigestMatches === true,
    s.otsHashMatches === true,
    s.storage.verified === true || s.storage.immutable === true,
  ].filter(Boolean).length;
  const knownSignals = [
    s.canonicalHashMatches !== null,
    s.signatureValid !== null,
    s.custodyChainValid !== null,
    s.timestampDigestMatches !== null,
    s.otsHashMatches !== null,
    s.storage.verified !== null || s.storage.immutable !== null,
  ].filter(Boolean).length;

  if (verdictCode === "REVIEW_REQUIRED" || s.overallIntegrity === false || failedSignals > 0) {
    return {
      status: "review_required",
      label: "Review Required",
      actionRequired:
        "Do not rely on this record as a finalized integrity result until the failed integrity signal is reviewed by a qualified technical or forensic reviewer.",
      legalStatement:
        "One or more returned integrity checks did not pass. This page supports review of the recorded system state, but it must not be interpreted as conclusive proof of authenticity, authorship, factual truth, legal admissibility, or absence of tampering.",
      tone: "danger",
    };
  }
  if (coreExplicitlyVerified && failedSignals === 0 && !timestampUnavailable) {
    return {
      status: "verified",
      label: trust ? trust.verdictLabel : publicAnchoringPending ? "Recorded integrity verified; Bitcoin anchoring pending" : "Recorded integrity verified",
      actionRequired: publicAnchoringPending
        ? "Reviewers may rely on the recorded integrity state, while still separately assessing authorship, factual context, relevance, and legal admissibility. Independent public anchoring is not finalized yet and should be rechecked later if public anchoring matters to the review."
        : "Reviewers may rely on the recorded integrity state, while still separately assessing authorship, factual context, relevance, and legal admissibility.",
      legalStatement: publicAnchoringPending
        ? "The available cryptographic, custody, timestamping, and storage signals returned in this verification response support the recorded integrity state. Independent public anchoring is still pending and must not be treated as finalized publication. This does not independently prove factual truth, authorship, legal admissibility, or the real-world meaning of the evidence content."
        : "The available cryptographic, custody, timestamping, and storage signals returned in this verification response support the recorded integrity state. This does not independently prove factual truth, authorship, legal admissibility, or the real-world meaning of the evidence content.",
      tone: publicAnchoringPending ? "warning" : "success",
    };
  }
  if (verdictCode === "PARTIALLY_VERIFIED" || passedSignals > 0 || knownSignals > 0) {
    return {
      status: "partial",
      label: !coreExplicitlyVerified ? "Conditional trust state" : timestampUnavailable ? "Integrity verified; trusted timestamp unavailable" : "Conditional trust state",
      actionRequired: !coreExplicitlyVerified
        ? "Core integrity materials are recorded, but the recorded-integrity state has not been finalized as explicitly verified. Use this record with limitations until that state is explicit."
        : timestampUnavailable
          ? "Core integrity checks are available, but the trusted timestamp provider did not return a usable token. Review timestamp availability before treating the evidence as timestamp-verified."
          : "Use this record with caution. Review missing, pending, or unavailable verification layers before treating the evidence as finalized.",
      legalStatement: !coreExplicitlyVerified
        ? "Core integrity materials are present, but the recorded-integrity state has not been finalized as explicitly verified. This response should not be summarized as plain verified."
        : timestampUnavailable
          ? "Available integrity checks support the recorded evidence state, but trusted timestamp verification is unavailable. No timestamp digest match or mismatch can be concluded from this response."
          : "Some verification materials were returned, but the response did not provide a complete positive integrity conclusion for every technical layer. The record should be treated as a conditional trust state until missing or pending layers are resolved.",
      tone: "warning",
    };
  }
  return {
    status: "unavailable",
    label: "Verification Unavailable",
    actionRequired: "Do not rely on this record as verified until verification materials are available and reviewed.",
    legalStatement: "The verification response did not expose enough technical material to support a complete integrity conclusion.",
    tone: "neutral",
  };
}

/** buildReviewerActions (page.tsx:1774), verbatim. */
export function buildVerifyReviewerActions(verdict: VerifyVerdictView, s: VerifyIntegritySignals): string[] {
  const actions: string[] = [];
  if (verdict.status === "review_required")
    actions.push("Treat this record as requiring technical review before relying on it as a complete integrity verification result.");
  if (s.canonicalHashMatches === false)
    actions.push(
      "Compare the displayed evidence digest against the original evidence material and confirm whether the preserved content differs from the recorded fingerprint.",
    );
  if (s.signatureValid === false)
    actions.push("Review the digital signature, signing key identifier, key version, and public key material before accepting the signature layer.");
  if (s.custodyChainValid === false)
    actions.push("Inspect the custody chain continuity. A custody-chain mismatch may indicate missing, altered, or inconsistent event linkage.");
  if (isPositiveTsa(s.tsaStatus) && s.timestampDigestMatches === false)
    actions.push(
      "Review the trusted timestamp mismatch. A timestamp digest mismatch means the timestamped digest does not match the recorded timestamp input digest.",
    );
  if (isFailedTsa(s.tsaStatus))
    actions.push(
      "Review timestamp availability. The timestamp provider did not return a usable token, so no timestamp digest match or mismatch can be concluded.",
    );
  if (s.otsHashMatches === false)
    actions.push("Review the OpenTimestamps proof and its linked hash. The OTS proof should be checked against the recorded fingerprint/hash material.");
  if (s.storage.immutable !== true && s.storage.verified !== true)
    actions.push("Confirm storage immutability or retention status before relying on the storage-protection layer.");
  if (actions.length === 0)
    actions.push(
      "Review the displayed record identity, evidence hash, custody chain, timestamping materials, and access activity before external legal or operational reliance.",
    );
  return actions;
}

/** buildMismatchExplanations (page.tsx:1849), verbatim. */
export function buildVerifyMismatchExplanations(s: VerifyIntegritySignals): Array<{ title: string; body: string; severity: "danger" | "warning" }> {
  const out: Array<{ title: string; body: string; severity: "danger" | "warning" }> = [];
  if (s.canonicalHashMatches === false)
    out.push({
      title: "Fingerprint mismatch",
      severity: "danger",
      body: "The canonical fingerprint check did not match the recorded evidence state. This is a critical integrity signal and should be reviewed before relying on the record.",
    });
  if (s.signatureValid === false)
    out.push({
      title: "Digital signature invalid",
      severity: "danger",
      body: "The recorded digital signature did not validate against the available verification material. This may affect confidence in the signed record state.",
    });
  if (s.custodyChainValid === false)
    out.push({
      title: "Custody-chain continuity issue",
      severity: "danger",
      body:
        s.custodyChainFailureReason ??
        "The custody chain reported an integrity issue. Review previous-event hashes and event hashes to determine where continuity failed.",
    });
  if (isPositiveTsa(s.tsaStatus) && s.timestampDigestMatches === false)
    out.push({
      title: "Trusted timestamp digest mismatch",
      severity: "warning",
      body: "The trusted timestamp digest does not match the recorded timestamp input digest. This does not automatically prove the content is false, but it means the timestamp layer cannot be treated as clean without review.",
    });
  if (s.otsHashMatches === false)
    out.push({
      title: "OpenTimestamps hash mismatch",
      severity: "warning",
      body: "The OpenTimestamps hash does not match the recorded fingerprint hash. The OTS proof should be manually checked against the expected digest.",
    });
  return out;
}

/** The web `mismatchMessages` (page.tsx:3455), verbatim. */
export function verifyMismatchMessages(s: VerifyIntegritySignals): string[] {
  const items: string[] = [];
  if (s.canonicalHashMatches === false) items.push("The canonical fingerprint check did not match the recorded evidence state.");
  if (s.signatureValid === false) items.push("The digital signature check failed for the recorded verification materials.");
  if (s.custodyChainValid === false)
    items.push(
      s.custodyChainFailureReason ? `The custody chain reported a mismatch: ${s.custodyChainFailureReason}` : "The custody chain reported an integrity mismatch.",
    );
  if (isPositiveTsa(s.tsaStatus) && s.timestampDigestMatches === false)
    items.push("The trusted timestamp digest did not match the recorded timestamp input digest.");
  if (isFailedTsa(s.tsaStatus))
    items.push(
      "Trusted timestamp unavailable. The timestamp provider did not return a usable token, so no timestamp digest match or mismatch can be concluded.",
    );
  if (s.otsHashMatches === false) items.push("The OpenTimestamps hash did not match the recorded fingerprint hash.");
  return items;
}

export const VERIFY_REVIEW_COPY = {
  legalKicker: "Legal Review Boundary",
  actionsKicker: "Recommended Reviewer Actions",
  actionsBody:
    "These actions help a legal, insurance, compliance, or forensic reviewer decide what must be checked before relying on this evidence record.",
  issuesKicker: "Integrity Issue Explanation",
  issuesBody: "The following issue explanations translate raw technical mismatch signals into reviewer-facing meaning.",
} as const;

// ------------------------------------------------ snapshot divergence (#7)

export interface VerifyDivergenceView {
  accessOnly: boolean;
  kicker: string;
  headline: string;
  reasons: Array<{ label: string; detail: string }>;
}

/** `trustDecisionConsistency` (evidence.routes.ts:13816) — only when it differs. */
export function parseVerifyDivergence(payload: unknown): VerifyDivergenceView | null {
  const c = obj(obj(payload)["trustDecisionConsistency"]);
  if (c["consistentWithSnapshot"] !== false) return null;
  const accessOnly = c["accessOnly"] === true;
  return {
    accessOnly,
    kicker: accessOnly ? "Live access activity update" : "Live verification status update",
    headline: accessOnly
      ? "No integrity mismatch detected. Later page views, downloads, or access activity changed after the fixed report snapshot."
      : "The live verification state differs from the fixed report snapshot. Review the technical materials if this change matters to your review.",
    reasons: arr(c["reasons"]).map((r) => {
      const o2 = obj(r);
      return { label: str(o2["label"]) ?? "Snapshot difference", detail: str(o2["detail"]) ?? "Later activity changed after the fixed snapshot." };
    }),
  };
}
export const VERIFY_DIVERGENCE_COPY = {
  boundary:
    "The trust decision shown here is sourced from the fixed snapshot taken at report or package generation time. Later activity can change the live page without necessarily changing the preserved evidence integrity state.",
  why: "Why this appears",
} as const;

// --------------------------------------------- snapshot vs live anchoring

function describeSnapshotSource(source?: string | null): string {
  switch (source) {
    case "REPORT_SNAPSHOT":
      return "Report snapshot";
    case "VERIFICATION_PACKAGE_SNAPSHOT":
      return "Verification package snapshot";
    case "LIVE_SHARED_FALLBACK":
      return "Live fallback (no fixed snapshot)";
    default:
      return "Snapshot source not recorded";
  }
}
function formatSignatureStatus(status?: string | null): string {
  const n = typeof status === "string" ? status.trim().toUpperCase() : "";
  switch (n) {
    case "SIGNED":
      return "Signed";
    case "SIGNING_UNAVAILABLE":
      return "Signing unavailable";
    case "FAILED":
      return "Signing failed";
    case "PENDING":
      return "Signing pending";
    default:
      return n ? n.replace(/_/g, " ") : "Not recorded";
  }
}

export interface VerifyAnchoringView {
  snapshotRows: Array<{ label: string; value: string }>;
  liveRows: Array<{ label: string; value: string }>;
  advanced: boolean;
  otsPending: boolean;
}

/**
 * `verificationSnapshot` + `liveAnchoring` (evidence.routes.ts:13817-13818,
 * built by public-verify-consistency.service.ts). The web renders both blocks
 * only when `verificationSnapshot` is present (page.tsx:5158).
 */
export function parseVerifyAnchoring(payload: unknown, fmt: (iso: string) => string): VerifyAnchoringView | null {
  const d = obj(payload);
  const rawSnap = d["verificationSnapshot"];
  if (!rawSnap || typeof rawSnap !== "object") return null;
  const snap = obj(rawSnap);
  const live = obj(d["liveAnchoring"]);
  const otsStatus = upper(obj(obj(d["storageAndTimestamping"])["ots"])["status"]);
  const reportVersion = num(snap["reportVersion"]);
  const packageVersion = num(snap["packageVersion"]);
  const pkgSig = obj(snap["verificationPackageSignature"]);
  const snapGen = str(snap["generatedAtUtc"]);
  const currentOts = str(live["currentOtsStatus"]) ?? otsStatus;
  const liveAnchored = str(live["otsAnchoredAtUtc"]);
  const liveUpdated = str(live["lastUpdatedAtUtc"]);
  return {
    snapshotRows: [
      { label: "Snapshot Source", value: describeSnapshotSource(str(snap["source"])) },
      { label: "Generated At", value: snapGen ? fmt(snapGen) : "Not recorded" },
      { label: "Report Version", value: reportVersion !== null ? `v${reportVersion}` : "Not recorded" },
      { label: "Package Version", value: packageVersion !== null ? `v${packageVersion}` : "Not recorded" },
      { label: "OTS Status At Generation", value: str(snap["otsStatusAtGeneration"]) ?? "Not recorded in snapshot" },
      { label: "Report Signature", value: formatSignatureStatus(str(obj(snap["reportSignature"])["status"])) },
      {
        label: "Package Manifest Signature",
        value:
          pkgSig["manifestSigned"] === true ? "Signed" : pkgSig["manifestPresent"] === true ? "Manifest present; signature not confirmed" : "Not recorded",
      },
      { label: "Snapshot Trust Decision", value: str(obj(snap["trustDecisionSnapshot"])["verdictLabel"]) ?? "No fixed trust-decision snapshot" },
    ],
    liveRows: [
      { label: "Current OTS Status", value: currentOts ?? "Not recorded" },
      { label: "Anchored At", value: liveAnchored ? fmt(liveAnchored) : "Not recorded" },
      { label: "Bitcoin Transaction", value: str(live["otsBitcoinTxid"]) ?? "Not recorded" },
      { label: "Last Anchoring Update", value: liveUpdated ? fmt(liveUpdated) : "Not recorded" },
      { label: "Latest Report", value: live["newerReportAvailable"] === true ? "Latest report available" : "No newer report recorded" },
      { label: "Latest Package", value: live["newerPackageAvailable"] === true ? "Latest package available" : "No newer package recorded" },
    ],
    advanced: live["hasAdvancedSinceSnapshot"] === true,
    otsPending: currentOts === "PENDING",
  };
}

export const VERIFY_ANCHORING_COPY = {
  snapshotKicker: "Verification package snapshot",
  snapshotBody: "This section reflects the verification package/report generated at the recorded time.",
  liveKicker: "Live anchoring status",
  liveBody: "This section reflects the current OpenTimestamps/public anchoring state and may advance after the package was generated.",
  advanced: "Anchoring has advanced since this package was generated. A newer report/package may be available.",
  otsPending:
    "OpenTimestamps public anchoring is pending. This does not invalidate recorded integrity, TSA timestamping, signature, custody, or Object Lock.",
} as const;

// -------------------------------------------------------------- redaction

const REDACTION_LIMITATION_COPY: Record<string, string> = {
  REDACTION_NEVER_MODIFIES_ORIGINAL: "The original file is never changed. A redacted copy is produced alongside it.",
  REDACTION_DERIVATIVE_IS_NOT_ORIGINAL: "A redacted copy is a separate file. It is not the original record.",
  REDACTION_APPROVAL_IS_HUMAN_JUDGEMENT: "Redactions are approved by a person. PROOVRA records that decision; it does not make it.",
  REDACTION_TRACKING_IS_PROVENANCE_ONLY:
    "Automatic detection in video is a record of what was reviewed, not a guarantee that everything sensitive was found.",
};
function humaniseCode(code: string): string {
  const spaced = code.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export interface VerifyRedactionView {
  published: boolean;
  rows: Array<{ label: string; value: string }>;
  limitations: string[];
}

/**
 * `redaction` (evidence.routes.ts:13813, verify-redaction-projection.service.ts)
 * → web VerifyRedactionSection. A null projection renders nothing — never a
 * fabricated "not redacted".
 */
export function parseVerifyRedaction(payload: unknown, fmt: (iso: string) => string): VerifyRedactionView | null {
  const r = obj(obj(payload)["redaction"]);
  if (typeof r["hasPublishedDerivative"] !== "boolean") return null;
  const rows: Array<{ label: string; value: string }> = [];
  if (r["hasPublishedDerivative"] === true) {
    const ord = num(r["publishedVersionOrdinal"]);
    rows.push({ label: "Redacted copy published", value: ord !== null ? `Version ${ord}` : "Yes" });
    const at = str(r["publishedAtUtc"]);
    if (at) rows.push({ label: "Published on", value: fmt(at) });
    rows.push({ label: "Approvals recorded", value: String(num(r["approvalCount"]) ?? 0) });
  } else {
    rows.push({ label: "Redacted copy published", value: "None" });
  }
  const vp = r["videoProvenance"];
  if (vp && typeof vp === "object") {
    rows.push({ label: "Video frames reviewed", value: String(num(obj(vp)["totalFrames"]) ?? 0) });
    rows.push({ label: "Regions approved for masking", value: String(num(obj(vp)["acceptedTracks"]) ?? 0) });
  }
  return {
    published: r["hasPublishedDerivative"] === true,
    rows,
    limitations: arr(r["limitations"])
      .filter((c): c is string => typeof c === "string")
      .map((c) => REDACTION_LIMITATION_COPY[c] ?? humaniseCode(c)),
  };
}
export const VERIFY_REDACTION_COPY = {
  title: "Redaction",
  body: "Whether a redacted copy of this record has been published, and what was reviewed before it was.",
} as const;

// ------------------------------------------------- evidence content review

export function verifyEvidenceKindLabel(kind?: string | null): string {
  switch (kind) {
    case "image":
      return "Image";
    case "video":
      return "Video";
    case "audio":
      return "Audio";
    case "pdf":
      return "PDF";
    case "text":
      return "Text";
    case "other":
      return "Other";
    default:
      return "Evidence";
  }
}
function previewRoleLabel(role?: string | null): string | null {
  switch (role) {
    case "primary_preview":
      return "Primary reviewer preview";
    case "secondary_preview":
      return "Supporting reviewer preview";
    case "download_only":
      return "Download-only access";
    case "metadata_only":
      return "Metadata-only access";
    default:
      return null;
  }
}

export interface VerifyContentItem {
  id: string;
  label: string;
  kind: string | null;
  kindLabel: string;
  roleLine: string;
  mimeType: string | null;
  sizeLabel: string | null;
  duration: string | null;
  accessRole: string | null;
  sha256: string | null;
  originalPreservationNote: string | null;
  reviewerRepresentationLabel: string | null;
  reviewerRepresentationNote: string | null;
  verificationMaterialsNote: string | null;
  viewUrl: string | null;
  downloadable: boolean;
  previewDataUrl: string | null;
  previewTextExcerpt: string | null;
  previewCaption: string | null;
}
export interface VerifyContentReviewView {
  items: VerifyContentItem[];
  defaultItemId: string;
  primaryItemId: string | null;
  rationale: string;
  sectionDescription: string | null;
  accessModeLabel: string | null;
  accessNote: string;
  privacyNote: string;
  whatChanged: string[];
}

/**
 * `evidenceContent` (evidence.routes.ts:13878; items built by
 * buildPublicEvidenceContent :3692), `contentAccessPolicy` (:13861) and
 * `contentExposureDecision` (:13862) → the web "Evidence Content Review"
 * card. Rendered only when there are items (page.tsx:5639).
 */
export function parseVerifyContentReview(payload: unknown, fmt: (iso: string) => string): VerifyContentReviewView | null {
  const d = obj(payload);
  const ec = obj(d["evidenceContent"]);
  const items: VerifyContentItem[] = [];
  for (const raw of arr(ec["items"])) {
    const it = obj(raw);
    const id = str(it["id"]);
    if (!id) continue;
    const kind = str(it["kind"]);
    const role = str(it["artifactRoleLabel"]) ?? (it["isPrimary"] === true ? "Primary evidence" : "Supporting evidence");
    const step = str(it["checklistStepLabel"])?.trim() || null;
    items.push({
      id,
      label: str(it["label"]) ?? id,
      kind,
      kindLabel: verifyEvidenceKindLabel(kind),
      roleLine: `${verifyEvidenceKindLabel(kind)} • ${step ? `${role} • ${step}` : role}`,
      mimeType: str(it["mimeType"]),
      sizeLabel: str(it["displaySizeLabel"]),
      duration: formatVerifyDuration(num(it["durationMs"])),
      accessRole: previewRoleLabel(str(it["previewRole"])),
      sha256: str(it["sha256"]),
      originalPreservationNote: str(it["originalPreservationNote"]),
      reviewerRepresentationLabel: str(it["reviewerRepresentationLabel"]),
      reviewerRepresentationNote: str(it["reviewerRepresentationNote"]),
      verificationMaterialsNote: str(it["verificationMaterialsNote"]),
      viewUrl: str(it["viewUrl"]),
      downloadable: it["downloadable"] === true,
      previewDataUrl: str(it["previewDataUrl"]),
      previewTextExcerpt: str(it["previewTextExcerpt"]),
      previewCaption: str(it["previewCaption"]),
    });
  }
  if (items.length === 0) return null;
  const summary = obj(ec["summary"]);
  const policy = obj(ec["previewPolicy"]);
  const ov = obj(d["overview"]);
  const hs = obj(d["humanSummary"]);
  const primaryId = str(obj(ec["primaryItem"])["id"]);
  const wanted = str(ec["defaultPreviewItemId"]) ?? primaryId;
  const itemCount = num(summary["itemCount"]) ?? items.length;
  const ovCount = num(ov["itemCount"]);
  const description = [
    itemCount > 1 ? "Multipart evidence package" : "Single evidence item",
    str(summary["totalSizeDisplay"]),
    ovCount !== null ? `${ovCount} item${ovCount === 1 ? "" : "s"}` : `${items.length} item${items.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  const mode = str(obj(d["contentAccessPolicy"])["mode"]);
  const privacyNotice = str(policy["privacyNotice"]);

  // "What changed since completion" (page.tsx:3507).
  const reportVersion = num(ov["reportVersion"]) ?? num(hs["reportVersion"]);
  const packageVersion = num(ov["verificationPackageVersion"]) ?? num(hs["verificationPackageVersion"]);
  const summaryVersion = num(ov["reviewerSummaryVersion"]) ?? num(hs["reviewerSummaryVersion"]);
  const generatedAt = str(ov["reportGeneratedAtUtc"]) ?? str(hs["reportGeneratedAtUtc"]);
  const verifiedAt = str(ov["lastVerifiedAtUtc"]) ?? str(hs["lastVerifiedAtUtc"]);
  const whatChanged = [
    reportVersion !== null ? `Report artifact version: ${reportVersion}.` : null,
    packageVersion !== null ? `Verification package version: ${packageVersion}.` : null,
    summaryVersion !== null ? `Reviewer summary version: ${summaryVersion}.` : null,
    generatedAt ? `Latest report generated at ${fmt(generatedAt)}.` : null,
    verifiedAt ? `Latest verification recorded at ${fmt(verifiedAt)}.` : null,
  ].filter((x): x is string => x !== null);

  return {
    items,
    defaultItemId: wanted && items.some((i) => i.id === wanted) ? wanted : items[0]!.id,
    primaryItemId: primaryId,
    rationale:
      str(policy["rationale"]) ??
      "Review the preserved evidence item here while keeping integrity, custody, and timestamp materials in the same verification record.",
    sectionDescription: description.length ? description.join(" • ") : null,
    accessModeLabel: mode
      ? mode === "full_access"
        ? "Direct evidence access"
        : mode === "preview_only"
          ? "Controlled preview access"
          : "Metadata-only verification"
      : null,
    accessNote:
      str(obj(d["contentExposureDecision"])["rationale"]) ??
      privacyNotice ??
      "Displayed content may be a reviewer-facing exposure of the preserved evidence item. Original evidence remains separately preserved and integrity-checked.",
    privacyNote: privacyNotice ?? "Any preview shown here should be interpreted together with the integrity, custody, and timestamp sections below.",
    whatChanged,
  };
}

export const VERIFY_CONTENT_COPY = {
  kicker: "Evidence Content Review",
  accessNoteKicker: "Reviewer access note",
  whatChangedKicker: "What changed since completion",
  whatChangedEmpty: "No later report, package, or reviewer-summary changes were exposed in this verification response.",
  mismatchKicker: "Timestamp / mismatch review",
  mismatchEmpty: "No explicit digest, signature, custody, timestamp, or OTS mismatches were detected in the current verification result.",
  representationKicker: "Representation note",
  representationBody:
    "This panel is intended for reviewer understanding of the preserved evidence item. The original file remains separately preserved and the technical sections below describe the recorded integrity, custody, timestamping, and publication state tied to that item.",
  selectedKicker: "Selected Evidence Item",
  openPreserved: "Open preserved evidence",
  download: "Download evidence",
  reviewerRepresentationKicker: "Reviewer representation note",
  materialsNoteKicker: "Verification materials note",
  primaryKicker: "Primary evidence item",
  jumpToPrimary: "Jump to primary item",
  notExposedTitle: "Evidence content is not directly exposed here",
  notExposedBody:
    "This verification flow can still validate the recorded integrity state, chain of custody, timestamps, and publication details even when direct evidence viewing is intentionally restricted.",
  audioBody:
    "Listen to the preserved audio item through controlled verification access. Original evidence remains separately preserved with the recorded integrity state.",
  textBody: "Text-based evidence is best opened in a dedicated tab so reviewers can inspect the original preserved file directly.",
  openText: "Open text evidence",
  otherTitle: "Preview is not available inline for this file type",
  otherBody: "The verification record still exposes the preserved file reference and integrity materials for controlled review.",
  openFile: "Open preserved file",
} as const;

// --------------------------------------------- forensic / custody narratives

export interface VerifyTimelineEvent {
  key: string;
  label: string;
  atUtc: string | null;
  summary: string;
  prevEventHash: string | null;
  eventHash: string | null;
}
type TimelineRow = VerifyTimelineEvent & { sequence: number | null };

/** stripShortHashLines (page.tsx:781). */
function stripShortHashLines(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value
    .split(/\s*•\s*|\n/g)
    .map((p) => p.trim())
    .filter((p) => {
      const l = p.toLowerCase();
      return !(l.startsWith("event hash:") || l.startsWith("prev hash:") || l.startsWith("previous hash:"));
    })
    .join(" • ")
    .trim();
  return cleaned || null;
}

function mapTimeline(list: unknown[], cat: string): TimelineRow[] {
  return list.map((raw, i) => {
    const e = obj(raw);
    const summary = stripShortHashLines(str(e["payloadSummary"]));
    const eventType = str(e["eventType"]) ?? "UNKNOWN_EVENT";
    const sequence = num(e["sequence"]);
    return {
      key: `${cat}-${sequence ?? i}-${eventType}`,
      sequence,
      label: normalizeEventLabel(eventType),
      atUtc: str(e["atUtc"]),
      summary: (summary ? maskPublicEmailsInText(summary) : "") || "No additional event summary provided.",
      prevEventHash: str(e["prevEventHash"]),
      eventHash: str(e["eventHash"]),
    };
  });
}
function sortTimeline(items: TimelineRow[]): TimelineRow[] {
  return [...items].sort((a, b) => {
    const sa = a.sequence ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sequence ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    return (a.atUtc ? new Date(a.atUtc).getTime() : 0) - (b.atUtc ? new Date(b.atUtc).getTime() : 0);
  });
}
function stripSequence(row: TimelineRow): VerifyTimelineEvent {
  return { key: row.key, label: row.label, atUtc: row.atUtc, summary: row.summary, prevEventHash: row.prevEventHash, eventHash: row.eventHash };
}

export interface VerifyCustodyView {
  present: boolean;
  forensicNarrative: string;
  accessNarrative: string;
  fullTimeline: VerifyTimelineEvent[];
  accessTimeline: VerifyTimelineEvent[];
  fullNote: string | null;
  fullCountLabel: string | null;
  accessCountLabel: string;
}

/**
 * `custodyLifecycle.forensicEvents|accessEvents` (mapPublicCustodyEvent,
 * evidence.routes.ts:4430 — carries prevEventHash / eventHash) and
 * `custodyDisplayCounts` (:13639).
 */
export function parseVerifyCustody(payload: unknown): VerifyCustodyView {
  const d = obj(payload);
  const cl = d["custodyLifecycle"];
  const lc = obj(cl);
  const countsRaw = d["custodyDisplayCounts"];
  const counts = countsRaw && typeof countsRaw === "object" ? obj(countsRaw) : null;
  const forensic = mapTimeline(arr(lc["forensicEvents"]), "forensic");
  const access = mapTimeline(arr(lc["accessEvents"]), "access");
  const full = sortTimeline([...forensic, ...access]);
  const f = forensic.length;
  const a = access.length;

  const forensicNarrative = counts
    ? `Forensic custody at report/package generation: ${num(counts["forensicAtReportGeneration"]) ?? f}. Current forensic custody events: ${num(counts["currentForensicEvents"]) ?? f}. Current access activity events: ${num(counts["currentAccessEvents"]) ?? a}. Total displayed now: ${num(counts["totalDisplayedNow"]) ?? num(counts["totalDisplayedEvents"]) ?? f + a}.`
    : f > 0
      ? `The record contains ${f} forensic custody event${f === 1 ? "" : "s"} describing integrity-relevant system activity. These events are displayed separately from later access activity.`
      : "No forensic custody events were returned in this verification record. This means this response does not provide an internal custody-event chain for the evidence record; it should not be read as proof that no handling occurred outside the recorded system workflow.";
  const accessNarrative =
    a > 0
      ? `The record contains ${a} access-related event${a === 1 ? "" : "s"} such as viewing, verification, or download activity. These events are informational and are not the same thing as forensic custody events.`
      : "No access-activity entries were returned in this response. The absence of access entries does not alter the recorded integrity outcome.";

  let orderNote: string | null = null;
  for (let i = 1; i < full.length; i += 1) {
    const prev = full[i - 1]?.atUtc;
    const cur = full[i]?.atUtc;
    if (prev && cur && new Date(cur).getTime() < new Date(prev).getTime()) {
      orderNote =
        "Timestamp order note: custody events are displayed in hash-chain sequence order. Some event timestamps may be slightly out of chronological order because system jobs complete asynchronously.";
      break;
    }
  }
  let liveNote: string | null = null;
  if (counts) {
    const after = num(counts["accessAfterReportGeneration"]);
    const cur = num(counts["currentAccessEvents"]);
    liveNote = `Counts are live and may increase after report or package generation as reviewers open, download, or verify materials.${
      after !== null && cur !== null
        ? ` Package access snapshot at generation may be lower or zero by design. Access activity after report/package generation: ${after}. Current access activity total: ${cur}.`
        : ""
    }`;
  }
  const note = [liveNote, orderNote].filter(Boolean).join(" ");
  return {
    present: Boolean((cl && typeof cl === "object") || counts),
    forensicNarrative,
    accessNarrative,
    fullTimeline: full.map(stripSequence),
    accessTimeline: access.map(stripSequence),
    fullNote: note || null,
    fullCountLabel: counts
      ? `Forensic ${num(counts["currentForensicEvents"]) ?? f} • Access ${num(counts["currentAccessEvents"]) ?? a} • Total ${num(counts["totalDisplayedNow"]) ?? num(counts["totalDisplayedEvents"]) ?? full.length}`
      : null,
    accessCountLabel: `${a} Event${a === 1 ? "" : "s"}`,
  };
}

/** The web's "Scope of this page" panel body (page.tsx:3539). */
export function verifyScopeText(payload: unknown): string {
  return (
    str(obj(obj(payload)["humanSummary"])["whatIsVerified"]) ??
    "PROOVRA preserves and verifies the recorded integrity state of the evidence record after intake. It does not prove original device-capture authenticity, factual truth, authorship, context, intent, legal admissibility, or court acceptance."
  );
}
export const VERIFY_PANEL_COPY = {
  legalOutcome: "Legal review outcome",
  custodyPosture: "Forensic custody posture",
  scope: "Scope of this page",
  scopeFooter: "Technical details, timestamping, anchoring, and access history remain available below in the technical review layer.",
} as const;

// --------------------------------------------------- technical materials

export const VERIFY_TECHNICAL_COPY = {
  title: "Technical Review Materials",
  body: "These materials support the Trust Decision shown above. The Trust Decision is the reviewer-facing summary; this technical layer exposes the raw hashes, signatures, custody-chain hashes, timestamp materials, anchoring state, and access activity for deeper forensic review.",
  forensicKicker: "Forensic Review Mode",
  forensicOn: "Raw technical materials are expanded for forensic review.",
  forensicOff: "Enable to expand raw hashes, signatures, public key material, custody hashes, and timestamp proof fields.",
  enable: "Enable Forensic Mode",
  disable: "Disable Forensic Mode",
  expand: "Expand",
  collapse: "Collapse",
  tabs: { record: "Record", integrity: "Integrity", package: "Package Integrity", custody: "Custody Chain", access: "Access Activity" },
  recordRail:
    "Core record identity, lifecycle milestones, and versioning metadata are shown here. This metadata identifies the preserved record but is separate from the cryptographic proof and from any custody-event chronology.",
  integrityScopeKicker: "Integrity scope",
  integrityScope:
    "These materials support review of the recorded file hash, canonical fingerprint, signature, timestamp linkage, OpenTimestamps proofing, immutable storage indicators, and publication state. They do not independently resolve authorship, narrative context, or admissibility.",
  multipartKicker: "Multipart integrity boundary",
  multipartBody: `${PROOVRA_MULTIPART_REVIEWER_EXPLANATION} ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE} ${PROOVRA_MULTIPART_LEGAL_BOUNDARY_NOTE}`,
  legacyMode:
    "Legacy mode: this record predates explicit timestamp-input digest storage, so timestamp verification falls back to the recorded legacy digest model.",
  tsaFailureKicker: "Timestamp Failure Reason",
  otsNoteKicker: "OpenTimestamps Status Note",
  showTechnical: "Show technical details",
  packageScopeKicker: "Package verification scope",
  packageScope:
    "Package integrity is separate from evidence integrity. Evidence integrity verifies the preserved evidence state. Package integrity verifies whether the exported forensic bundle contains the manifest, checksum index, manifest digest reference, and audit exports needed for independent review.",
  custodyTitle: "Custody Chain",
  custodySubtitle:
    "Complete recorded custody chronology, including integrity-relevant lifecycle events and later access activity when returned by the verification response. Event hashes are shown in full for chain-continuity review.",
  custodyEmptyTitle: "No custody-chain events were returned",
  custodyEmptyBody: "This verification response did not include a complete custody-event chain.",
  accessBoundaryKicker: "Access Activity Boundary",
  accessBoundary:
    "Access activity is not part of the evidence integrity verdict. It records later interaction with the verification page, files, reports, or packages and must not be treated as proof that the underlying evidence is authentic or admissible. Package access snapshots are taken at generation time; the current activity shown here is live and may include later events not present in the exported package.",
  accessTitle: "Access Activity",
  accessSubtitle:
    "Access events show later viewing, download, and verification interactions. They are informational activity records, not proof of evidence authenticity, and must not be used alone to infer integrity or legal admissibility.",
  accessEmptyTitle: "No access activity was returned",
  accessEmptyBody:
    "No access-activity entries were included in this response. Their absence does not change the recorded integrity result and should not be read as a forensic custody conclusion.",
  prevHash: "Prev Hash",
  eventHash: "Event Hash",
} as const;

/** The Integrity tab's trust-signal subset (page.tsx:6433). */
export const VERIFY_INTEGRITY_SIGNAL_KEYS = ["core_integrity", "signature", "trusted_timestamp", "bitcoin_anchoring", "immutable_storage"] as const;

function verificationStatusDisplayLabel(status?: string | null): string {
  const code = String(status ?? "").trim().toUpperCase();
  if (code === "RECORDED_INTEGRITY_VERIFIED") return "Recorded integrity state verified";
  if (code === "MATERIALS_AVAILABLE") return "Technical materials available";
  if (code === "REVIEW_REQUIRED") return "Review required";
  if (code === "FAILED") return "Verification failed";
  return code
    ? code
        .toLowerCase()
        .split("_")
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(" ")
    : "Technical materials available";
}
function integrityStatusDisplayLabel(trust: VerifyTrustDecisionView): string {
  const core = trust.signals.find((s) => s.key === "core_integrity");
  if (core?.status === "passed") return "Recorded Integrity Verified";
  if (core?.status === "partial") return "Integrity materials recorded";
  if (core?.status === "failed") return "Integrity review required";
  if (core?.status === "missing") return "Integrity materials missing";
  return "Integrity materials recorded";
}

/**
 * The Record tab (page.tsx:3854 summaryFields ∩ :4349 recordTabFields), from
 * `overview` / `humanSummary` (buildPublicVerifyOverview :4070 /
 * buildPublicVerifyHumanSummary :4262). "Submitted By" is left out: the server
 * always redacts it to null on this route (:13493), and the web's
 * maskPublicEmail(null) turns that into a false "Not recorded".
 */
export function verifyRecordFields(
  payload: unknown,
  trust: VerifyTrustDecisionView | null,
  fmt: (iso: string) => string,
): Array<{ label: string; value: string }> {
  const d = obj(payload);
  const ov = obj(d["overview"]);
  const hs = obj(d["humanSummary"]);
  const content = obj(d["evidenceContent"]);
  const summary = obj(content["summary"]);
  const items = arr(content["items"]);
  const pick = (k: string) => str(hs[k]) ?? str(ov[k]);
  const time = (k: string) => {
    const v = pick(k);
    return v ? fmt(v) : null;
  };
  const numStr = (v: number | null) => (v !== null ? String(v) : null);
  const orgVerified = bool(hs["organizationVerified"]) ?? bool(ov["organizationVerified"]);
  const generatedAt = str(ov["reportGeneratedAtUtc"]) ?? str(hs["reportGeneratedAtUtc"]);
  const verifiedAt = str(ov["lastVerifiedAtUtc"]) ?? str(hs["lastVerifiedAtUtc"]);
  const core = trust?.signals.find((s) => s.key === "core_integrity");
  const structure = str(summary["structure"]);
  const rows: Array<[string, string | null]> = [
    ["Evidence Status At Report Generation", str(ov["recordStatus"]) ?? str(hs["recordStatus"])],
    [
      "Verification Status",
      core?.status === "partial" ? "Technical materials available" : verificationStatusDisplayLabel(str(ov["verificationStatusCode"]) ?? str(ov["verificationStatus"])),
    ],
    ["Integrity Status", trust ? integrityStatusDisplayLabel(trust) : null],
    ["Trust Decision", trust ? trust.verdictLabel : null],
    ["Evidence Title", pick("evidenceTitle") ?? "Digital Evidence Record"],
    ["Evidence ID", pick("evidenceId") ?? str(d["evidenceId"])],
    [
      "Evidence Type",
      getReviewerEvidenceTypeLabel({
        itemCount: num(summary["itemCount"]) ?? num(ov["itemCount"]) ?? items.length,
        structure: structure === "single" || structure === "multipart" ? structure : null,
        imageCount: num(summary["imageCount"]),
        videoCount: num(summary["videoCount"]),
        audioCount: num(summary["audioCount"]),
        pdfCount: num(summary["pdfCount"]),
        textCount: num(summary["textCount"]),
        otherCount: num(summary["otherCount"]),
        evidenceType: str(ov["evidenceType"]) ?? str(hs["evidenceType"]),
        mimeType: str(ov["mimeType"]),
      }) || "Evidence",
    ],
    ["Evidence Structure", pick("evidenceStructure")],
    ["Auth Provider", str(hs["authProvider"]) ?? str(ov["submittedByAuthProvider"])],
    ["Identity Level", pick("identityLevel")],
    ["Organization", str(hs["organization"]) ?? str(ov["organizationName"])],
    ["Organization Verified", orgVerified === true ? "Yes" : orgVerified === false ? "No" : null],
    ["Report Version", numStr(num(ov["reportVersion"]) ?? num(hs["reportVersion"]))],
    ["Verification Package Version", numStr(num(ov["verificationPackageVersion"]) ?? num(hs["verificationPackageVersion"]))],
    ["Reviewer Summary Version", numStr(num(ov["reviewerSummaryVersion"]) ?? num(hs["reviewerSummaryVersion"]))],
    ["Created At", time("createdAt")],
    ["Captured At", time("capturedAtUtc")],
    ["Uploaded At", time("uploadedAtUtc")],
    ["Signed At", time("signedAtUtc")],
    ["Generated At", generatedAt ? fmt(generatedAt) : null],
    ["Last meaningful verification", verifiedAt ? fmt(verifiedAt) : null],
    ["Last public verify page view", time("lastPublicVerifyViewAtUtc")],
    ["Current public verify page view", time("currentPublicVerifyViewAtUtc")],
    ["File Type", str(hs["fileType"]) ?? str(ov["mimeType"])],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null).map(([label, value]) => ({ label, value }));
}

function normalizeOtsFailureMessage(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes("cannot be greater than available calendar") || lower.includes("available calendar"))
    return "OpenTimestamps proof was created, but blockchain anchoring is not available yet. The proof still needs more time to be upgraded by the calendar service.";
  if (lower.includes("not found") && (lower.includes("ots") || lower.includes("opentimestamps")))
    return "OpenTimestamps binary is not installed correctly in the worker environment.";
  if (lower.includes("timed out") || lower.includes("timeout")) return "OpenTimestamps request timed out before the calendar service returned a result.";
  if (
    lower.includes("network") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("connection")
  )
    return "OpenTimestamps service could not be reached at the time of report generation.";
  if (lower.includes("stamp") && lower.includes("failed")) return "OpenTimestamps stamping did not complete successfully for this evidence record.";
  return "OpenTimestamps processing did not complete successfully for this evidence record.";
}

/** buildStoragePresentation (page.tsx:394) — the badge label. */
function buildStoragePresentation(s: VerifyIntegritySignals["storage"]): { label: string; tone: VerifyWebTone } {
  const mode = (s.mode ?? "").trim().toUpperCase();
  if (s.immutable === true && mode === "COMPLIANCE") return { label: "Immutable Storage Locked", tone: "success" };
  if (mode === "GOVERNANCE") return { label: "Governance Retention Active", tone: "info" };
  if (s.verified === true) return { label: "Storage Protection Reported", tone: "info" };
  return { label: "Storage Protection Unverified", tone: "neutral" };
}

export interface VerifyMaterialField {
  label: string;
  subtitle: string;
  value: string;
}
export interface VerifyStatusCard {
  label: string;
  value: string;
  tone: VerifyWebTone | null;
}
export interface VerifyIntegrityTabView {
  hashField: VerifyMaterialField | null;
  multipart: boolean;
  timestampedDigest: VerifyMaterialField | null;
  legacyMode: boolean;
  otherFields: VerifyMaterialField[];
  statusCards: VerifyStatusCard[];
  tsaFailureReason: string | null;
  otsFailure: { message: string; technical: string } | null;
}

/**
 * The Integrity tab (page.tsx:6422), from `technicalMaterials` (:13654),
 * `storageAndTimestamping.tsa|ots|storage` (:13892) and `integrityProof`.
 * The web's "OpenTimestamps Proof" field is not here: it reads
 * `ots.proofBase64`, which this route never sends (only `proofPresent`).
 */
export function verifyIntegrityTab(
  payload: unknown,
  s: VerifyIntegritySignals,
  fmt: (iso: string) => string,
  verdictRequiresReview: boolean,
): VerifyIntegrityTabView {
  const d = obj(payload);
  const tm = obj(d["technicalMaterials"]);
  const st = obj(d["storageAndTimestamping"]);
  const tsa = obj(st["tsa"]);
  const ots = obj(st["ots"]);
  const itemCount = num(obj(obj(d["evidenceContent"])["summary"])["itemCount"]);
  const multipart = itemCount !== null && itemCount > 1;
  const hash = verifyFileSha256(d);
  const inputKind = str(tsa["inputKind"]) ?? str(tm["tsaInputKind"]);
  const altKind = Boolean(inputKind && inputKind !== "FILE_SHA256");
  const hashField: VerifyMaterialField | null = hash
    ? {
        label: multipart ? "Canonical Package Digest (SHA-256)" : altKind ? "File Digest (SHA-256)" : "Original File SHA-256",
        subtitle: multipart
          ? `${PROOVRA_MULTIPART_REVIEWER_EXPLANATION} ${PROOVRA_MULTIPART_RECOMPUTATION_NOTE}`
          : altKind
            ? "SHA-256 digest of the original preserved evidence file. The timestamp layer may instead reference canonical evidence or fingerprint material."
            : "SHA-256 digest of the original preserved evidence file.",
        value: hash,
      }
    : null;
  const inputDigest = str(tsa["inputDigestHex"]) ?? str(tm["tsaInputDigestHex"]);
  const timestampedDigest: VerifyMaterialField | null =
    inputDigest && inputDigest !== hash
      ? {
          label:
            str(tsa["timestampedDigestLabel"]) ??
            (multipart || String(inputKind ?? "").toUpperCase() === "CANONICAL_PACKAGE_SHA256"
              ? "Timestamped Digest / Canonical Package Digest"
              : "Timestamped Digest / Original File SHA-256"),
          subtitle:
            str(tsa["timestampedDigestNote"]) ??
            "This value may differ from the original file SHA-256 when the timestamp is applied to canonical evidence or fingerprint material.",
          value: inputDigest,
        }
      : null;
  const fp = verifyFingerprint(d);
  const sig = verifySignature(d);
  const pem = str(tm["publicKeyPem"]) ?? str(d["publicKeyPem"]);
  const otherFields: VerifyMaterialField[] = [];
  if (fp) otherFields.push({ label: "Canonical Fingerprint Hash", subtitle: "Hash derived from the canonical fingerprint record.", value: fp });
  if (sig) otherFields.push({ label: "Digital Signature", subtitle: "Recorded signature material associated with this evidence.", value: sig });
  if (pem) otherFields.push({ label: "Public Key", subtitle: "Public key material available for advanced technical review.", value: pem });

  const strong: VerifyWebTone = verdictRequiresReview ? "info" : "success";
  const tri = (v: boolean | null, yes: string, no: string, unknown: string, yesTone: VerifyWebTone = strong): Omit<VerifyStatusCard, "label"> =>
    v === true ? { value: yes, tone: yesTone } : v === false ? { value: no, tone: "warning" } : { value: unknown, tone: "neutral" };
  const storage = buildStoragePresentation(s.storage);
  const ts = verifyTimestampTone(s.tsaStatus);
  const otsT = verifyOtsTone(s.otsStatus, str(ots["bitcoinTxid"]));
  const proofPresent = bool(ots["proofPresent"]) ?? (tm["otsProofPresent"] === true ? true : null);
  const keyId = str(tm["signingKeyId"]);
  const keyVersion = num(tm["signingKeyVersion"]);
  const genTime = str(tsa["genTimeUtc"]);
  const anchoredAt = str(ots["anchoredAtUtc"]);
  const upgradedAt = str(ots["upgradedAtUtc"]);
  const text = (label: string, value: string | null): VerifyStatusCard | null => (value ? { label, value, tone: null } : null);
  const cards: Array<VerifyStatusCard | null> = [
    {
      label: "Signature Status",
      ...(s.signatureValid !== null
        ? tri(s.signatureValid, "Valid", "Invalid", "")
        : sig
          ? { value: "Present", tone: "info" as VerifyWebTone }
          : { value: "Unavailable", tone: "neutral" as VerifyWebTone }),
    },
    { label: "Fingerprint Status", ...tri(s.canonicalHashMatches, "Valid", "Invalid", "Pending") },
    {
      label: "Custody Chain",
      ...(s.custodyChainValid === true && s.custodyChainMode === "legacy"
        ? { value: "Valid (Legacy)", tone: "info" as VerifyWebTone }
        : tri(s.custodyChainValid, "Valid", "Invalid", "Pending", "success")),
    },
    { label: "OpenTimestamps", value: otsT.label, tone: otsT.tone },
    { label: "Storage Protection", value: storage.label, tone: storage.tone },
    { label: "Timestamp Status", value: ts.label, tone: ts.tone },
    text("Timestamp Provider", str(tsa["provider"])),
    text("Timestamp Time", genTime ? fmt(genTime) : null),
    text("Timestamp Serial", str(tsa["serialNumber"])),
    text("Hash Algorithm", str(tsa["hashAlgorithm"])),
    text("Signing Key", keyId),
    text("Signing Key Version", keyVersion !== null ? String(keyVersion) : null),
    text("OTS Calendar", str(ots["calendar"])),
    proofPresent !== null ? { label: "OTS Proof", value: proofPresent ? "Proof Present" : "Not Present", tone: proofPresent ? "success" : "neutral" } : null,
    text("OTS Anchored At", anchoredAt ? fmt(anchoredAt) : null),
    text("OTS Upgraded At", upgradedAt ? fmt(upgradedAt) : null),
    {
      label: "OTS Hash Check",
      value: s.otsHashMatches === true ? "Hash Matches" : s.otsHashMatches === false ? "Hash Mismatch" : "Unavailable",
      tone: s.otsHashMatches === true ? "success" : s.otsHashMatches === false ? "warning" : "neutral",
    },
  ];
  const otsReason = str(ots["failureReason"]);
  const otsMsg = normalizeOtsFailureMessage(otsReason);
  return {
    hashField,
    multipart,
    timestampedDigest,
    legacyMode: (bool(tsa["legacyMode"]) ?? bool(tm["legacyMode"])) === true,
    otherFields,
    statusCards: cards.filter((c): c is VerifyStatusCard => c !== null),
    tsaFailureReason: str(tsa["failureReason"]),
    otsFailure: otsMsg && otsReason ? { message: otsMsg, technical: otsReason.replace(/\s+/g, " ").trim() } : null,
  };
}

export interface VerifyPackageView {
  decisionLabel: string;
  decisionText: string;
  badge: string;
  tone: VerifyWebTone;
  version: string | null;
  impact: string;
  generatedAtUtc: string | null;
  rows: Array<{ label: string; value: string; tone: VerifyWebTone }>;
}

/**
 * `verificationPackageIntegrity` (evidence.routes.ts:12913-13020, sent
 * :13819) → the web VerificationPackageIntegrityCard. Exports are credited
 * ONLY when the server says so: the web additionally marks the custody /
 * access exports "Included" whenever the record merely HAS custody / access
 * events (page.tsx:497-501), which says nothing about what the package holds.
 */
export function parseVerifyPackage(payload: unknown): VerifyPackageView | null {
  const d = obj(payload);
  const raw = d["verificationPackageIntegrity"];
  if (!raw || typeof raw !== "object") return null;
  const p = obj(raw);
  const ov = obj(d["overview"]);
  const hs = obj(d["humanSummary"]);
  const version = num(p["version"]) ?? num(ov["verificationPackageVersion"]) ?? num(hs["verificationPackageVersion"]);
  const available = typeof p["available"] === "boolean" ? (p["available"] as boolean) : version !== null;
  const t = (k: string) => p[k] === true;
  const complete = available && t("manifestPresent") && t("signedManifestPresent") && t("checksumIndexPresent") && t("auditExportIncluded");
  const row = (label: string, on: boolean, yes: string) => ({ label, value: on ? yes : "Not available", tone: (on ? "success" : "neutral") as VerifyWebTone });
  return {
    decisionLabel: complete ? "Package Integrity Complete" : available ? "Package Integrity Partial" : "Package Not Generated",
    decisionText: complete
      ? "The verification package includes the complete integrity materials for independent review."
      : available
        ? "A verification package version exists, but this public response has not confirmed every package artifact."
        : "No generated verification package was exposed in this verification response.",
    badge: complete ? "Independent Review Enabled" : available ? "Partial Package" : "Unavailable",
    tone: complete ? "success" : available ? "warning" : "neutral",
    version: version !== null ? `Version v${version}` : null,
    impact: complete
      ? "The exported forensic bundle supports independent verification of package contents, checksums, manifest integrity, custody export, and audit/access materials with standard tooling."
      : "No downloadable package is available for this record, and its integrity assessment does not depend on one. The fingerprint, signature, timestamp, anchoring and custody materials are published on this page and can each be checked independently with standard tooling.",
    generatedAtUtc: str(p["generatedAtUtc"]) ?? str(ov["verificationPackageGeneratedAtUtc"]) ?? str(hs["verificationPackageGeneratedAtUtc"]),
    rows: [
      row("Package Manifest", t("manifestPresent"), "Present"),
      row("Manifest Signature", t("signedManifestPresent"), "Ed25519 signature present"),
      row("Checksum Index", t("checksumIndexPresent"), "Present"),
      row("Custody Export", t("custodyExportIncluded"), "Included"),
      row("Access / Audit Export", t("accessExportIncluded") || t("auditExportIncluded"), "Included"),
    ],
  };
}
export const VERIFY_PACKAGE_COPY = {
  kicker: "Verification Package Integrity",
  decisionKicker: "Package Decision",
  impactKicker: "Impact on Trust Decision",
  generatedAtPrefix: "Package generated at: ",
} as const;

/**
 * A custody summary as the web TimelinePanel shows it: the short hash lines
 * are stripped (the full hashes live behind Forensic Review Mode) and any
 * e-mail address is masked with the shared public mask.
 */
function publicEventSummary(raw: string | null): string | null {
  const s = stripShortHashLines(raw);
  return s ? maskPublicEmailsInText(s) : null;
}

/**
 * The header badge's tone, from the server's own status words. It was green
 * for every value — including "Review required" and a mismatch — which is
 * precisely the overclaim this page must never make.
 */
export function verifyStatusTone(label: string | null): "verified" | "risk" | "pending" {
  const l = (label ?? "").toLowerCase();
  if (/mismatch|fail|invalid|broken|tamper|revoked|not verified|unverified/.test(l)) return "risk";
  if (/^verified\b/.test(l) && !/pending|partial|review/.test(l)) return "verified";
  return "pending";
}


/* ------------------------------------------------ capture context (web verify page :4700-4860) */

export interface VerifyCaptureContext {
  statusLabel: string;
  description: string;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  /** The web's rows, in its order and words (CAPTURE_LOCATION_STATUS_LABEL … Source). */
  rows: Array<{ label: string; value: string }>;
  coordinates: string;
  externalMapUrl: string | null;
  legalBoundary: string;
}

/**
 * `captureContext` (evidence.routes.ts:13704) — present only when the record
 * carries coordinates; the web renders nothing otherwise, and neither does this.
 */
export function parseVerifyCaptureContext(data: unknown): VerifyCaptureContext | null {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const c = d.captureContext && typeof d.captureContext === "object" ? (d.captureContext as Record<string, unknown>) : null;
  if (!c || !hasCaptureLocationMetadata({ lat: c.lat as number, lng: c.lng as number })) return null;
  const s = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const lat = Number(c.lat);
  const lng = Number(c.lng);
  const at = s(c.capturedAtUtc) ?? s(c.deviceTimeIso);
  const map = s(c.externalMapUrl);
  return {
    statusLabel: s(c.statusLabel) ?? CAPTURE_LOCATION_STATUS_LABEL,
    description: s(c.description) ?? CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
    lat,
    lng,
    accuracyMeters: n(c.accuracyMeters),
    rows: [
      { label: CAPTURE_LOCATION_STATUS_LABEL, value: "Yes" },
      { label: "Latitude", value: formatCaptureLocationCoordinate(lat) },
      { label: "Longitude", value: formatCaptureLocationCoordinate(lng) },
      { label: "Accuracy radius", value: formatCaptureLocationAccuracy(n(c.accuracyMeters)) },
      { label: "Capture timestamp", value: at ?? "Not recorded" },
      { label: "Source", value: s(c.source) ?? CAPTURE_LOCATION_SOURCE_LABEL },
    ],
    coordinates: `${lat.toFixed(6)}, ${lng.toFixed(6)}`,
    externalMapUrl: map && /^https:\/\//.test(map) ? map : null,
    legalBoundary: s(c.legalBoundary) ?? CAPTURE_LOCATION_LEGAL_BOUNDARY,
  };
}
