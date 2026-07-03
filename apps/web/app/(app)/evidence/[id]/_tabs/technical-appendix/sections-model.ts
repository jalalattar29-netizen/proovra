/**
 * Pure, unit-testable model builders for the Technical Appendix.
 *
 * These functions take already-humanized projection data (+ the review
 * workspace preservation/custody objects) and return filtered display rows.
 * They never emit raw enum tokens and never render hollow rows: a field that
 * is null / empty / "unknown" is dropped so the card shows a clear empty
 * state instead.
 *
 * Consistency: integrity/anchoring wording mirrors the PDF report + shared
 * trust-decision labels. Legacy anchoring/receipt vocabulary and
 * content-credential acronyms are intentionally excluded.
 */

import type { AppendixRow, TechnicalMetadataInternal } from "./types";

const NON_MEANINGFUL = new Set([
  "",
  "UNKNOWN",
  "UNAVAILABLE",
  "N/A",
  "NOT AVAILABLE",
  "NOT RECORDED",
  "NULL",
  "NONE",
]);

function meaningful(value: string | null | undefined): boolean {
  const t = (value ?? "").trim().toUpperCase();
  return t.length > 0 && !NON_MEANINGFUL.has(t);
}

/** Build a filtered row list — drops rows whose value is not meaningful. */
export function rows(
  items: Array<Omit<AppendixRow, "value"> & { value: string | null | undefined }>,
): AppendixRow[] {
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
  let n = size;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function fmtDurationMs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return null;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function fmtDimensions(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (width == null || height == null || width <= 0 || height <= 0) return null;
  return `${width}×${height}`;
}

export function shortHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  const h = hash.trim();
  if (h.length <= 20) return h;
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

// =============================================================================
// Section 1 — Evidence Acquisition
// =============================================================================

export type AcquisitionModel = {
  isIntake: boolean;
  rows: AppendixRow[];
  /** Role model shown as a distinct sub-block (intake vs capture). */
  roleModel: AppendixRow[];
};

export function isIntakeEvidence(
  tm: Pick<TechnicalMetadataInternal, "acquisition"> | null,
): boolean {
  return Boolean(tm?.acquisition);
}

export function buildAcquisitionModel(
  tm: TechnicalMetadataInternal | null,
): AcquisitionModel {
  const acq = tm?.acquisition ?? null;
  const ce = tm?.captureEnvironment ?? null;

  if (acq) {
    // Secure Intake Link path.
    return {
      isIntake: true,
      rows: rows([
        { label: "Acquisition method", value: acq.method },
        { label: "Delivery channel", value: acq.deliveryChannel ?? "Direct upload" },
        { label: "Submission type", value: "Remote Contributor" },
        {
          label: "Submission status",
          value: acq.submissionStatus.length ? acq.submissionStatus.join(" • ") : null,
        },
        {
          label: "Consent",
          value:
            acq.consentAccepted === true
              ? "Accepted"
              : acq.consentAccepted === false
                ? "Not accepted"
                : "Not recorded",
        },
        { label: "Consent policy version", value: acq.consentVersion },
        { label: "Submitted at (server UTC)", value: acq.submittedAtUtc },
      ]),
      roleModel: rows([
        {
          label: "Submitted by",
          value: "Remote Contributor via Secure Intake Link",
        },
        { label: "Contributor identity", value: "Not independently verified" },
        {
          label: "Link creator / requester",
          value: "Workspace identity recorded",
        },
      ]),
    };
  }

  // Normal Capture Page / Web Upload path.
  return {
    isIntake: false,
    rows: rows([
      {
        label: "Acquisition method",
        value: ce?.captureMethod ?? "PROOVRA Web Upload",
      },
      {
        label: "Delivery channel",
        value: "Direct upload",
      },
      { label: "Submission type", value: "Authenticated workspace user" },
      { label: "Submitted through", value: ce?.uploadSource },
    ]),
    roleModel: rows([
      { label: "Submitted by", value: "Authenticated workspace user" },
      {
        label: "Capture method",
        value: ce?.captureMethod ?? "PROOVRA Web Upload",
      },
    ]),
  };
}

// =============================================================================
// Section 2 — Capture Device
// =============================================================================

export function buildCaptureDeviceRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const ce = tm?.captureEnvironment ?? null;
  if (!ce) return [];
  return rows([
    {
      label: "Operating system",
      value: [ce.osName, ce.osVersion].filter(Boolean).join(" ") || null,
    },
    { label: "Device type", value: ce.deviceClass },
    {
      label: "Browser",
      value: [ce.browserName, ce.browserVersion].filter(Boolean).join(" ") || null,
    },
    { label: "Submitted through", value: ce.uploadSource },
    { label: "Capture method", value: ce.captureMethod },
    { label: "Timezone", value: ce.timezone },
  ]);
}

