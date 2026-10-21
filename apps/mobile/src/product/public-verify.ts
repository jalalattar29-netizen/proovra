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
  parseTsaProofStatus,
  TSA_PROOF_STATUS_LABELS,
  TSA_PROOF_STATUS_TONE,
  maskPublicEmailsInText,
  parseVerificationMatrix,
  readStoredTrustDecision,
  toVerificationStatus,
  VERIFICATION_LIMITATION,
  VERIFICATION_STATUS_LABELS,
  VERIFICATION_QUALIFIER_LABELS,
  VERIFICATION_DISCLOSURE_MODE_LABELS,
  WITHHELD_BY_DISCLOSURE_POLICY,
  parseVerificationDisclosureMode,
  parseVerificationQualifiers,
  type TrustSignalState,
  type VerificationDisclosureMode,
  type VerificationQualifier,
  type VerificationStatus,
  CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
  CAPTURE_LOCATION_LEGAL_BOUNDARY,
  CAPTURE_LOCATION_SOURCE_LABEL,
  evidenceLocationCopy,
  localizeEvidenceLocation,
  formatCaptureLocationAccuracy,
  formatCaptureLocationCoordinate,
  hasCaptureLocationMetadata,
  otsAnchoringCopy,
  type OtsState,
  liveDeltaMaterialsText,
  VERIFICATION_STATUS_TONES,
  evidenceVerificationStatusLabel,
  evidenceRecordStatusLabel,
  artifactHistoryStatusLabel,
} from "@proovra/shared";
import {
  isOtsSummaryFact,
  otsBadgeLabel,
  otsCard,
  otsCardForVerification,
  otsDetail,
  otsStateWord,
  otsStatusLine,
  otsVerificationFromAnchoringBucket,
  otsVerificationFromTrustSignal,
  readOts,
  type OtsAnchoringView,
  type OtsVerificationKey,
} from "./ots-anchoring";
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
  /** `storageAndTimestamping.ots` — the server's OtsAnchoringView (unknown → UNAVAILABLE). */
  ots: OtsAnchoringView & { calendar: string | null; proofPresent: boolean };
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
      ...readOts(ots),
      calendar: str(ots["calendar"]),
      proofPresent: ots["proofPresent"] === true || tm["otsProofPresent"] === true,
    },
    items,
    custody: forensic.map((raw) => {
      const e = obj(raw);
      return { eventType: str(e["eventType"]) ?? "EVENT", atUtc: str(e["atUtc"]), summary: publicEventSummary(str(e["payloadSummary"])) };
    }),
    // The anonymous route aggregates access activity: a count, never a list.
    accessEventCount: num(obj(custody["accessActivity"])["count"]) ?? num(custody["accessEventCount"]),
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

/**
 * THE link the verify screen shares or copies (2026-10-18): the record's
 * canonical page, `/verify/<pvr_ reference>`, read from the server's
 * `recordFacts.verificationReference` (else `canonicalVerification.reference`).
 * The identifier the page was opened with — a reviewer `pvs_` share, a legacy
 * record id — is never re-shared. No reference, or no web origin: no link.
 */
export function canonicalVerifyReference(payload: unknown): string | null {
  const d = obj(payload);
  const ref = str(obj(d["recordFacts"])["verificationReference"]) ?? str(obj(d["canonicalVerification"])["reference"]);
  return ref && /^pvr_[A-Za-z0-9_-]+$/.test(ref) ? ref : null;
}
export function canonicalVerifyShareUrl(origin: string | null, payload: unknown): string | null {
  const ref = canonicalVerifyReference(payload);
  return origin && ref ? `${origin.replace(/\/+$/, "")}/verify/${ref}` : null;
}

// ---------------------------------------------------------------------------
// CANONICAL VERIFICATION (owner decision 2026-10-14) — every record with an
// issued report has ONE permanent verification page, the same link the
// report's QR code and the package carry. Sharing from the phone shares THAT
// link: nothing is created, published or expires. (Recipient links with an
// expiry or use limit are the separate advanced feature on the web record.)
// ---------------------------------------------------------------------------

export function buildVerificationAccessPath(evidenceId: string): string {
  return `/v1/evidence/${encodeURIComponent(evidenceId)}/verification-access`;
}

export type NativeVerificationAccess = {
  status: string;
  reference: string | null;
  verifyPath: string | null;
};

/**
 * The verification-access response, read by its real keys. Only a canonical
 * `/verify/pvr_…` path is a link; anything else is no link.
 */
export function parseVerificationAccess(res: unknown): NativeVerificationAccess | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Record<string, unknown>;
  const status = typeof r["status"] === "string" ? (r["status"] as string) : null;
  if (!status) return null;
  const verifyPath = typeof r["verifyPath"] === "string" ? (r["verifyPath"] as string) : null;
  return {
    status,
    reference: typeof r["reference"] === "string" ? (r["reference"] as string) : null,
    verifyPath: verifyPath && verifyPath.startsWith("/verify/pvr_") ? verifyPath : null,
  };
}

/** What a person is told when there is no verification page to share yet. */
export const VERIFICATION_PAGE_NOT_ISSUED_COPY =
  "The verification page is created automatically with this record's first report.";

/** The absolute link on the public web origin, or null when this build has none. */
export function verifyUrlFromPath(origin: string | null, verifyPath: string): string | null {
  if (!origin) return null;
  return `${origin.replace(/\/+$/, "")}${verifyPath.startsWith("/") ? verifyPath : `/${verifyPath}`}`;
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
  // AUD-47 (2026-10-20) — THE shared record-status words, never the raw enum.
  return evidenceRecordStatusLabel(status);
}

/**
 * A raw `storageAndTimestamping.tsa.status` word, for a reply WITHOUT a
 * verification matrix only (the screen prints the matrix `tsa_token` row —
 * status, statusLabel, qualifiers — whenever the reply carries one).
 *
 * The word is a recorded lifecycle word, never a validation: a legacy
 * STAMPED / GRANTED / VERIFIED / SUCCEEDED means a token was obtained, and the
 * shared resolver reads it as "recorded, not validated". No raw word is ever a
 * success tone here; only the server's matrix can say VERIFIED.
 */
export function verifyTimestampTone(status?: string | null, proofStatus?: string | null): { label: string; tone: VerifyWebTone } {
  // AUD-14 (2026-10-20): the server's canonical proof status, in the shared
  // words and tones, whenever the reply carries it.
  const proof = parseTsaProofStatus(proofStatus ?? null);
  if (proof) return { label: TSA_PROOF_STATUS_LABELS[proof], tone: TSA_PROOF_STATUS_TONE[proof] };
  const s = (status ?? "").toUpperCase();
  // A token kept without validation is neutral, never amber; a raw FAILED
  // cannot say whether a token was refused, kept or never obtained, so it says
  // only that nothing validated.
  if (s === "STAMPED" || s === "GRANTED" || s === "VERIFIED" || s === "SUCCEEDED" || s === "RECORDED_NOT_VALIDATED")
    return { label: "Recorded, not validated", tone: "neutral" };
  if (s === "PENDING") return { label: "Pending", tone: "warning" };
  if (s === "FAILED") return { label: "Not validated", tone: "neutral" };
  // AUD-47 (2026-10-20) — an unrecognized word is never humanized into a
  // claim, and never amber: nothing is known about it.
  if (s) return { label: "Timestamp status not recognized", tone: "neutral" };
  return { label: "Unavailable", tone: "neutral" };
}

