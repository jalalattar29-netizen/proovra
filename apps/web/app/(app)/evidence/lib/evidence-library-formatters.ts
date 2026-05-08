export const EVIDENCE_LIBRARY_LEGAL_BOUNDARY =
  "PROOVRA verifies the recorded integrity state of evidence records. It does not independently establish factual truth, authorship, identity, legal admissibility, or evidentiary weight.";

export function formatUtcDateTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";

  const month = date.toLocaleString("en-GB", {
    month: "short",
    timeZone: "UTC",
  });

  return `${String(date.getUTCDate()).padStart(2, "0")} ${month} ${date.getUTCFullYear()}, ${String(
    date.getUTCHours()
  ).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

export function formatBytes(value: string | number | null | undefined): string {
  const numeric = typeof value === "number" ? value : value ? Number(value) : Number.NaN;

  if (!Number.isFinite(numeric) || numeric <= 0) return "Not recorded";

  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = numeric;
  let index = 0;

  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }

  return `${size.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

export function shortId(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "Not available";
  if (text.length <= 14) return text;
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function safeText(
  value: string | null | undefined,
  fallback = "Not available"
): string {
  const text = (value ?? "").trim();
  return text || fallback;
}

export function buildVerificationUrl(evidenceId: string): string {
  const appBase =
    process.env.NEXT_PUBLIC_APP_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WEB_BASE?.trim() ||
    "https://app.proovra.com";

  return `${appBase.replace(/\/+$/, "")}/verify/${evidenceId}`;
}