// =============================================================================
// Section 3 — Camera / EXIF (representative)
// =============================================================================

export function buildCameraRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const exif = tm?.exif ?? null;
  if (!exif || !exif.applicable) return [];
  return rows([
    { label: "Camera", value: exif.camera },
    { label: "Lens", value: exif.lensModel },
    { label: "EXIF original capture time", value: exif.originalCaptureTime },
    { label: "Resolution", value: exif.resolution },
    { label: "Software / editor tag", value: exif.softwareTag },
    {
      label: "EXIF GPS",
      value: exif.gpsPresent ? "Present (coordinates in Location)" : "Not present",
    },
  ]);
}

/** Full representative EXIF for the expandable accordion. */
export function buildFullExifRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const exif = tm?.exif ?? null;
  const ext = tm?.exifExtended ?? null;
  if (!exif || !exif.applicable) return [];
  return rows([
    { label: "Camera", value: exif.camera },
    { label: "Lens", value: exif.lensModel },
    { label: "Original capture time", value: exif.originalCaptureTime },
    { label: "ISO", value: exif.iso != null ? String(exif.iso) : null },
    { label: "Aperture", value: exif.aperture },
    { label: "Exposure time", value: exif.exposureTime },
    { label: "Shutter speed", value: exif.shutterSpeed },
    { label: "White balance", value: exif.whiteBalance },
    {
      label: "Orientation",
      value: exif.orientation != null ? String(exif.orientation) : null,
    },
    { label: "Resolution", value: exif.resolution },
    { label: "Software / editor tag", value: exif.softwareTag },
    { label: "Flash", value: ext?.flash },
    { label: "Metering mode", value: ext?.meteringMode },
    { label: "Exposure mode", value: ext?.exposureMode },
    { label: "Colour space", value: ext?.colorSpace },
    { label: "Focal length", value: ext?.focalLength },
    { label: "Focal length (35mm)", value: ext?.focalLength35mm },
    { label: "Image unique ID", value: ext?.imageUniqueId, mono: true, copyable: true },
  ]);
}

// =============================================================================
// Section 4 — Exposure
// =============================================================================

export function buildExposureRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const exif = tm?.exif ?? null;
  const ext = tm?.exifExtended ?? null;
  if (!exif || !exif.applicable) return [];
  return rows([
    { label: "ISO", value: exif.iso != null ? String(exif.iso) : null },
    { label: "Aperture", value: exif.aperture },
    { label: "Shutter / exposure", value: exif.shutterSpeed ?? exif.exposureTime },
    { label: "Focal length", value: ext?.focalLength },
    { label: "Flash", value: ext?.flash },
    { label: "White balance", value: exif.whiteBalance },
    { label: "Metering mode", value: ext?.meteringMode },
  ]);
}

// =============================================================================
// Section 6 — Client / Browser Environment
// =============================================================================

export function buildClientEnvRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const ce = tm?.captureEnvironment ?? null;
  if (!ce) return [];
  return rows([
    { label: "Browser", value: ce.browserName },
    { label: "Browser version", value: ce.browserVersion },
    {
      label: "Operating system",
      value: [ce.osName, ce.osVersion].filter(Boolean).join(" ") || null,
    },
    { label: "Device type", value: ce.deviceClass },
    { label: "Timezone", value: ce.timezone },
    { label: "Locale / language", value: ce.locale ?? null },
    { label: "Engine", value: ce.engine },
    { label: "Platform", value: ce.platform },
  ]);
}