/**
 * The Bitcoin anchoring badge: the verification the server resolved
 * (`storageAndTimestamping.ots`, an OtsAnchoringView), in the locale's words.
 * CHAIN_VERIFIED is the only success (with ✓); FAILED / CHAIN_FAILED are
 * danger; an unchecked attestation reads "Bitcoin attestation recorded — Not
 * independently checked against Bitcoin", neutral.
 */
export function verifyOtsTone(
  ots: unknown,
  locale?: string | null,
): { label: string; tone: VerifyWebTone; state: OtsState; verification: OtsVerificationKey } {
  const card = otsCard(ots, locale);
  return { label: otsStatusLine(card), tone: card.tone, state: card.state, verification: card.verification };
}

// ---------------------------------------------------------------- signals

/**
 * The server's integrity booleans (`integrityProof`, evidence.routes.ts) and
 * the stored-object facts (`storageAndTimestamping.storage`), as the Integrity
 * tab prints them. Read, never combined: no verdict, reviewer action or
 * mismatch sentence is derived from them here (2026-10-18) — the matrix rows
 * state each check, and a FAILED row is the only "issue" the screen shows.
 * `tsaStatus` is the RAW word, printed only for a reply without a matrix.
 */
export interface VerifyIntegritySignals {
  present: boolean;
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  custodyChainMode: string | null;
  custodyChainFailureReason: string | null;
  tsaStatus: string | null;
  /** (2026-10-20, AUD-14) the server's canonical TSA proof status. */
  tsaProofStatus: string | null;
  storage: { immutable: boolean | null; verified: boolean | null; mode: string | null };
}

export function parseVerifyIntegritySignals(payload: unknown): VerifyIntegritySignals {
  const d = obj(payload);
  const ip = d["integrityProof"];
  const proof = obj(ip);
  const st = obj(d["storageAndTimestamping"]);
  const tsa = obj(st["tsa"]);
  const storage = obj(st["storage"]);
  return {
    present: Boolean(ip && typeof ip === "object"),
    canonicalHashMatches: bool(proof["canonicalHashMatches"]),
    signatureValid: bool(proof["signatureValid"]),
    custodyChainValid: bool(proof["custodyChainValid"]),
    custodyChainMode: str(proof["custodyChainMode"]),
    custodyChainFailureReason: str(proof["custodyChainFailureReason"]),
    tsaStatus: upper(tsa["status"]),
    tsaProofStatus: upper(tsa["proofStatus"]),
    storage: { immutable: bool(storage["immutable"]), verified: bool(storage["verified"]), mode: str(storage["mode"]) },
  };
}

// ---------------------------------------------------------- trust decision

export interface VerifyTrustSignalView {
  key: string;
  label: string;
  /** THE canonical state, re-read conservatively from older payloads. */
  state: TrustSignalState;
  /** The verification status shown: VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE. */
  status: VerificationStatus;
  tone: VerifyWebTone;
  summary: string;
  detail: string;
  /** The word the badge shows: the status itself, never a score or a verdict. */
  presentationLabel: VerificationStatus;
  /** bitcoin_anchoring only: the localized OTS status word ("Attestation recorded", "Independently verified ✓", "Pending", …). */
  statusLabel?: string;
}
export interface VerifyTrustDecisionView {
  /** The bounded summary of the signals (ends with the fixed limitation). */
  summary: string;
  publicationPostureLine: string;
  reviewerAction: string | null;
  /** A file-integrity, record-signature or custody check FAILED. */
  integrityReviewRequired: boolean;
  tone: VerifyWebTone;
  presentationState: string | null;
  anchoringState: string | null;
  signals: VerifyTrustSignalView[];
}

/** The bitcoin_anchoring signal's card: its canonical OTS verification, in the locale's words. */
function anchoringSignalCard(signal: { state: TrustSignalState; otsVerification?: unknown }, locale?: string | null) {
  return otsCardForVerification(otsVerificationFromTrustSignal(signal.state, signal.otsVerification), locale);
}

/** The tone of one verification status. VERIFIED alone is a success. */
export function verificationStatusTone(status: VerificationStatus): VerifyWebTone {
  // AUD-47 (2026-10-20) — NOT_CHECKED is neutral on every surface (THE shared VERIFICATION_STATUS_TONES): not checked is not a warning.
  return VERIFICATION_STATUS_TONES[status] ?? "neutral";
}

/**
 * `trustDecision` (evidence.routes.ts) — the report/package snapshot when one
 * exists, else the live shared decision. Read through the shared
 * `readStoredTrustDecision`, so a score, weighted points, a verdict, a
 * reliance level or a confidence in the reply (an older API, an old stored
 * snapshot) never reaches this view (evidence-claims correction 2026-10-08).
 */
export function parseVerifyTrustDecision(payload: unknown, locale?: string | null): VerifyTrustDecisionView | null {
  const decision = readStoredTrustDecision(obj(payload)["trustDecision"]);
  if (!decision) return null;
  const copy = otsAnchoringCopy(locale);
  const signals: VerifyTrustSignalView[] = decision.signals.map((s) => {
    const status = toVerificationStatus(s.state);
    return {
      key: s.key,
      label: s.key === "bitcoin_anchoring" ? copy.title : s.label,
      state: s.state,
      status,
      // Bitcoin anchoring: only CHAIN_VERIFIED is green, FAILED / CHAIN_FAILED danger, the rest neutral.
      tone: s.key === "bitcoin_anchoring" ? anchoringSignalCard(s, locale).tone : verificationStatusTone(status),
      summary: s.key === "bitcoin_anchoring" ? otsDetail(anchoringSignalCard(s, locale)) : s.summary,
      detail: s.detail,
      presentationLabel: status,
      ...(s.key === "bitcoin_anchoring" ? { statusLabel: otsBadgeLabel(anchoringSignalCard(s, locale)) } : {}),
    };
  });
  return {
    summary: decision.summary,
    publicationPostureLine: `Publication posture: ${copy.title} — ${otsCardForVerification(otsVerificationFromAnchoringBucket(decision.anchoringState), locale).status}.`,
    reviewerAction: str(decision.reviewerAction),
    integrityReviewRequired: decision.integrityReviewRequired,
    tone: decision.presentationTone as VerifyWebTone,
    presentationState: decision.presentationState,
    anchoringState: decision.anchoringState,
    signals,
  };
}

// ------------------------------------------------------ verification matrix

