import { maskPublicEmail } from "@proovra/shared";

export const maskEmail = maskPublicEmail;

export function safe(
  value: string | null | undefined,
  fallback = "N/A"
): string {
    const t = typeof value === "string" ? value.trim() : "";
  return t ? t : fallback;
}

export function safeBooleanLabel(
  value: boolean | null | undefined,
  trueLabel = "Yes",
  falseLabel = "No",
  unknownLabel = "N/A"
): string {
  if (value === true) return trueLabel;
  if (value === false) return falseLabel;
  return unknownLabel;
}

export function redactIdentifier(
  value: string | null | undefined,
  visible = 6
): string {
  const t = safe(value, "");
  if (!t) return "Not included in external report";
  if (t.length <= visible * 2 + 3) return t;
  return `${t.slice(0, visible)}[redacted-middle]${t.slice(-visible)}`;
}

export function buildPublicEvidenceReference(
  evidenceId: string | null | undefined
): string {
  const t = safe(evidenceId, "");
  if (!t) return "Not recorded";
  return t;
}

export function buildPublicSigningKeyReference(
  keyId: string | null | undefined,
  version: number | null | undefined
): string {
  const id = safe(keyId, "");
  if (!id) return "Not recorded";

  const publicRef = id
    .replace(/^dw_/, "")
    .replace(/_kms$/i, "")
    .replace(/_/g, "-");

  return version ? `${publicRef} / v${version}` : publicRef;
}

export function normalizeEnumText(value: string | null | undefined): string {
  return safe(value, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatBytesHuman(bytesStr: string | null): string {
  const n = bytesStr ? Number(bytesStr) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return "N/A";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let idx = 0;
  let v = n;

  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }

  return `${v.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

export function prettifySummaryText(input: string): string {
  const raw = safe(input, "");
  if (!raw || raw === "N/A") return "N/A";

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parts = Object.entries(parsed).map(([k, v]) => {
      if (v === null || v === undefined) return `${k}: N/A`;
      if (typeof v === "object") return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${String(v)}`;
    });
    return parts.join(" • ");
  } catch {
    return raw
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/","/g, " • ")
      .replace(/":"/g, ": ")
      .replace(/"/g, "");
  }
}

export function escapeHtml(input: string | null | undefined): string {
  const value = input ?? "";
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeTimestampFailureReason(
  reason: string | null | undefined
): string {
  const text = safe(reason, "").toLowerCase();

  if (!text) {
    return "Trusted timestamp could not be obtained and should be reviewed manually.";
  }

  if (text.includes("quota") || text.includes("limit")) {
    return "Trusted timestamp could not be obtained because the provider quota was exceeded.";
  }

  if (text.includes("403") || text.includes("forbidden")) {
    return "Trusted timestamp could not be obtained due to provider access restrictions.";
  }

  if (text.includes("401") || text.includes("unauthorized")) {
    return "Trusted timestamp request was not authorized by the provider.";
  }

  if (text.includes("timeout") || text.includes("timed out")) {
    return "Trusted timestamp request timed out while contacting the provider.";
  }

  if (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("network") ||
    text.includes("connection")
  ) {
    return "Trusted timestamp request failed because the timestamp provider could not be reached.";
  }

  return "Trusted timestamp could not be obtained and should be reviewed manually.";
}
