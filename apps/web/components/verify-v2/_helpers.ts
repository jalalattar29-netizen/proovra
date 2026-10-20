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

import { readOtsAnchoringView } from "@proovra/shared";
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
// Tone helpers — AUD-47 (2026-10-20): statusTone / timestampTone were deleted.
// Nothing called them, and they broke the tone rules (a raw STAMPED read as
// success, an unvalidated token amber). Statuses take THE shared tables
// (VERIFICATION_STATUS_TONES, TSA_PROOF_STATUS_TONE).
// ---------------------------------------------------------------------------



/**
 * The Bitcoin anchoring badge (2026-10-15): the state and verification the
 * server sent, read through `readOtsAnchoringView` — never re-derived from a
 * txid, a time or a status string. Only CHAIN_VERIFIED ("Independently
 * verified against the Bitcoin main chain") is a success; FAILED and
 * CHAIN_FAILED are danger; every other key — including an ANCHORED proof
 * nobody checked against the chain ("Bitcoin attestation recorded") — is
 * neutral. A missing or unknown state reads as "Bitcoin anchoring unavailable".
 */
export function otsTone(otsAnchoring: unknown): {
  label: string;
  tone: "success" | "danger" | "neutral";
} {
  const view = readOtsAnchoringView(otsAnchoring);
  return {
    label: view.label,
    tone: view.tone,
  };
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
