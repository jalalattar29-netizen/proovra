/**
 * THE CANONICAL PROOF-STATUS RESOLVERS (UC-TRUST-002, 2026-10-01).
 *
 * Every surface that states an OpenTimestamps or RFC 3161 layer — the web
 * evidence detail, the provenance chain (and the package's
 * provenance/chain.json), the report, Public Verify, admin lists and the
 * native app — reads the layer through these two functions. The provenance
 * chain used to infer "Anchored" from the mere presence of an OTS_APPLIED
 * custody event (written with the proof still PENDING) and "Applied" from a
 * TIMESTAMP_APPLIED event (written for legacy tokens nobody validated). Event
 * TYPES are not states; the Evidence row is.
 *
 * OTS (built on the one claim, `resolveOtsAnchorClaim`):
 *   NOT_REQUESTED        no OTS proof was requested for this record
 *   SUBMITTED            a calendar proof exists; no upgrade toward a Bitcoin
 *                        anchor has been attempted yet
 *   PENDING              upgrade attempted; Bitcoin anchoring still pending
 *   ANCHORED_UNVERIFIED  recorded as anchored, the Bitcoin chain was NOT checked
 *   VERIFIED             anchored AND verified against the Bitcoin chain
 *   FAILED               the proof is established to be unusable
 *   STALE_UNKNOWN        pending for longer than anchoring takes: the current
 *                        state is not known and is not claimed
 *
 * Only VERIFIED may be shown as "anchored".
 *
 * RFC 3161 (built on `presentedTsaStatus`):
 *   NOT_REQUESTED, PENDING, VALIDATED, RECORDED_NOT_VALIDATED, FAILED
 *
 * Only VALIDATED may be shown as an applied/trusted timestamp. A legacy token
 * kept without validation is "Recorded, not validated" — never "Applied".
 */
import { resolveOtsAnchorClaim } from "./ots.js";
import { presentedTsaStatus, TSA_RECORDED_NOT_VALIDATED } from "./tsa-validation-state.js";

export const OTS_PROOF_STATUSES = [
  "NOT_REQUESTED",
  "SUBMITTED",
  "PENDING",
  "ANCHORED_UNVERIFIED",
  "VERIFIED",
  "FAILED",
  "STALE_UNKNOWN",
] as const;
export type OtsProofStatus = (typeof OTS_PROOF_STATUSES)[number];

/**
 * Bitcoin anchoring of an OpenTimestamps calendar commitment normally
 * completes within hours. A proof still pending after this many days is not
 * described as "pending" any more — its state is unknown.
 */
export const OTS_PENDING_STALE_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export type OtsProofStatusInput = {
  status: string | null | undefined;
  anchoredAtUtc: Date | string | null | undefined;
  anchorCheck: string | null | undefined;
  bitcoinTxid?: string | null;
  proofPresent?: boolean | null;
  /** evidence.ots_upgraded_at_utc — an upgrade toward Bitcoin was attempted. */
  upgradedAtUtc?: Date | string | null;
  /** When the proof was requested (the record's signing / OTS_APPLIED time). */
  submittedAtUtc?: Date | string | null;
  now?: Date;
  staleAfterDays?: number;
};

export function resolveOtsProofStatus(input: OtsProofStatusInput): OtsProofStatus {
  const claim = resolveOtsAnchorClaim({
    status: input.status,
    anchoredAtUtc: input.anchoredAtUtc,
    anchorCheck: input.anchorCheck,
    proofPresent: input.proofPresent ?? null,
    ...("bitcoinTxid" in input ? { bitcoinTxid: input.bitcoinTxid ?? null } : {}),
  });
  switch (claim) {
    case "VERIFIED":
      return "VERIFIED";
    case "ANCHORED_NOT_CHECKED":
      return "ANCHORED_UNVERIFIED";
    case "FAILED":
      return "FAILED";
    case "UNAVAILABLE":
    case "NOT_CONFIGURED":
      return "NOT_REQUESTED";
    case "PENDING": {
      const now = input.now ?? new Date();
      const since = toDate(input.submittedAtUtc);
      const staleDays = input.staleAfterDays ?? OTS_PENDING_STALE_AFTER_DAYS;
      if (since && now.getTime() - since.getTime() > staleDays * DAY_MS) return "STALE_UNKNOWN";
      return toDate(input.upgradedAtUtc) ? "PENDING" : "SUBMITTED";
    }
  }
}

