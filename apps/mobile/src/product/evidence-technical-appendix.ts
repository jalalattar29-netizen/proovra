/**
 * TECHNICAL APPENDIX — the native port of the web Technical Appendix tab
 * (apps/web/app/(app)/evidence/[id]/_tabs/EvidenceTechnicalAppendixTab.tsx and
 * technical-appendix/sections-model.ts). Pure: no React, no fetch.
 *
 * Inputs are the two responses the screen already holds:
 *   - GET /v1/evidence/:id/technical-metadata → `{ technicalMetadata }`
 *     (the INTERNAL projection; labels humanized server-side);
 *   - GET /v1/evidence/:id/review-workspace (preservation, custody, materials).
 *
 * A row whose value is not meaningful is DROPPED, never rendered hollow — the
 * web's rule (`rows()`), so a card says "not recorded" once instead of eight
 * times.
 */

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface AppendixRow {
  label: string;
  value: string;
  mono?: boolean;
  copyable?: boolean;
}

const NON_MEANINGFUL = new Set(["", "UNKNOWN", "UNAVAILABLE", "N/A", "NOT AVAILABLE", "NOT RECORDED", "NULL", "NONE"]);
function meaningful(value: string | null | undefined): boolean {
  const t = (value ?? "").trim().toUpperCase();
  return t.length > 0 && !NON_MEANINGFUL.has(t);
}
/** sections-model.ts `rows()` — drops rows whose value is not meaningful. */
export function appendixRows(items: Array<{ label: string; value: string | null | undefined; mono?: boolean; copyable?: boolean }>): AppendixRow[] {
  const out: AppendixRow[] = [];
  for (const it of items) {
    if (!meaningful(it.value)) continue;
    out.push({ label: it.label, value: String(it.value), mono: it.mono, copyable: it.copyable });
  }
  return out;
}

