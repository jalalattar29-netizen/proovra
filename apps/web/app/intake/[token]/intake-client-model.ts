/**
 * Public intake page — the pure rules the page applies (Team remediation
 * stage F: T-127, T-128, T-130, T-151, T-152, T-154).
 *
 * Kept out of the component so each rule is exercised directly and through
 * the rendered page.
 */

/**
 * T-130 (audit JRN-04) — every request this page makes is anonymous: no
 * bearer, no cookies (`credentials: "omit"`) and no active-workspace header,
 * exactly as the public verify pages do. `auth: false` alone still sent the
 * signed-in visitor's cookies and workspace id.
 */
export const INTAKE_PUBLIC_FETCH = { auth: false, anonymous: true } as const;

/**
 * T-128 (audit JRN-05) — the index a NEW file is staged at: one past the
 * highest index this session holds. `parts.length` re-targeted an occupied
 * index after a middle file was removed.
 */
export function nextPartIndex(parts: ReadonlyArray<{ partIndex?: number | null }>): number {
  let max = -1;
  for (const p of parts) {
    if (typeof p.partIndex === "number" && Number.isInteger(p.partIndex) && p.partIndex > max) max = p.partIndex;
  }
  return max + 1;
}

/**
 * T-127 — what is left of the link's per-submission byte cap after the files
 * already staged (null when the link has no cap). Never negative.
 */
export function remainingSessionBytes(
  maxBytesPerSession: string | number | null | undefined,
  parts: ReadonlyArray<{ sizeBytes?: number | null }>,
): number | null {
  if (maxBytesPerSession === null || maxBytesPerSession === undefined || maxBytesPerSession === "") return null;
  const cap = Number(maxBytesPerSession);
  if (!Number.isFinite(cap) || cap < 0) return null;
  const used = parts.reduce((sum, p) => sum + (typeof p.sizeBytes === "number" && p.sizeBytes > 0 ? p.sizeBytes : 0), 0);
  return Math.max(0, cap - used);
}

/** A byte count for a contributor ("1.5 MB", "200 bytes"). */
export function formatIntakeBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export type IntakeLoadErrorClass =
  | "expired-or-revoked"
  | "invalid"
  | "feature-disabled"
  | "rate-limited"
  | "network"
  | "generic";

/**
 * T-151 (audit JRN-08 o) — the class of a failed first load, from the error
 * CODE the API sent (never from translated copy). LINK_REVOKED and the other
 * lifecycle codes are recognised; INVALID_OR_EXPIRED_LINK and INVALID_INPUT
 * (a malformed token) are "invalid".
 */
export function intakeLoadErrorClass(code: string | null | undefined): IntakeLoadErrorClass {
  switch (code) {
    case "LINK_NO_LONGER_AVAILABLE":
    case "LINK_EXPIRED":
    case "LINK_REVOKED":
    case "LINK_EXHAUSTED":
      return "expired-or-revoked";
    case "INVALID_OR_EXPIRED_LINK":
    case "INVALID_INPUT":
    case "NOT_FOUND":
      return "invalid";
    case "FEATURE_DISABLED":
      return "feature-disabled";
    case "RATE_LIMITED":
      return "rate-limited";
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return "network";
    default:
      return "generic";
  }
}

/**
 * T-152 (audit JRN-08 p) — a first load that failed for a reason that can pass
 * (no answer, a rate limit, a server fault) offers Retry; a link that is gone
 * or invalid does not.
 */
export function intakeLoadErrorRetryable(cls: IntakeLoadErrorClass): boolean {
  return cls === "rate-limited" || cls === "network" || cls === "generic";
}

const KIND_ACCEPT: Record<string, string[]> = {
  PHOTO: ["image/*"],
  VIDEO: ["video/*"],
  AUDIO: ["audio/*"],
  DOCUMENT: [
    "application/pdf",
    "text/*",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
    ".pdf",
    ".txt",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".csv",
    ".ppt",
    ".pptx",
    ".rtf",
    ".odt",
  ],
};

/**
 * T-154 (audit JRN-08 r) — the file picker's `accept` for the link's allowed
 * kinds; undefined when every kind is allowed (no filter). The server stays the
 * authority (MIME_TYPE_NOT_ALLOWED): `accept` only filters the picker.
 */
export function acceptAttributeForKinds(kinds: ReadonlyArray<string> | null | undefined): string | undefined {
  if (!kinds || kinds.length === 0) return undefined;
  const parts = new Set<string>();
  for (const k of kinds) for (const a of KIND_ACCEPT[k] ?? []) parts.add(a);
  return parts.size > 0 ? [...parts].join(",") : undefined;
}
