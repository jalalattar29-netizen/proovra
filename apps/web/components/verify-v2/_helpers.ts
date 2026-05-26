/**
 * Phase CR4 — Verify Experience Decomposition: pure helpers.
 *
 * SCOPE: pure functions that take primitive inputs (string / number /
 * boolean / unknown) and return primitive outputs or small UI-tone
 * config objects. NO Verify* domain types appear here — those helpers
 * stay in the orchestrator until a follow-on CR4 extraction pass.
 *
 * HARD RULES (pinned by `phase-cr4-verify-decomposition.test.ts`):
 *   - This file must NEVER perform a network request.
 *   - This file must NEVER reference custody/finalize/storage internals.
 *   - This file must NEVER carry trust-language strings beyond the
 *     state-vocabulary labels already present in the orchestrator.
 *   - State-string vocabulary (STAMPED / PENDING / ANCHORED /
 *     FAILED / etc.) is the contract; see test Groups 8 & 9.
 *
 * Source-of-truth: extracted verbatim from
 * `apps/web/app/verify/[token]/page.tsx` lines 651-838 with byte-stable
 * behaviour. CR4 changes ZERO logic in these helpers.
 */

import { formatUserDateTime } from "../../lib/date";

// ---------------------------------------------------------------------------
// Date / label formatting
// ---------------------------------------------------------------------------

export function formatDateTime(value?: string | null): string {
  if (!value) return "N/A";
  return formatUserDateTime(value);
}

export function normalizeEventLabel(value?: string | null): string {
  if (!value) return "Unknown Event";
  return value
    .toLowerCase()
    .split("_")
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// OTS terminal-status predicate
// ---------------------------------------------------------------------------

export function isOtsTerminalStatus(status?: string | null): boolean {
  const s = (status ?? "").trim().toUpperCase();
  return s === "ANCHORED" || s === "FAILED" || s === "DISABLED";
}

// ---------------------------------------------------------------------------
// Tone helpers — return colour / tone config for status badges
// ---------------------------------------------------------------------------

export function statusTone(
  status?: string | null,
): { label: string; bg: string; color: string; border: string } {
  const s = (status ?? "").toUpperCase();

  if (
    s === "GRANTED" ||
    s === "STAMPED" ||
    s === "VERIFIED" ||
    s === "SUCCEEDED" ||
    s === "SIGNED" ||
    s === "REPORTED" ||
    s === "ANCHORED" ||
    s === "RECORDED_INTEGRITY_VERIFIED"
  ) {
    return {
      label: s || "VERIFIED",
      bg: "#ECFDF3",
      color: "#067647",
      border: "#ABEFC6",
    };
  }

  if (s === "PENDING" || s === "MATERIALS_AVAILABLE") {
    return {
      label: s || "AVAILABLE",
      bg: "#FFFAEB",
      color: "#B54708",
      border: "#FAD7A0",
    };
  }

  if (s) {
    return {
      label: s,
      bg: "#FEF3F2",
      color: "#B42318",
      border: "#FECDCA",
    };
  }

  return {
    label: "AVAILABLE",
    bg: "#F8F9FC",
    color: "#344054",
    border: "#D0D5DD",
  };
}

export function timestampTone(
  status?: string | null,
): { label: string; tone: "success" | "warning" | "neutral" } {
  const s = (status ?? "").toUpperCase();

  if (s === "STAMPED" || s === "GRANTED" || s === "VERIFIED" || s === "SUCCEEDED") {
    return { label: s, tone: "success" };
  }

  if (s === "PENDING") {
    return { label: "PENDING", tone: "warning" };
  }

  if (s === "FAILED") {
    return { label: "FAILED", tone: "warning" };
  }

  if (s) {
    return { label: s, tone: "warning" };
  }

  return { label: "Unavailable", tone: "neutral" };
}

export function otsTone(
  status?: string | null,
  bitcoinTxid?: string | null,
): { label: string; tone: "success" | "warning" | "neutral" | "info" } {
  const s = (status ?? "").toUpperCase();
  const hasValidBitcoinTxid =
    typeof bitcoinTxid === "string" && /^[a-f0-9]{64}$/i.test(bitcoinTxid.trim());

  if (s === "ANCHORED") {
    return hasValidBitcoinTxid
      ? { label: "ANCHORED", tone: "success" }
      : { label: "PUBLICATION PENDING", tone: "warning" };
  }

  if (s === "PENDING") {
    return { label: "PENDING", tone: "warning" };
  }

  if (s === "FAILED") {
    return { label: "FAILED", tone: "warning" };
  }

  if (s === "DISABLED") {
    return { label: "DISABLED", tone: "neutral" };
  }

  if (s) {
    return { label: s, tone: "info" };
  }

  return { label: "Unavailable", tone: "neutral" };
}

// ---------------------------------------------------------------------------
// Small primitive utilities
// ---------------------------------------------------------------------------

export function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function truncateHash(hash?: string | null, length = 16): string | null {
  if (!hash) return null;
  const normalized = hash.trim();
  if (normalized.length <= length) return normalized;
  const prefix = normalized.slice(0, Math.max(6, length - 8));
  const suffix = normalized.slice(-4);
  return `${prefix}…${suffix}`;
}

export function normalizeBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