/** Advanced client details behind an accordion (masked IP + UA hash). */
export function buildClientAdvancedRows(
  tm: TechnicalMetadataInternal | null,
): AppendixRow[] {
  const ce = tm?.captureEnvironment ?? null;
  if (!ce) return [];
  return rows([
    { label: "Masked IP", value: ce.ipAddressMasked ?? null, mono: true },
    {
      label: "User-Agent hash",
      value: ce.userAgentHash ?? null,
      mono: true,
      copyable: true,
    },
  ]);
}

// =============================================================================
// Section 7 — Upload Session
// =============================================================================

export function buildUploadSessionRows(input: {
  tm: TechnicalMetadataInternal | null;
  itemCount: number | null | undefined;
  multipart: boolean;
  partCount: number | null | undefined;
  leadItem: string | null | undefined;
  uploadedAtUtc: string | null | undefined;
}): AppendixRow[] {
  const acq = input.tm?.acquisition ?? null;
  const ce = input.tm?.captureEnvironment ?? null;
  const totalBytes = (input.tm?.perParts ?? []).reduce(
    (sum, p) => sum + (p.sizeBytes ?? 0),
    0,
  );
  return rows([
    { label: "Upload source", value: ce?.uploadSource },
    { label: "Total items", value: input.itemCount != null ? String(input.itemCount) : null },
    { label: "Multipart upload", value: input.multipart ? "Yes" : "No" },
    {
      label: "Part count",
      value: input.partCount != null && input.partCount > 0 ? String(input.partCount) : null,
    },
    { label: "Total size", value: fmtBytes(totalBytes) },
    { label: "Lead item", value: input.leadItem ?? null },
    { label: "Upload completed", value: input.uploadedAtUtc ?? null },
    // Intake-only session states.
    {
      label: "Submission status",
      value:
        acq && acq.submissionStatus.length ? acq.submissionStatus.join(" • ") : null,
    },
    { label: "Delivery channel", value: acq?.deliveryChannel ?? null },
    {
      label: "Consent",
      value: acq
        ? acq.consentAccepted === true
          ? "Accepted"
          : "Not recorded"
        : null,
    },
    { label: "Submitted at (server UTC)", value: acq?.submittedAtUtc ?? null },
  ]);
}

// =============================================================================
// Section 9 — Security & Integrity
// =============================================================================