export interface VerifyMatrixRowView {
  key: string;
  label: string;
  status: VerificationStatus;
  /** The server's status words when they differ from the generic word (OpenTimestamps, a retained-token timestamp). */
  statusLabel?: string;
  /** The canonical OTS state, on the ots_anchoring row only. */
  otsState?: OtsState;
  /** The canonical OTS verification key, on the ots_anchoring row only. */
  otsVerification?: OtsVerificationKey;
  /** How the status came about (VERIFICATION_QUALIFIERS); never a status. */
  qualifiers?: VerificationQualifier[];
  statement: string;
  measuredAtUtc: string | null;
  tone: VerifyWebTone;
}
export interface VerifyMatrixView {
  rows: VerifyMatrixRowView[];
  /** THE headline: the bounded summary. */
  summary: string;
  /** The fixed limitation. */
  limitation: string;
}

/** Matrix rows (and their trust-signal keys) whose FAILED status puts the preserved bytes under review. */
const INTEGRITY_REVIEW_KEYS: ReadonlySet<string> = new Set([
  "file_integrity",
  "record_signature",
  "custody_chain",
  "core_integrity",
  "signature",
]);

/**
 * `verificationMatrix` (GET /public/verify/:id, BASIC and RICH tiers): the
 * per-signal statement of the record, exactly as the server computed it.
 * A reply without one gets NO matrix — the screen says the matrix is
 * unavailable; it is never rebuilt here from trust signals (2026-10-18).
 */
export function parseVerifyMatrix(payload: unknown, locale?: string | null): VerifyMatrixView | null {
  const matrix = parseVerificationMatrix(obj(payload)["verificationMatrix"]);
  if (!matrix || matrix.rows.length === 0) return null;
  return {
    rows: matrix.rows.map((r) => (r.key === "ots_anchoring" ? otsMatrixRow(r, locale) : { ...r, tone: verificationStatusTone(r.status) })),
    summary: matrix.summary,
    limitation: matrix.limitation || VERIFICATION_LIMITATION,
  };
}

/** The sentence the screen prints when the reply carries no verification matrix. */
export const VERIFY_MATRIX_UNAVAILABLE_COPY =
  "The verification matrix is unavailable in this response. No per-signal verification result is shown.";

/**
 * The Bitcoin anchoring row: the state the row carries (a legacy row without
 * one reads as UNAVAILABLE in the shared parser), in the locale's words.
 */
function otsMatrixRow(
  r: { key: string; status: VerificationStatus; measuredAtUtc: string | null; otsVerification?: unknown; statement?: string; qualifiers?: VerificationQualifier[] },
  locale?: string | null,
): VerifyMatrixRowView {
  const card = otsCardForVerification(r.otsVerification, locale);
  // The server row's English statement carries the facts (block height,
  // confirmations); another locale prints its own words without them.
  const english = otsAnchoringCopy(locale) === otsAnchoringCopy("en");
  const sentence = english && r.statement ? r.statement : card.sentence;
  return {
    key: r.key,
    label: card.title,
    status: r.status,
    statusLabel: otsBadgeLabel(card),
    otsState: card.state,
    otsVerification: card.verification,
    ...(r.qualifiers && r.qualifiers.length > 0 ? { qualifiers: r.qualifiers } : {}),
    statement: otsDetail({ sentence, secondaryStatus: card.secondaryStatus }),
    measuredAtUtc: r.measuredAtUtc,
    tone: card.tone,
  };
}

/** One matrix row by key, or null. */
export function verifyMatrixRow(matrix: VerifyMatrixView | null, key: string): VerifyMatrixRowView | null {
  return matrix?.rows.find((r) => r.key === key) ?? null;
}

/** A row's status words: the server's statusLabel, else the shared status word. */
export function verifyMatrixStatusWords(r: Pick<VerifyMatrixRowView, "status" | "statusLabel">): string {
  return r.statusLabel ?? VERIFICATION_STATUS_LABELS[r.status] ?? r.status;
}

/** A row's qualifiers in words (VERIFICATION_QUALIFIER_LABELS). */
export function verifyMatrixQualifierWords(r: Pick<VerifyMatrixRowView, "qualifiers">): string[] {
  return (r.qualifiers ?? []).map((q) => VERIFICATION_QUALIFIER_LABELS[q] ?? q);
}

/**
 * The integrity issues the screen states: the matrix rows the SERVER marked
 * FAILED — label and statement — and nothing else. A failed file-integrity,
 * record-signature or custody row is danger; any other failed row (a
 * timestamp, OpenTimestamps, a package seal) is stated by its own row and
 * does not decide the preserved bytes (the shared summary's rule).
 */
export function verifyMatrixIssues(matrix: VerifyMatrixView | null): Array<{ key: string; title: string; body: string; severity: "danger" | "warning" }> {
  return (matrix?.rows ?? [])
    .filter((r) => r.status === "FAILED")
    .map((r) => ({ key: r.key, title: r.label, body: r.statement, severity: INTEGRITY_REVIEW_KEYS.has(r.key) ? ("danger" as const) : ("warning" as const) }));
}

/** A FAILED file-integrity, record-signature or custody check, from the decision or the matrix. */
export function verifyIntegrityReviewRequired(trust: VerifyTrustDecisionView | null, matrix: VerifyMatrixView | null): boolean {
  if (trust?.integrityReviewRequired) return true;
  return Boolean(matrix?.rows.some((r) => r.status === "FAILED" && INTEGRITY_REVIEW_KEYS.has(r.key)));
}

/** Web `publicationPendingPosture` (page.tsx:3760). */
export function verifyPublicationPending(d: VerifyTrustDecisionView): boolean {
  return d.presentationState === "VERIFIED_PENDING_ANCHORING" || d.anchoringState === "pending";
}

/** Web `executiveBadges` (page.tsx:3765): each signal with its status word. */
export function verifyExecutiveBadges(d: VerifyTrustDecisionView): Array<{ label: string; tone: VerifyWebTone }> {
  return d.signals.map((s) => ({ label: `${s.label}: ${s.statusLabel ?? s.status}`, tone: s.tone }));
}

export const VERIFY_TRUST_COPY = {
  pageTitle: "Evidence Verification",
  pageSubtitle:
    "Review each verification signal, recommended reviewer actions, cryptographic materials, custody chain, timestamping state, storage protection, and access activity associated with this evidence record.",
  overallKicker: "Verification Matrix",
  summaryKicker: "Summary",
  limitationKicker: "Limitation",
  matrixBoundary:
    "Each signal is reported on its own. NOT_CHECKED means PROOVRA did not independently verify that signal. There is no overall score or verdict.",
  basisKicker: "Anchoring and Reviewer Action",
  breakdownKicker: "Signal Detail",
  breakdownTitle: "What each signal records",
  breakdownBody:
    "These signals align the verification page with the PDF report and verification package. A failed or pending timestamp/anchoring layer does not automatically invalidate core hashes, signatures, custody records, or preserved originals.",
  supportingKicker: "Verification Signal Summary",
  supportingTitle: "Supporting Technical Signals",
  supportingBody:
    "The signals below show the recorded verification layers. Each is reported on its own; read each signal's status together with the limitation above.",
  reviewerActionKicker: "Reviewer Action",
  reviewerActionBoundary: `Each status is limited to the recorded technical state. ${VERIFICATION_LIMITATION}`,
  publicationPostureKicker: "Publication Posture",
  /** The PENDING sentence of the one OTS vocabulary (the screen prints the locale's: otsAnchoringCopy). */
  publicationPostureBody: otsAnchoringCopy("en").sentences.PENDING,
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
    // AUD-48 (2026-10-20) — reader words only: an unknown source is named as
    // such and the live-delta keys are labelled (shared vocabulary).
    sourceLine: `Signals source: ${OUTPUT_SOURCE_LABEL[outputType] ?? "Unrecognized source"}`,
    snapshotGeneratedAtUtc: str(c["snapshotGeneratedAtUtc"]),
    liveObservedAtUtc: c["isLiveOutput"] === true ? str(c["liveObservedAtUtc"]) : null,
    deltas: liveDeltaMaterialsText(arr(c["liveDeltaMaterials"]).filter((x): x is string => typeof x === "string"))
      .split(", ")
      .filter(Boolean),
    legalBoundary: str(c["legalBoundary"]),
  };
}