export function fmtBytes(size: number | null | undefined): string | null {
  if (size == null || !Number.isFinite(size) || size <= 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = size;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/* --------------------------------------------------------------- the model */

export interface TechnicalAppendixModel {
  acquisition: { isIntake: boolean; rows: AppendixRow[]; roleModel: AppendixRow[] };
  captureDevice: AppendixRow[];
  camera: AppendixRow[];
  fullExif: AppendixRow[];
  exposure: AppendixRow[];
  clientEnv: AppendixRow[];
  clientAdvanced: AppendixRow[];
  uploadSession: AppendixRow[];
  integrity: AppendixRow[];
  custodySummary: AppendixRow[];
  multipart: boolean;
  partCount: number;
}

const exifNum = (v: unknown): string | null => (v == null ? null : String(v));

export function buildTechnicalAppendix(technicalPayload: unknown, rw: unknown): TechnicalAppendixModel {
  const tm = technicalPayload && typeof technicalPayload === "object" ? o(o(technicalPayload)["technicalMetadata"]) : {};
  const root = o(rw);
  const ev = o(root["evidence"]);
  const rel = o(root["relationships"]);
  const pm = o(root["preservationMatrix"]);
  const acq = tm["acquisition"] && typeof tm["acquisition"] === "object" ? o(tm["acquisition"]) : null;
  const ce = tm["captureEnvironment"] && typeof tm["captureEnvironment"] === "object" ? o(tm["captureEnvironment"]) : null;
  const exif = tm["exif"] && typeof tm["exif"] === "object" ? o(tm["exif"]) : null;
  const ext = tm["exifExtended"] && typeof tm["exifExtended"] === "object" ? o(tm["exifExtended"]) : null;
  const perParts = arr(tm["perParts"]).map(o);
  const multipart = rel["multipart"] === true || perParts.length > 1;
  const submission = arr(acq?.["submissionStatus"]).filter((x): x is string => typeof x === "string");

  // Section 1 — Evidence Acquisition (buildAcquisitionModel).
  let acquisition: TechnicalAppendixModel["acquisition"];
  if (acq) {
    acquisition = {
      isIntake: true,
      rows: appendixRows([
        { label: "Acquisition method", value: s(acq["method"]) },
        { label: "Delivery channel", value: s(acq["deliveryChannel"]) ?? "Direct upload" },
        { label: "Submission type", value: "Remote Contributor" },
        { label: "Submission status", value: submission.length ? submission.join(" • ") : null },
        { label: "Consent", value: acq["consentAccepted"] === true ? "Accepted" : acq["consentAccepted"] === false ? "Not accepted" : "Not recorded" },
        { label: "Consent policy version", value: s(acq["consentVersion"]) },
        { label: "Submitted at (server UTC)", value: s(acq["submittedAtUtc"]) },
      ]),
      roleModel: appendixRows([
        { label: "Submitted by", value: "Remote Contributor via Secure Intake Link" },
        { label: "Contributor identity", value: "Not independently verified" },
        { label: "Link creator / requester", value: "Workspace identity recorded" },
      ]),
    };
  } else {
    const label = s(ce?.["captureMethod"]) ?? "Not recorded";
    acquisition = {
      isIntake: false,
      rows: appendixRows([
        { label: "Acquisition method", value: label },
        { label: "Delivery channel", value: label === "PROOVRA Web Upload" ? "Direct upload" : null },
        { label: "Submission type", value: label === "Not recorded" ? null : "Authenticated workspace user" },
      ]),
      roleModel: appendixRows([
        { label: "Submitted by", value: label === "Not recorded" ? null : "Authenticated workspace user" },
        { label: "Capture method", value: label },
      ]),
    };
  }

  const osLine = ce ? [s(ce["osName"]), s(ce["osVersion"])].filter(Boolean).join(" ") || null : null;
  const captureDevice = ce
    ? appendixRows([
        { label: "Operating system", value: osLine },
        { label: "Device type", value: s(ce["deviceClass"]) },
        { label: "Browser", value: [s(ce["browserName"]), s(ce["browserVersion"])].filter(Boolean).join(" ") || null },
        { label: "Submitted through", value: s(ce["captureMethod"]) },
        { label: "Timezone", value: s(ce["timezone"]) },
      ])
    : [];

  const exifApplicable = exif !== null && exif["applicable"] === true;
  const camera = exifApplicable
    ? appendixRows([
        { label: "Camera", value: s(exif!["camera"]) },
        { label: "Lens", value: s(exif!["lensModel"]) },
        { label: "EXIF original capture time", value: s(exif!["originalCaptureTime"]) },
        { label: "Resolution", value: s(exif!["resolution"]) },
        { label: "Software / editor tag", value: s(exif!["softwareTag"]) },
        { label: "EXIF GPS", value: exif!["gpsPresent"] === true ? "Present (coordinates in Location)" : "Not present" },
      ])
    : [];
  const fullExif = exifApplicable
    ? appendixRows([
        { label: "Camera", value: s(exif!["camera"]) },
        { label: "Lens", value: s(exif!["lensModel"]) },
        { label: "Original capture time", value: s(exif!["originalCaptureTime"]) },
        { label: "ISO", value: exifNum(exif!["iso"]) },
        { label: "Aperture", value: s(exif!["aperture"]) },
        { label: "Exposure time", value: s(exif!["exposureTime"]) },
        { label: "Shutter speed", value: s(exif!["shutterSpeed"]) },
        { label: "White balance", value: s(exif!["whiteBalance"]) },
        { label: "Orientation", value: exifNum(exif!["orientation"]) },
        { label: "Resolution", value: s(exif!["resolution"]) },
        { label: "Software / editor tag", value: s(exif!["softwareTag"]) },
        { label: "Flash", value: s(ext?.["flash"]) },
        { label: "Metering mode", value: s(ext?.["meteringMode"]) },
        { label: "Exposure mode", value: s(ext?.["exposureMode"]) },
        { label: "Colour space", value: s(ext?.["colorSpace"]) },
        { label: "Focal length", value: s(ext?.["focalLength"]) },
        { label: "Focal length (35mm)", value: s(ext?.["focalLength35mm"]) },
        { label: "Image unique ID", value: s(ext?.["imageUniqueId"]), mono: true, copyable: true },
      ])
    : [];
  const exposure = exifApplicable
    ? appendixRows([
        { label: "ISO", value: exifNum(exif!["iso"]) },
        { label: "Aperture", value: s(exif!["aperture"]) },
        { label: "Shutter / exposure", value: s(exif!["shutterSpeed"]) ?? s(exif!["exposureTime"]) },
        { label: "Focal length", value: s(ext?.["focalLength"]) },
        { label: "Flash", value: s(ext?.["flash"]) },
        { label: "White balance", value: s(exif!["whiteBalance"]) },
        { label: "Metering mode", value: s(ext?.["meteringMode"]) },
      ])
    : [];

  const clientEnv = ce
    ? appendixRows([
        { label: "Browser", value: s(ce["browserName"]) },
        { label: "Browser version", value: s(ce["browserVersion"]) },
        { label: "Operating system", value: osLine },
        { label: "Device type", value: s(ce["deviceClass"]) },
        { label: "Timezone", value: s(ce["timezone"]) },
        { label: "Locale / language", value: s(ce["locale"]) },
        { label: "Engine", value: s(ce["engine"]) },
        { label: "Platform", value: s(ce["platform"]) },
      ])
    : [];
  const clientAdvanced = ce
    ? appendixRows([
        { label: "Masked IP", value: s(ce["ipAddressMasked"]), mono: true },
        { label: "User-Agent hash", value: s(ce["userAgentHash"]), mono: true, copyable: true },
      ])
    : [];

  const leadItem = s(perParts.find((p) => p["role"] === "Primary")?.["filename"]) ?? s(perParts[0]?.["filename"]) ?? null;
  const totalBytes = perParts.reduce((sum, p) => sum + (n(p["sizeBytes"]) ?? 0), 0);
  const itemCount = n(ev["itemCount"]) ?? n(rel["itemCount"]);
  const partCount = perParts.length || arr(root["parts"]).length;
  const uploadSession = appendixRows([
    { label: "Acquisition", value: s(ce?.["captureMethod"]) },
    { label: "Total items", value: itemCount != null ? String(itemCount) : null },
    { label: "Multipart upload", value: multipart ? "Yes" : "No" },
    { label: "Part count", value: partCount > 0 ? String(partCount) : null },
    { label: "Total size", value: fmtBytes(totalBytes) },
    { label: "Lead item", value: leadItem },
    { label: "Upload completed", value: s(ev["uploadedAtUtc"]) },
    { label: "Submission status", value: acq && submission.length ? submission.join(" • ") : null },
    { label: "Delivery channel", value: s(acq?.["deliveryChannel"]) },
    { label: "Consent", value: acq ? (acq["consentAccepted"] === true ? "Accepted" : "Not recorded") : null },
    { label: "Submitted at (server UTC)", value: s(acq?.["submittedAtUtc"]) },
  ]);

  // Section 9 — Security & Integrity (buildIntegrityRows).
  const sig = o(pm["signature"]);
  const tsa = o(pm["tsa"]);
  const ots = o(pm["ots"]);
  const keyId = s(sig["keyId"]);
  const keyVersion = n(sig["keyVersion"]);
  const integrity = appendixRows([
    { label: "Evidence reference", value: s(ev["id"]), mono: true, copyable: true },
    { label: "Recorded integrity", value: s(pm["recordedIntegrityVerifiedAtUtc"]) ? "Recorded integrity verified" : null },
    { label: multipart ? "Canonical package digest (SHA-256)" : "Original file SHA-256", value: s(ev["fileSha256"]), mono: true, copyable: true },
    { label: "Canonical fingerprint hash", value: s(ev["fingerprintHash"]), mono: true, copyable: true },
    {
      label: "Digital signature",
      value: sig["recorded"] === true ? (sig["valid"] === true ? "Digital signature recorded" : "Digital signature recorded (verify separately)") : null,
    },
    { label: "Signing key reference", value: keyId ? `${keyId}${keyVersion != null ? ` v${keyVersion}` : ""}` : null, mono: true },
    { label: "Trusted timestamp", value: timestampStatusLabel(s(tsa["status"])) },
    { label: "Timestamp provider", value: s(tsa["provider"]) },
    { label: "Timestamp serial", value: s(ev["tsaSerialNumber"]), mono: true },
    {
      label: "OpenTimestamps / Bitcoin anchoring",
      value: anchoringStatusLabel({
        status: s(ots["effectiveStatus"]) ?? s(ots["status"]),
        bitcoinTxid: s(ots["bitcoinTxid"]),
        anchoredAtUtc: s(ots["anchoredAtUtc"]),
        proofPresent: ots["proofPresent"] === true,
      }),
    },
    { label: "Bitcoin transaction ID", value: s(ots["bitcoinTxid"]), mono: true, copyable: true },
    { label: "Immutable storage", value: objectLockLabel(s(ev["storageObjectLockMode"])) },
    { label: "Retention until", value: s(ev["storageObjectLockRetainUntilUtc"]) },
  ]);

  // Section 10 — Chain of Custody summary (buildCustodySummaryRows).
  const forensic = arr(o(root["custodyLifecycle"])["forensicEvents"]).map(o);
  const latest = forensic[forensic.length - 1];
  const chainValid = o(pm["custodyChain"])["valid"];
  const counts = o(root["custodyDisplayCounts"]);
  const forensicCount = n(counts["currentForensicEvents"]) ?? n(o(root["custodyLifecycle"])["forensicEventCount"]);
  const custodySummary = appendixRows([
    { label: "Total forensic events", value: forensicCount != null ? String(forensicCount) : null },
    { label: "First event (server UTC)", value: s(forensic[0]?.["atUtc"]) },
    { label: "Latest event (server UTC)", value: s(latest?.["atUtc"]) },
    { label: "Hash chain", value: typeof chainValid === "boolean" ? (chainValid ? "Recorded" : "Not verified") : null },
    { label: "Latest custody hash", value: s(latest?.["eventHash"]), mono: true, copyable: true },
    { label: "Current evidence status", value: s(ev["status"]) },
  ]);

  return {
    acquisition,
    captureDevice,
    camera,
    fullExif,
    exposure,
    clientEnv,
    clientAdvanced,
    uploadSession,
    integrity,
    custodySummary,
    multipart,
    partCount: perParts.length,
  };
}

/** sections-model.ts timestampStatusLabel (mirrors the PDF report). */
export function timestampStatusLabel(status: string | null): string {
  switch ((status ?? "").toUpperCase()) {
    case "STAMPED":
    case "GRANTED":
    case "VERIFIED":
    case "SUCCEEDED":
      return "Trusted timestamp recorded";
    case "PENDING":
      return "Trusted timestamp pending";
    case "UNAVAILABLE":
      return "Trusted timestamp unavailable";
    case "FAILED":
      return "Trusted timestamp attempt failed";
    default:
      return "Trusted timestamp not configured";
  }
}

/** sections-model.ts anchoringStatusLabel (txid-truthful). */
export function anchoringStatusLabel(input: { status: string | null; bitcoinTxid: string | null; anchoredAtUtc: string | null; proofPresent: boolean }): string {
  const st = (input.status ?? "").toUpperCase();
  const anchored = Boolean(input.bitcoinTxid) || Boolean(input.anchoredAtUtc);
  if (st === "ANCHORED" && anchored) return "OpenTimestamps Bitcoin anchoring verified";
  if (st === "ANCHORED" || st === "PENDING" || input.proofPresent) return "OpenTimestamps proof present; Bitcoin anchoring pending";
  if (st === "FAILED") return "OpenTimestamps anchoring failed";
  if (st === "DISABLED") return "OpenTimestamps unavailable";
  return "OpenTimestamps not configured";
}

function objectLockLabel(mode: string | null): string | null {
  switch ((mode ?? "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return null;
  }
}

/* --------------------------------------------------- the disclosure blocks */

/** EvidenceTechnicalAppendixTab.tsx:122-160 — how verification hashes are computed. */
export function buildHashRows(rw: unknown): { rows: AppendixRow[]; multipartContext: boolean } {
  const tm = o(o(o(rw)["artifactVersions"])["technicalMaterials"]);
  const hs = s(tm["hashSemantics"]);
  const manifest = s(tm["multipartManifestSha256"]);
  const imprint = s(tm["tsaInputDigestHex"]);
  return {
    rows: [
      {
        label: "Hash semantics",
        value:
          hs === "single_file"
            ? "Single-file SHA-256"
            : hs === "multipart_composite"
              ? "Multipart composite (with reproducible manifest digest)"
              : hs === "multipart_composite_legacy"
                ? "Multipart composite (legacy record — reproduce from per-part hashes in the verification package)"
                : "Not specified",
      },
      { label: "Multipart manifest SHA-256", value: manifest ?? "Not applicable / not stored", mono: Boolean(manifest), copyable: Boolean(manifest) },
      { label: "Time-stamp imprint (TSA accepted message imprint)", value: imprint ?? "TSA token not present", mono: Boolean(imprint), copyable: Boolean(imprint) },
    ],
    multipartContext: hs === "multipart_composite" || hs === "multipart_composite_legacy",
  };
}

/**
 * @proovra/shared-evidence-presentation multipart copy, VERBATIM
 * (PROOVRA_MULTIPART_REVIEWER_EXPLANATION / _RECOMPUTATION_NOTE /
 * _LEGAL_BOUNDARY_NOTE). The package is not a native dependency.
 */
export const MULTIPART_HASH_ADVISORY =
  "This evidence record contains multiple preserved files. The root integrity digest is computed from the ordered SHA-256 hashes of the included evidence parts. No single original-file hash represents the whole record. " +
  "Each part still has its own SHA-256. The multipart manifest digest can be recomputed from the ordered per-part hashes. " +
  "This verifies recorded integrity, not factual truth or original device capture authenticity.";

/** EvidenceTechnicalAppendixTab.tsx:164-190 — event counts at report time vs now. */
export function buildEventCountRows(rw: unknown): AppendixRow[] {
  const c = o(o(rw)["custodyDisplayCounts"]);
  if (Object.keys(c).length === 0) return [];
  const v = (k: string) => String(n(c[k]) ?? 0);
  return [
    { label: "Forensic events at report time", value: v("forensicAtReportGeneration") },
    { label: "Forensic events now", value: v("currentForensicEvents") },
    { label: "Access / view events after report", value: v("accessAfterReportGeneration") },
  ];
}

/** EvidenceTechnicalAppendixTab.tsx:194-217 — present only when a divergence is recorded. */
export function buildDivergenceReasons(rw: unknown): Array<{ label: string; detail: string }> | null {
  const cons = o(o(o(rw)["artifactVersions"])["trustDecisionConsistency"]);
  if (cons["consistentWithSnapshot"] !== false) return null;
  return arr(cons["reasons"]).map((raw) => {
    const r = o(raw);
    return {
      label: s(r["label"]) ?? "Snapshot difference detected",
      detail: s(r["detail"]) ?? "Review the live technical materials for the current state.",
    };
  });
}

export const TECHNICAL_APPENDIX_COPY = {
  title: "Technical Appendix • Advanced",
  subtitle: "Forensic and technical reviewer details",
  lede: "Advanced detail for forensic or technical reviewers. None of this is required to use the record — expand each block below for the underlying material.",
  contextTitle: "Technical Evidence Context",
  contextSub: "The same acquisition, device, media and integrity context recorded in the PDF report and Verification Package, presented for reviewers.",
  deviceAdvisory:
    "Device and browser values are reported by the client environment. They may support context, but do not independently prove physical presence, authorship, truth, or admissibility.",
  rawClientAdvisory: "The raw User-Agent and IP are never stored — only a hash and a masked IP are retained.",
  eventCountsAdvisory:
    "Forensic custody events are technical chain events (creation, signature, retention, timestamp). Access events are read-only views and downloads. The two are kept separate so the chain is not diluted by analytics traffic.",
  divergenceAdvisory:
    "The trust decision shown elsewhere is sourced from the fixed snapshot taken at report or package generation time. The reasons below explain what changed later in the live state.",
  loadFailed: "Some technical metadata could not be loaded. Integrity and custody context above is unaffected.",
  noExif: "No EXIF camera metadata recorded for this item.",
  integrityAdvisory:
    "These values summarize the recorded integrity state. Full signature, RFC 3161 timestamp token, and OpenTimestamps proofs are preserved in the Verification Package and the verification endpoint.",
} as const;