/** Timestamp status → reviewer label (mirrors the PDF report). */
export function timestampStatusLabel(status: string | null | undefined): string {
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

/** OTS/Bitcoin anchoring status → reviewer label (txid-truthful). */
export function anchoringStatusLabel(input: {
  status: string | null | undefined;
  bitcoinTxid: string | null | undefined;
  anchoredAtUtc: string | null | undefined;
  proofPresent: boolean;
}): string {
  const s = (input.status ?? "").toUpperCase();
  const anchored =
    Boolean(input.bitcoinTxid) || Boolean(input.anchoredAtUtc);
  if (s === "ANCHORED" && anchored) {
    return "OpenTimestamps Bitcoin anchoring verified";
  }
  if (s === "ANCHORED" || s === "PENDING" || input.proofPresent) {
    return "OpenTimestamps proof present; Bitcoin anchoring pending";
  }
  if (s === "FAILED") return "OpenTimestamps anchoring failed";
  if (s === "DISABLED") return "OpenTimestamps unavailable";
  return "OpenTimestamps not configured";
}

export type PreservationInput = {
  recordedIntegrityVerifiedAtUtc: string | null;
  signature: { recorded: boolean; valid: boolean; keyId: string | null; keyVersion: number | null };
  tsa: { status: string | null; provider: string | null; timestampedDigestLabel: string };
  ots: {
    effectiveStatus: string | null;
    proofPresent: boolean;
    bitcoinTxid: string | null;
    anchoredAtUtc: string | null;
    calendar: string | null;
  };
  storage: { objectLockMode?: string | null; retainUntilUtc?: string | null; immutableLabel?: string | null };
};

export type IntegrityEvidenceInput = {
  evidenceRef: string | null;
  fileSha256: string | null;
  fingerprintHash: string | null;
  tsaSerialNumber: string | null;
  storageObjectLockMode: string | null;
  storageObjectLockRetainUntilUtc: string | null;
};

export function buildIntegrityRows(input: {
  preservation: PreservationInput;
  evidence: IntegrityEvidenceInput;
  multipart: boolean;
}): AppendixRow[] {
  const { preservation: p, evidence: e } = input;
  const digestLabel = input.multipart
    ? "Canonical package digest (SHA-256)"
    : "Original file SHA-256";
  return rows([
    { label: "Evidence reference", value: e.evidenceRef, mono: true, copyable: true },
    {
      label: "Recorded integrity",
      value: p.recordedIntegrityVerifiedAtUtc ? "Recorded integrity verified" : null,
    },
    { label: digestLabel, value: e.fileSha256, mono: true, copyable: true },
    {
      label: "Canonical fingerprint hash",
      value: e.fingerprintHash,
      mono: true,
      copyable: true,
    },
    {
      label: "Digital signature",
      value: p.signature.recorded
        ? p.signature.valid
          ? "Digital signature recorded"
          : "Digital signature recorded (verify separately)"
        : null,
    },
    {
      label: "Signing key reference",
      value:
        p.signature.keyId != null
          ? `${p.signature.keyId}${p.signature.keyVersion != null ? ` v${p.signature.keyVersion}` : ""}`
          : null,
      mono: true,
    },
    { label: "Trusted timestamp", value: timestampStatusLabel(p.tsa.status) },
    { label: "Timestamp provider", value: p.tsa.provider },
    { label: "Timestamp serial", value: e.tsaSerialNumber, mono: true },
    {
      label: "OpenTimestamps / Bitcoin anchoring",
      value: anchoringStatusLabel({
        status: p.ots.effectiveStatus,
        bitcoinTxid: p.ots.bitcoinTxid,
        anchoredAtUtc: p.ots.anchoredAtUtc,
        proofPresent: p.ots.proofPresent,
      }),
    },
    { label: "Bitcoin transaction ID", value: p.ots.bitcoinTxid, mono: true, copyable: true },
    {
      label: "Immutable storage",
      value: mapObjectLockLabel(e.storageObjectLockMode),
    },
    { label: "Retention until", value: e.storageObjectLockRetainUntilUtc },
  ]);
}

function mapObjectLockLabel(mode: string | null | undefined): string | null {
  switch ((mode ?? "").toUpperCase()) {
    case "COMPLIANCE":
      return "Compliance retention lock";
    case "GOVERNANCE":
      return "Governance retention lock";
    default:
      return null;
  }
}

// =============================================================================
// Section 10 — Chain of Custody Summary
// =============================================================================

export function buildCustodySummaryRows(input: {
  forensicEventCount: number | null | undefined;
  firstEventAtUtc: string | null | undefined;
  latestEventAtUtc: string | null | undefined;
  latestEventHash: string | null | undefined;
  hashChainValid: boolean | null | undefined;
  status: string | null | undefined;
}): AppendixRow[] {
  return rows([
    {
      label: "Total forensic events",
      value:
        input.forensicEventCount != null ? String(input.forensicEventCount) : null,
    },
    { label: "First event (server UTC)", value: input.firstEventAtUtc ?? null },
    { label: "Latest event (server UTC)", value: input.latestEventAtUtc ?? null },
    {
      label: "Hash chain",
      value:
        input.hashChainValid == null
          ? null
          : input.hashChainValid
            ? "Recorded"
            : "Not verified",
    },
    {
      label: "Latest custody hash",
      value: shortHash(input.latestEventHash),
      mono: true,
      copyable: input.latestEventHash != null,
    },
    { label: "Current evidence status", value: input.status ?? null },
  ]).map((r) =>
    r.label === "Latest custody hash" && input.latestEventHash
      ? { ...r, value: input.latestEventHash }
      : r,
  );
}