// ------------------------------------------------------------ issues

export const VERIFY_REVIEW_COPY = {
  legalKicker: "Legal Review Boundary",
  actionsKicker: "Recommended Reviewer Action",
  issuesKicker: "Integrity Issue Explanation",
  issuesBody: "These signals were checked and FAILED, as the verification matrix states. Each is reported on its own.",
} as const;

// ------------------------------------------------ snapshot divergence (#7)

export interface VerifyDivergenceReason {
  code: string | null;
  label: string;
  detail: string;
  /** The server's tone for this reason; VERIFICATION_ADVANCED is informational. */
  tone: VerifyWebTone;
  integrityCritical: boolean;
}
export interface VerifyDivergenceView {
  accessOnly: boolean;
  /** The server said a difference is integrity-critical (or a reason is danger). */
  integrityCritical: boolean;
  kicker: string;
  headline: string;
  reasons: VerifyDivergenceReason[];
}

function consistencyTone(v: unknown): VerifyWebTone {
  return v === "danger" || v === "warning" || v === "info" ? v : "neutral";
}

/**
 * `trustDecisionConsistency` — only when the server says the live page differs
 * from the issued snapshot. Each reason is printed with the server's own label,
 * detail and tone: a VERIFICATION_ADVANCED reason is an informational
 * improvement, never an alarm. The headline never says "no integrity
 * mismatch" beside a danger or integrity-critical reason.
 */