/** Only a proof verified against the Bitcoin chain may be called anchored. */
export function otsProofStatusIsAnchored(status: OtsProofStatus): boolean {
  return status === "VERIFIED";
}

export const OTS_PROOF_STATUS_LABELS: Readonly<Record<OtsProofStatus, string>> = {
  NOT_REQUESTED: "Not requested",
  SUBMITTED: "Submitted to OpenTimestamps calendars; Bitcoin anchoring not yet attempted",
  PENDING: "Bitcoin anchoring pending",
  ANCHORED_UNVERIFIED: "Recorded as anchored; not checked against the Bitcoin chain",
  VERIFIED: "Anchored in Bitcoin and verified",
  FAILED: "Anchoring failed",
  STALE_UNKNOWN: "Anchoring state unknown (pending longer than expected)",
};

/** Short badge text; green is reserved for VERIFIED. */
export const OTS_PROOF_STATUS_BADGES: Readonly<
  Record<OtsProofStatus, { label: string; tone: "success" | "warning" | "neutral" | "info" }>
> = {
  NOT_REQUESTED: { label: "Not requested", tone: "neutral" },
  SUBMITTED: { label: "Submitted", tone: "info" },
  PENDING: { label: "Pending", tone: "warning" },
  ANCHORED_UNVERIFIED: { label: "Anchored · chain not checked", tone: "info" },
  VERIFIED: { label: "Anchored · verified", tone: "success" },
  FAILED: { label: "Failed", tone: "warning" },
  STALE_UNKNOWN: { label: "State unknown", tone: "neutral" },
};

export function parseOtsProofStatus(value: unknown): OtsProofStatus | null {
  return typeof value === "string" && (OTS_PROOF_STATUSES as readonly string[]).includes(value)
    ? (value as OtsProofStatus)
    : null;
}

// ---------------------------------------------------------------------------
// RFC 3161
// ---------------------------------------------------------------------------

export const TSA_PROOF_STATUSES = [
  "NOT_REQUESTED",
  "PENDING",
  "VALIDATED",
  "RECORDED_NOT_VALIDATED",
  "FAILED",
] as const;
export type TsaProofStatus = (typeof TSA_PROOF_STATUSES)[number];

export function resolveTsaProofStatus(row: {
  tsaStatus: string | null | undefined;
  tsaValidatedAtUtc?: Date | string | null | undefined;
}): TsaProofStatus {
  const presented = String(presentedTsaStatus(row) ?? "").trim().toUpperCase();
  if (presented === "STAMPED") return "VALIDATED";
  if (presented === TSA_RECORDED_NOT_VALIDATED) return "RECORDED_NOT_VALIDATED";
  if (presented === "FAILED") return "FAILED";
  if (presented === "PENDING") return "PENDING";
  return "NOT_REQUESTED";
}

/** Only a validated token may be presented as an applied trusted timestamp. */
export function tsaProofStatusIsValidated(status: TsaProofStatus): boolean {
  return status === "VALIDATED";
}

export const TSA_PROOF_STATUS_LABELS: Readonly<Record<TsaProofStatus, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Pending",
  VALIDATED: "RFC 3161 timestamp validated",
  RECORDED_NOT_VALIDATED: "Recorded, not validated",
  FAILED: "Timestamp failed",
};

export function parseTsaProofStatus(value: unknown): TsaProofStatus | null {
  return typeof value === "string" && (TSA_PROOF_STATUSES as readonly string[]).includes(value)
    ? (value as TsaProofStatus)
    : null;
}