export function parseVerifyDivergence(payload: unknown): VerifyDivergenceView | null {
  const c = obj(obj(payload)["trustDecisionConsistency"]);
  if (c["consistentWithSnapshot"] !== false) return null;
  const reasons: VerifyDivergenceReason[] = arr(c["reasons"]).map((r) => {
    const o2 = obj(r);
    const code = str(o2["code"]);
    return {
      code,
      label: str(o2["label"]) ?? "Snapshot difference",
      detail: str(o2["detail"]) ?? "The live page differs from the issued snapshot.",
      tone: code === "VERIFICATION_ADVANCED" ? "info" : consistencyTone(o2["tone"]),
      integrityCritical: o2["integrityCritical"] === true,
    };
  });
  const integrityCritical = c["integrityCritical"] === true || reasons.some((r) => r.integrityCritical || r.tone === "danger");
  const accessOnly = c["accessOnly"] === true && !integrityCritical;
  const advancedOnly = reasons.length > 0 && reasons.every((r) => r.code === "VERIFICATION_ADVANCED");
  return {
    accessOnly,
    integrityCritical,
    kicker: integrityCritical ? "Live verification status update" : advancedOnly ? "Verification advanced since issue" : accessOnly ? "Live access activity update" : "Live verification status update",
    headline: integrityCritical
      ? "The live verification state differs from the fixed report snapshot in an integrity-relevant check. Review the technical materials before relying on the record."
      : advancedOnly
        ? "A check the issued artifact stated as not yet verified has since advanced. The issued artifact keeps what was true when it was issued."
        : accessOnly
          ? "No integrity-relevant difference was reported. Later activity changed after the fixed report snapshot."
          : "The live verification state differs from the fixed report snapshot. Review the technical materials if this change matters to your review.",
    reasons,
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
  liveRows: Array<{ label: string; value: string; mono?: boolean }>;
  /** The OpenTimestamps state when the artifact was issued (`verificationSnapshot.otsVerificationAtGeneration`). */
  atIssueStatus: string;
  /** The OpenTimestamps state now: the matrix ots_anchoring row's words (else the served OTS view). */
  currentStatus: string;
  currentQualifiers: string[];
  /** The server's `liveAnchoring.advance`, in words — null unless the server says it advanced. */
  advance: string | null;
  advanced: boolean;
  otsPending: boolean;
  /** The PENDING sentence in the locale's words. */
  otsPendingSentence: string;
}

/** `liveAnchoring.advance` (otsAdvanceSinceIssue, packages/shared snapshot-comparison.ts), in words. */
export const OTS_ADVANCE_COPY: Readonly<Record<string, string>> = {
  PENDING_SINCE_ISSUE: "OpenTimestamps submission recorded after the artifact was issued.",
  ATTESTATION_RECORDED_SINCE_ISSUE: "A Bitcoin attestation was recorded after the artifact was issued; it is not independently checked against Bitcoin.",
  CHAIN_VERIFIED_SINCE_ISSUE: "Independently verified against the Bitcoin main chain after the artifact was issued. The issued artifact keeps the state it stated when it was issued.",
};

/**
 * `verificationSnapshot` + `liveAnchoring` (public-verify-consistency.service.ts).
 * Rendered only when `verificationSnapshot` is present. The at-issue state is
 * the snapshot's OTS verification; the current state is the server's matrix
 * row; "advanced" is said ONLY when the server's `liveAnchoring.advance` says
 * so — never compared here.
 */
export function parseVerifyAnchoring(
  payload: unknown,
  fmt: (iso: string) => string,
  locale?: string | null,
  matrix: VerifyMatrixView | null = null,
): VerifyAnchoringView | null {
  const d = obj(payload);
  const rawSnap = d["verificationSnapshot"];
  if (!rawSnap || typeof rawSnap !== "object") return null;
  const snap = obj(rawSnap);
  const live = obj(d["liveAnchoring"]);
  // The served OtsAnchoringView (liveAnchoring.ots when present, else
  // storageAndTimestamping.ots) supplies the facts; never re-derived from a txid or a time.
  const liveOts = obj(live["ots"]);
  const ots = otsCard(Object.keys(liveOts).length > 0 ? liveOts : obj(d["storageAndTimestamping"])["ots"], locale, fmt);
  const copy = otsAnchoringCopy(locale);
  const otsRow = verifyMatrixRow(matrix, "ots_anchoring");
  const currentStatus = otsRow ? verifyMatrixStatusWords(otsRow) : otsStatusLine(ots);
  const snapVerification = str(snap["otsVerificationAtGeneration"]);
  const snapState = str(snap["otsStatusAtGeneration"]);
  const atIssueStatus = snapVerification
    ? otsBadgeLabel(otsCardForVerification(snapVerification, locale))
    : snapState
      ? otsStateWord(snapState, locale)
      : "Not recorded in snapshot";
  const advanceCode = str(live["advance"]);
  const advance = advanceCode && advanceCode !== "NONE" ? OTS_ADVANCE_COPY[advanceCode] ?? null : null;
  const reportVersion = num(snap["reportVersion"]);
  const packageVersion = num(snap["packageVersion"]);
  // F-33 (independent forward audit) — whether the artifact this page states
  // is current, and what superseded it: the SERVER's annotation of its history
  // (annotateArtifactHistory), rendered, never re-derived.
  const history = Array.isArray(obj(d["versioning"])["history"]) ? (obj(d["versioning"])["history"] as unknown[]) : [];
  const currencyOf = (kind: "report" | "package", version: number | null): string | null => {
    if (version === null) return null;
    const entry = history.map(obj).find((h) => h["kind"] === kind && num(h["version"]) === version);
    if (!entry || typeof entry["current"] !== "boolean") return null;
    return artifactHistoryStatusLabel({ kind, current: entry["current"] as boolean, supersededByVersion: num(entry["supersededByVersion"]) });
  };
  const reportCurrency = currencyOf("report", reportVersion);
  const packageCurrency = currencyOf("package", packageVersion);
  const pkgSig = obj(snap["verificationPackageSignature"]);
  const snapGen = str(snap["generatedAtUtc"]);
  const liveUpdated = str(live["lastUpdatedAtUtc"]);
  return {
    snapshotRows: [
      { label: "Snapshot Source", value: describeSnapshotSource(str(snap["source"])) },
      { label: "Generated At", value: snapGen ? fmt(snapGen) : "Not recorded" },
      { label: "Report Version", value: reportVersion !== null ? `v${reportVersion}` : "Not recorded" },
      ...(reportCurrency ? [{ label: "Report Status", value: reportCurrency }] : []),
      { label: "Package Version", value: packageVersion !== null ? `v${packageVersion}` : "Not recorded" },
      ...(packageCurrency ? [{ label: "Package Status", value: packageCurrency }] : []),
      { label: `${copy.title} (when issued)`, value: atIssueStatus },
      { label: "Report Signature", value: formatSignatureStatus(str(obj(snap["reportSignature"])["status"])) },
      {
        label: "Package Manifest Signature",
        value:
          pkgSig["manifestSigned"] === true ? "Signed" : pkgSig["manifestPresent"] === true ? "Manifest present; signature not confirmed" : "Not recorded",
      },
      { label: "Snapshot Signal Summary", value: readStoredTrustDecision(snap["trustDecisionSnapshot"])?.summary ?? "No fixed signal snapshot" },
    ],
    liveRows: [
      { label: `${ots.title} (now)`, value: currentStatus },
      // Only the facts present; the txid only when the proof path derived it.
      ...ots.facts
        .filter(isOtsSummaryFact)
        .map((f) => ({ label: f.label, value: f.value, mono: f.mono })),
      { label: "Last Anchoring Update", value: liveUpdated ? fmt(liveUpdated) : "Not recorded" },
      { label: "Latest Report", value: live["newerReportAvailable"] === true ? "Latest report available" : "No newer report recorded" },
      { label: "Latest Package", value: live["newerPackageAvailable"] === true ? "Latest package available" : "No newer package recorded" },
    ],
    atIssueStatus,
    currentStatus,
    currentQualifiers: otsRow ? verifyMatrixQualifierWords(otsRow) : [],
    advance,
    advanced: advance !== null,
    otsPending: (otsRow?.otsState ?? ots.state) === "PENDING",
    otsPendingSentence: ots.sentence,
  };
}

export const VERIFY_ANCHORING_COPY = {
  snapshotKicker: "Verification package snapshot",
  snapshotBody: "This section reflects the verification package/report generated at the recorded time.",
  liveKicker: "Live anchoring status",
  liveBody: "This section reflects the current OpenTimestamps/public anchoring state and may advance after the package was generated.",
  otsPending: otsAnchoringCopy("en").sentences.PENDING,
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
  mismatchEmpty: "No signal is marked Failed in the verification matrix.",
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
  /** The forensic custody chronology. Access activity is never listed (2026-10-18). */
  fullTimeline: VerifyTimelineEvent[];
  fullNote: string | null;
  fullCountLabel: string | null;
  /** `custodyLifecycle.accessActivity` — an aggregate: how many, and the latest. */
  accessActivity: { count: number; latestAtUtc: string | null } | null;
  accessCountLabel: string;
}

/**
 * `custodyLifecycle.forensicEvents` (with prevEventHash / eventHash),
 * `custodyLifecycle.accessActivity {count, latestAtUtc}` and
 * `custodyDisplayCounts`. The anonymous route sends access activity as an
 * aggregate only (`accessEvents: []`); the screen prints the count and the
 * latest time, never an access chronology.
 */
export function parseVerifyCustody(payload: unknown): VerifyCustodyView {
  const d = obj(payload);
  const cl = d["custodyLifecycle"];
  const lc = obj(cl);
  const countsRaw = d["custodyDisplayCounts"];
  const counts = countsRaw && typeof countsRaw === "object" ? obj(countsRaw) : null;
  const forensic = sortTimeline(mapTimeline(arr(lc["forensicEvents"]), "forensic"));
  const activityRaw = lc["accessActivity"];
  const activity = activityRaw && typeof activityRaw === "object" ? obj(activityRaw) : null;
  const accessActivity = activity ? { count: num(activity["count"]) ?? 0, latestAtUtc: str(activity["latestAtUtc"]) } : null;
  const f = forensic.length;
  const a = accessActivity?.count ?? num(counts?.["currentAccessEvents"] ?? null) ?? 0;

  const forensicNarrative = counts
    ? `Forensic custody at report/package generation: ${num(counts["forensicAtReportGeneration"]) ?? f}. Current forensic custody events: ${num(counts["currentForensicEvents"]) ?? f}. Current access activity events: ${num(counts["currentAccessEvents"]) ?? a}.`
    : f > 0
      ? `The record contains ${f} forensic custody event${f === 1 ? "" : "s"} describing integrity-relevant system activity. These events are displayed separately from later access activity.`
      : "No forensic custody events were returned in this verification record. This means this response does not provide an internal custody-event chain for the evidence record; it should not be read as proof that no handling occurred outside the recorded system workflow.";
  const accessNarrative =
    a > 0
      ? `Access activity: ${a} event${a === 1 ? "" : "s"} such as viewing, verification, or download activity, shown as a count only. Access activity is informational and is not the same thing as forensic custody.`
      : "No access activity is recorded for this record. The absence of access activity does not alter the recorded integrity outcome.";

  let orderNote: string | null = null;
  for (let i = 1; i < forensic.length; i += 1) {
    const prev = forensic[i - 1]?.atUtc;
    const cur = forensic[i]?.atUtc;
    if (prev && cur && new Date(cur).getTime() < new Date(prev).getTime()) {
      orderNote =
        "Timestamp order note: custody events are displayed in hash-chain sequence order. Some event timestamps may be slightly out of chronological order because system jobs complete asynchronously.";
      break;
    }
  }
  let liveNote: string | null = null;
  if (counts) {
    const after = num(counts["accessAfterReportGeneration"]);
    liveNote = `Counts are live and may increase after report or package generation as reviewers open, download, or verify materials.${
      after !== null ? ` Access activity after report/package generation: ${after}.` : ""
    }`;
  }
  const note = [liveNote, orderNote].filter(Boolean).join(" ");
  return {
    present: Boolean((cl && typeof cl === "object") || counts),
    forensicNarrative,
    accessNarrative,
    fullTimeline: forensic.map(stripSequence),
    fullNote: note || null,
    fullCountLabel: counts ? `Forensic ${num(counts["currentForensicEvents"]) ?? f} • Access activity ${num(counts["currentAccessEvents"]) ?? a}` : null,
    accessActivity,
    accessCountLabel: `${a} access event${a === 1 ? "" : "s"}`,
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
  body: "These materials support the verification signals shown above. The signals are the reviewer-facing statement; this technical layer exposes the raw hashes, signatures, custody-chain hashes, timestamp materials, anchoring state, and access activity for deeper forensic review.",
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
    "The recorded forensic custody chronology: integrity-relevant lifecycle events. Access activity is shown as a count, not a list. Event hashes are shown in full for chain-continuity review.",
  custodyEmptyTitle: "No custody-chain events were returned",
  custodyEmptyBody: "This verification response did not include a complete custody-event chain.",
  accessBoundaryKicker: "Access Activity Boundary",
  accessBoundary:
    "Access activity is not part of the evidence integrity verdict. It records later interaction with the verification page, files, reports, or packages and must not be treated as proof that the underlying evidence is authentic or admissible. Package access snapshots are taken at generation time; the current activity shown here is live and may include later events not present in the exported package.",
  accessTitle: "Access Activity",
  accessSubtitle:
    "Later viewing, download, and verification interactions, aggregated: how many, and the most recent. They are informational, not proof of evidence authenticity, and must not be used alone to infer integrity or legal admissibility. The individual events are not published.",
  accessEmptyTitle: "No access activity recorded",
  accessEmptyBody:
    "No access activity is recorded for this record. Its absence does not change the recorded integrity result and should not be read as a forensic custody conclusion.",
  prevHash: "Prev Hash",
  eventHash: "Event Hash",
} as const;

/** The Integrity tab's trust-signal subset (page.tsx:6433). */
export const VERIFY_INTEGRITY_SIGNAL_KEYS = ["core_integrity", "signature", "trusted_timestamp", "bitcoin_anchoring", "immutable_storage"] as const;

// AUD-47 (2026-10-20) — THE shared label; an unknown code is "not recorded", never humanized raw.
function verificationStatusDisplayLabel(status?: string | null): string {
  return evidenceVerificationStatusLabel(status);
}
function integrityStatusDisplayLabel(trust: VerifyTrustDecisionView): string {
  const core = trust.signals.find((s) => s.key === "core_integrity");
  if (core?.state === "PASSED") return "Recorded Integrity Verified";
  if (core?.state === "FAILED") return "Integrity review required";
  if (core?.state === "UNAVAILABLE") return "Integrity materials missing";
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
      // AUD-47 — a CODE is labelled by the shared table; `verificationStatus` is
      // already the server's label (from the same table) and is shown as sent.
      core?.status === "NOT_CHECKED"
        ? "Technical materials available"
        : str(ov["verificationStatusCode"])
          ? verificationStatusDisplayLabel(str(ov["verificationStatusCode"]))
          : (str(ov["verificationStatus"]) ?? verificationStatusDisplayLabel(null)),
    ],
    ["Integrity Status", trust ? integrityStatusDisplayLabel(trust) : null],
    ["Verification Summary", trust ? trust.summary : null],
    ["Evidence Title", pick("evidenceTitle") ?? "No title recorded"],
    // The permanent reference — never an internal record id ("Evidence ID").
    ["Verification reference", canonicalVerifyReference(d)],
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
    // UC-PROV-001 — the server clock at record creation, never a capture time.
    ["Server received at", time("capturedAtUtc")],
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

/** buildStoragePresentation (page.tsx:394) — the badge label. */
function buildStoragePresentation(s: VerifyIntegritySignals["storage"]): { label: string; tone: VerifyWebTone } {
  const mode = (s.mode ?? "").trim().toUpperCase();
  // AUD-014 — "Locked" only when the API confirmed it by reading the stored
  // object (`verified`); a recorded COMPLIANCE lock is "Recorded".
  if (s.verified === true && s.immutable === true && mode === "COMPLIANCE") return { label: "Immutable Storage Locked", tone: "success" };
  if (s.immutable === true && mode === "COMPLIANCE") return { label: "Immutable Storage Recorded", tone: "info" };
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
  /** FAILED / UNAVAILABLE: the sentence with the bounded failure in words, and its code. */
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
  integrityReviewRequired: boolean,
  locale?: string | null,
  matrix: VerifyMatrixView | null = null,
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

  const strong: VerifyWebTone = integrityReviewRequired ? "info" : "success";
  const tri = (v: boolean | null, yes: string, no: string, unknown: string, yesTone: VerifyWebTone = strong): Omit<VerifyStatusCard, "label"> =>
    v === true ? { value: yes, tone: yesTone } : v === false ? { value: no, tone: "warning" } : { value: unknown, tone: "neutral" };
  const storage = buildStoragePresentation(s.storage);
  // THE timestamp status: the matrix tsa_token row (status words, qualifiers,
  // validation time); the raw word only for a reply without a matrix.
  const tsaRow = verifyMatrixRow(matrix, "tsa_token");
  const ts: { label: string; tone: VerifyWebTone } = tsaRow
    ? { label: verifyMatrixStatusWords(tsaRow), tone: tsaRow.tone }
    : verifyTimestampTone(s.tsaStatus, s.tsaProofStatus);
  const tsaQualifiers = tsaRow ? verifyMatrixQualifierWords(tsaRow) : [];
  const tsaValidatedAt =
    tsaRow && tsaRow.status === "VERIFIED" && tsaRow.qualifiers?.includes("VALIDATED_FROM_RETAINED_TOKEN") && tsaRow.measuredAtUtc
      ? fmt(tsaRow.measuredAtUtc)
      : null;
  // THE Bitcoin anchoring card (2026-10-13): the server's OtsAnchoringView.
  const otsC = otsCard(ots, locale, fmt);
  const otsFailureCode = readOts(ots).failureCode;
  const proofPresent = bool(ots["proofPresent"]) ?? (tm["otsProofPresent"] === true ? true : null);
  const keyId = str(tm["signingKeyId"]);
  const keyVersion = num(tm["signingKeyVersion"]);
  const genTime = str(tsa["genTimeUtc"]);
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
    { label: otsC.title, value: otsStatusLine(otsC), tone: otsC.tone },
    { label: "Storage Protection", value: storage.label, tone: storage.tone },
    { label: "Timestamp Status", value: ts.label, tone: ts.tone },
    tsaQualifiers.length > 0 ? text("Timestamp Qualifier", tsaQualifiers.join(" · ")) : null,
    text("Timestamp Validated At", tsaValidatedAt),
    text("Timestamp Provider", str(tsa["provider"])),
    text("Timestamp Time", genTime ? fmt(genTime) : null),
    text("Timestamp Serial", str(tsa["serialNumber"])),
    text("Hash Algorithm", str(tsa["hashAlgorithm"])),
    text("Signing Key", keyId),
    text("Signing Key Version", keyVersion !== null ? String(keyVersion) : null),
    text("OTS Calendar", str(ots["calendar"])),
    proofPresent !== null ? { label: "OTS Proof", value: proofPresent ? "Proof Present" : "Not Present", tone: "neutral" } : null,
    // Only the facts present; the txid only when the proof path derived it.
    ...otsC.facts.map((f) => text(f.label, f.value)),
    otsC.boundary ? text(otsC.label, otsC.boundary) : null,
  ];
  return {
    hashField,
    multipart,
    timestampedDigest,
    legacyMode: (bool(tsa["legacyMode"]) ?? bool(tm["legacyMode"])) === true,
    otherFields,
    statusCards: cards.filter((c): c is VerifyStatusCard => c !== null),
    tsaFailureReason: str(tsa["failureReason"]),
    otsFailure: otsC.failureLabel ? { message: `${otsC.sentence} ${otsC.failureLabel}`, technical: otsFailureCode ?? "" } : null,
  };
}

export interface VerifyPackageView {
  /** THE seal statement — the matrix package_signature row's words. */
  decisionLabel: string;
  /** The completeness statement — the matrix package_completeness row's words. */
  decisionText: string;
  /** The seal status word (VERIFICATION_STATUS_LABELS). */
  badge: string;
  sealCheck: VerificationStatus;
  completenessCheck: VerificationStatus;
  qualifiers: string[];
  tone: VerifyWebTone;
  version: string | null;
  impact: string;
  generatedAtUtc: string | null;
  rows: Array<{ label: string; value: string; tone: VerifyWebTone }>;
}

function packageCheck(v: unknown): VerificationStatus | null {
  return v === "VERIFIED" || v === "FAILED" || v === "NOT_CHECKED" || v === "NOT_APPLICABLE" || v === "UNAVAILABLE" ? v : null;
}

/**
 * `verificationPackageIntegrity` → the package card. THE decision is the
 * server's seal check (`resolvePackageSealCheck`, the matrix's
 * package_signature row): VERIFIED is the only success, FAILED is danger,
 * NOT_CHECKED prints the server's statement ("Sealed — seal not checked
 * against a published PROOVRA key.") in a warning tone — never "Complete".
 * A reply without `sealCheck` reads the matrix row; with neither, the seal is
 * UNAVAILABLE. File presence flags are printed as what the server says the
 * package holds, never as a verification, and never credited beyond it.
 */
export function parseVerifyPackage(payload: unknown): VerifyPackageView | null {
  const d = obj(payload);
  const raw = d["verificationPackageIntegrity"];
  if (!raw || typeof raw !== "object") return null;
  const p = obj(raw);
  const ov = obj(d["overview"]);
  const hs = obj(d["humanSummary"]);
  const matrix = parseVerificationMatrix(d["verificationMatrix"]);
  const sigRow = matrix?.rows.find((r) => r.key === "package_signature") ?? null;
  const compRow = matrix?.rows.find((r) => r.key === "package_completeness") ?? null;
  const sealCheck = packageCheck(p["sealCheck"]) ?? sigRow?.status ?? "UNAVAILABLE";
  const completenessCheck = packageCheck(p["completenessCheck"]) ?? compRow?.status ?? "UNAVAILABLE";
  const sealStatement =
    str(p["sealStatement"]) ?? (packageCheck(p["sealCheck"]) ? null : sigRow?.statement || null) ?? "The package seal status was not stated by this response.";
  const completenessStatement =
    str(p["completenessStatement"]) ??
    (packageCheck(p["completenessCheck"]) ? null : compRow?.statement || null) ??
    "The package completeness status was not stated by this response.";
  const version = num(p["version"]) ?? num(ov["verificationPackageVersion"]) ?? num(hs["verificationPackageVersion"]);
  const t = (k: string) => p[k] === true;
  const row = (label: string, on: boolean, yes: string) => ({ label, value: on ? yes : "Not stated", tone: "neutral" as VerifyWebTone });
  const bothVerified = sealCheck === "VERIFIED" && completenessCheck === "VERIFIED";
  return {
    decisionLabel: sealStatement,
    decisionText: completenessStatement,
    badge: VERIFICATION_STATUS_LABELS[sealCheck],
    sealCheck,
    completenessCheck,
    qualifiers: parseVerificationQualifiers(p["sealQualifiers"]).map((q) => VERIFICATION_QUALIFIER_LABELS[q] ?? q),
    tone: sealCheck === "VERIFIED" ? "success" : sealCheck === "FAILED" ? "danger" : sealCheck === "NOT_CHECKED" ? "warning" : "neutral",
    version: version !== null ? `Version v${version}` : null,
    impact: bothVerified
      ? "PROOVRA verified the package seal against its published key and checked the manifest. The exported bundle can also be checked independently with standard tooling."
      : sealCheck === "NOT_APPLICABLE"
        ? "No downloadable package is available for this record, and its integrity assessment does not depend on one. The fingerprint, signature, timestamp, anchoring and custody materials are published on this page and can each be checked independently with standard tooling."
        : "This page states only the package checks PROOVRA performed, as shown above. Check the package's seal and manifest yourself with standard tooling before relying on it.",
    generatedAtUtc: str(p["generatedAtUtc"]) ?? str(ov["verificationPackageGeneratedAtUtc"]) ?? str(hs["verificationPackageGeneratedAtUtc"]),
    rows: [
      row("Package Manifest", t("manifestPresent"), "Present"),
      row("Manifest Signature", t("signedManifestPresent"), "Signature present"),
      row("Checksum Index", t("checksumIndexPresent"), "Present"),
      row("Custody Export", t("custodyExportIncluded"), "Included"),
      row("Access Export", t("accessExportIncluded"), "Included"),
      row("Audit Export", t("auditExportIncluded"), "Included"),
    ],
  };
}
export const VERIFY_PACKAGE_COPY = {
  kicker: "Verification Package Integrity",
  decisionKicker: "Package Decision",
  impactKicker: "Impact on Verification Signals",
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

/* ------------------------------------------------ record facts, disclosure, inventory (2026-10-18) */

export interface VerifyRecordFactsView {
  /** "Verification reference" — the permanent pvr_ reference; never "Evidence ID". */
  verificationReference: string | null;
  /** The server's one description, e.g. "Multipart package · 6 items". */
  recordKindLabel: string | null;
  reportIssuedAtUtc: string | null;
  reportVersion: number | null;
  storedFileLastRecheckedAtUtc: string | null;
  /** The stored-file recheck status word, when the server sent one. */
  storedFileRecheck: string | null;
  checkedAtUtc: string | null;
  identity: {
    disclosure: "WITHHELD" | "SHOWN" | null;
    statement: string | null;
    /** The identity facts as recorded when the record was created. */
    captureTime: Array<{ label: string; value: string }>;
    /** The identity facts as the issued report stated them. */
    atReportTime: Array<{ label: string; value: string }> | null;
    atReportVersion: number | null;
  };
}

/**
 * `recordFacts` (GET /public/verify/:id) — printed as sent. A withheld
 * identity prints the server's statement ("Withheld by the record’s
 * disclosure policy"), never "Not recorded".
 */
export function parseVerifyRecordFacts(payload: unknown): VerifyRecordFactsView | null {
  const raw = obj(payload)["recordFacts"];
  if (!raw || typeof raw !== "object") return null;
  const f = obj(raw);
  const id = obj(f["identity"]);
  const ct = obj(id["captureTime"]);
  const rtRaw = id["atReportTime"];
  const rt = obj(rtRaw);
  const facts = (pairs: Array<[string, unknown]>) =>
    pairs.filter((p): p is [string, string] => typeof p[1] === "string" && p[1].length > 0).map(([label, value]) => ({ label, value }));
  const disclosure = id["disclosure"] === "WITHHELD" || id["disclosure"] === "SHOWN" ? (id["disclosure"] as "WITHHELD" | "SHOWN") : null;
  const ref = str(f["verificationReference"]);
  return {
    verificationReference: ref && ref.startsWith("pvr_") ? ref : null,
    recordKindLabel: str(f["recordKindLabel"]),
    reportIssuedAtUtc: str(f["reportIssuedAtUtc"]),
    reportVersion: num(f["reportVersion"]),
    storedFileLastRecheckedAtUtc: str(f["storedFileLastRecheckedAtUtc"]),
    storedFileRecheck: str(f["storedFileRecheck"]),
    checkedAtUtc: str(f["checkedAtUtc"]),
    identity: {
      disclosure,
      statement: str(id["statement"]),
      captureTime: facts([
        ["Account", ct["accountLabel"]],
        ["Workspace", ct["workspaceTypeLabel"]],
        ["Organization verification", ct["organizationVerificationLabel"]],
        ["Basis", ct["basisLabel"]],
      ]),
      atReportTime:
        rtRaw && typeof rtRaw === "object"
          ? facts([
              ["Identity level", rt["identityLevel"]],
              ["Sign-in provider", rt["authProvider"]],
            ])
          : null,
      atReportVersion: rtRaw && typeof rtRaw === "object" ? num(rt["reportVersion"]) : null,
    },
  };
}

export interface VerifyDisclosureView {
  mode: VerificationDisclosureMode;
  /** VERIFICATION_DISCLOSURE_MODE_LABELS — "Verification only" / "Content preview". */
  modeLabel: string;
  recordedLocation: boolean;
  source: string | null;
  originalDownload: boolean;
  withheldStatement: string;
  /** What this page shows under the disclosure the server applied, in one sentence. */
  sentence: string;
}

/**
 * `disclosure` — what the SERVER applied to this answer (the projection
 * decided it; this only says which, in words). Unknown → no notice.
 */
export function parseVerifyDisclosure(payload: unknown): VerifyDisclosureView | null {
  const d = obj(obj(payload)["disclosure"]);
  const mode = parseVerificationDisclosureMode(d["mode"]);
  if (!mode) return null;
  const withheld = str(d["withheldStatement"]) ?? WITHHELD_BY_DISCLOSURE_POLICY;
  const source = str(d["source"]);
  const via = source === "REVIEWER_SHARE" ? "this reviewer link" : "the record’s disclosure policy";
  return {
    mode,
    modeLabel: VERIFICATION_DISCLOSURE_MODE_LABELS[mode],
    recordedLocation: d["recordedLocation"] === true,
    source,
    originalDownload: d["originalDownload"] === true,
    withheldStatement: withheld,
    sentence:
      mode === "VERIFICATION_ONLY"
        ? `The complete verification result is shown. The record’s content — title, file names, previews, device time and location — is withheld by ${via}.`
        : `The complete verification result is shown with a preview of the record’s content, as ${via} allows.`,
  };
}

export interface VerifyInventoryItem {
  id: string;
  /** The server's label: "Item N" when names are withheld, the file name otherwise. */
  label: string;
  kindLabel: string;
  sizeLabel: string | null;
  sha256: string | null;
  sha256Short: string | null;
}

/** `evidenceContent.items` as an inventory: label, kind, size label and SHA-256 (truncated; copy carries the full value). */
export function parseVerifyInventory(payload: unknown): VerifyInventoryItem[] {
  const out: VerifyInventoryItem[] = [];
  arr(obj(obj(payload)["evidenceContent"])["items"]).forEach((raw, i) => {
    const it = obj(raw);
    const id = str(it["id"]) ?? `item-${i + 1}`;
    const sha = str(it["sha256"]);
    out.push({
      id,
      label: str(it["label"]) ?? `Item ${i + 1}`,
      kindLabel: verifyEvidenceKindLabel(str(it["kind"])),
      sizeLabel: str(it["displaySizeLabel"]),
      sha256: sha,
      sha256Short: sha ? (sha.length > 20 ? `${sha.slice(0, 12)}…${sha.slice(-8)}` : sha) : null,
    });
  });
  return out;
}


/* ------------------------------------------------ location state (web VerifyLocationStateSection) */

/**
 * THE canonical location state Public Verify serves (`locationState`), stated
 * when no coordinates are shown. "Location not recorded" is neutral, never a
 * failure or "blocked"; only invalid stored coordinates read as caution.
 */
export interface VerifyLocationState {
  state: string;
  label: string;
  tone: "info" | "neutral" | "warning";
  detail: string | null;
}
/** In the reader's words (en / de / ar), read from the served STATE. */
export function parseVerifyLocationState(data: unknown, locale?: string | null): VerifyLocationState | null {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const v = d.locationState && typeof d.locationState === "object" ? (d.locationState as Record<string, unknown>) : null;
  if (!v || typeof v.state !== "string" || typeof v.label !== "string") return null;
  const served: VerifyLocationState = {
    state: v.state,
    label: v.label,
    tone: v.tone === "info" || v.tone === "warning" ? v.tone : "neutral",
    detail: typeof v.detail === "string" && v.detail ? v.detail : null,
  };
  return localizeEvidenceLocation(served, locale);
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
export function parseVerifyCaptureContext(data: unknown, locale?: string | null): VerifyCaptureContext | null {
  const words = evidenceLocationCopy(locale);
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
    // Coordinates are shown only for the canonical RECORDED state.
    statusLabel: words.states.RECORDED.label,
    description: s(c.description) ?? CAPTURE_LOCATION_CONTEXT_DESCRIPTION,
    lat,
    lng,
    accuracyMeters: n(c.accuracyMeters),
    rows: [
      { label: words.heading, value: words.states.RECORDED.label },
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
