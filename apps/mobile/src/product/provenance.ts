/**
 * PROVENANCE CHAIN (T-15) — the native port of
 * `apps/web/app/(app)/evidence/[id]/_tabs/EvidenceProvenanceChainSection.tsx`.
 *
 * GET /v1/provenance/:evidenceId — the server projection of how a record
 * reached PROOVRA (acquisition, device signature, device check), the
 * preservation steps (countersignature, RFC 3161 timestamp, public anchor),
 * derived copies and the standing limitations. Every value is the server's;
 * nothing is derived here. A projection for another record is never shown.
 */
import { otsAnchoringCopy, parseOtsState, type OtsState } from "@proovra/shared";
import { otsCardForVerification, otsStatusLine, otsVerificationOf, type OtsVerificationKey } from "./ots-anchoring";

export function buildProvenancePath(evidenceId: string): string {
  return `/v1/provenance/${encodeURIComponent(evidenceId)}`;
}

export interface ProvenanceView {
  acquisitionLabel: string;
  recordedBy: string | null;
  deviceSignatureNote: string;
  attestationVerdict: string;
  attestationProvider: string;
  signedAtUtc: string | null;
  countersigned: boolean;
  countersignedAtUtc: string | null;
  rfc3161Applied: boolean;
  rfc3161AppliedAtUtc: string | null;
  /** UC-TRUST-002 — the canonical RFC 3161 status (only VALIDATED is applied). */
  rfc3161Status: string | null;
  otsApplied: boolean;
  /**
   * `time.ots.status` — THE canonical OTS state (ots-anchoring.ts, 2026-10-13),
   * read as sent; anything missing or unknown reads as UNAVAILABLE.
   */
  otsStatus: OtsState;
  /**
   * `time.ots.verification` — the derived verification key, believed only when
   * coherent with the state (ANCHORED without one is an unchecked attestation).
   * Only CHAIN_VERIFIED is a verification.
   */
  otsVerification: OtsVerificationKey;
  /** Only when the server sent it for an ANCHORED state. */
  otsAnchorTxId: string | null;
  /** When PROOVRA recorded the anchor — never a Bitcoin block time. */
  otsAppliedAtUtc: string | null;
  otsBlockHeight: number | null;
  derivations: Array<{ derivedEvidenceId: string; transformLabel: string | null; derivedAtUtc: string }>;
  limitations: string[];
}

function o(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** null when the projection is absent or is not for THIS record. */
export function parseProvenanceChain(payload: unknown, evidenceId: string): ProvenanceView | null {
  const d = o(payload);
  const c = o(d["chain"]);
  if (s(c.evidenceId) !== evidenceId) return null;
  const acq = o(c.acquisition);
  const cap = o(c.capture);
  const srv = o(c.server);
  const time = o(c.time);
  const rfc = o(time.rfc3161);
  const ots = o(time.ots);
  return {
    acquisitionLabel: s(acq.label) ?? "Not recorded",
    recordedBy: s(acq.recordedBy),
    deviceSignatureNote: s(cap.deviceSignatureNote) ?? "Not recorded",
    attestationVerdict: s(cap.attestationVerdict) ?? "NOT_ATTEMPTED",
    attestationProvider: s(cap.attestationProvider) ?? "",
    signedAtUtc: s(cap.signedAtUtc),
    countersigned: srv.countersigned === true,
    countersignedAtUtc: s(srv.countersignedAtUtc),
    rfc3161Applied: rfc.applied === true,
    rfc3161AppliedAtUtc: s(rfc.appliedAtUtc),
    rfc3161Status: s(rfc.status),
    otsApplied: ots.applied === true,
    otsStatus: parseOtsState(ots.status),
    otsVerification: otsVerificationOf(ots.status, ots.verification),
    otsAnchorTxId: parseOtsState(ots.status) === "ANCHORED" ? s(ots.anchorTxId) : null,
    otsAppliedAtUtc: parseOtsState(ots.status) === "ANCHORED" ? s(ots.appliedAtUtc) : null,
    otsBlockHeight:
      parseOtsState(ots.status) === "ANCHORED" && typeof ots.bitcoinBlockHeight === "number" && Number.isSafeInteger(ots.bitcoinBlockHeight)
        ? (ots.bitcoinBlockHeight as number)
        : null,
    derivations: (Array.isArray(c.derivations) ? c.derivations : [])
      .map((x) => o(x))
      .filter((x) => s(x.derivedEvidenceId) && s(x.derivedAtUtc))
      .map((x) => ({ derivedEvidenceId: s(x.derivedEvidenceId) as string, transformLabel: s(x.transformLabel), derivedAtUtc: s(x.derivedAtUtc) as string })),
    limitations: (Array.isArray(c.limitations) ? c.limitations : []).filter((l): l is string => typeof l === "string"),
  };
}

function humanise(v: string): string {
  const t = v.replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** The web's capture rows, in order, with its conditions. */
export function provenanceCaptureRows(p: ProvenanceView, fmt: (iso: string) => string): Array<{ label: string; value: string }> {
  const rows = [
    { label: "How it was acquired", value: p.acquisitionLabel },
    { label: "Device signature at source", value: p.deviceSignatureNote },
  ];
  if (p.recordedBy === "BACKFILL_INTAKE_SESSION_LINK") {
    rows.push({ label: "Acquisition recorded", value: "Recorded later from this record's secure intake session." });
  }
  if (p.attestationVerdict !== "NOT_ATTEMPTED") {
    rows.push({ label: "Device check", value: `${humanise(p.attestationVerdict)} (${humanise(p.attestationProvider)})` });
  }
  if (p.signedAtUtc) rows.push({ label: "Signed on device", value: fmt(p.signedAtUtc) });
  return rows;
}

/** UC-TRUST-002 — the canonical status labels (same words as web). */
const TSA_LABELS: Record<string, string> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Pending",
  VALIDATED: "RFC 3161 timestamp validated",
  RECORDED_NOT_VALIDATED: "Recorded, not validated",
  FAILED: "Timestamp failed",
};
function rfc3161Text(p: ProvenanceView, fmt: (iso: string) => string): string {
  const at = p.rfc3161AppliedAtUtc ? ` · ${fmt(p.rfc3161AppliedAtUtc)}` : "";
  if (p.rfc3161Status && TSA_LABELS[p.rfc3161Status]) {
    return p.rfc3161Status === "VALIDATED" || p.rfc3161Status === "RECORDED_NOT_VALIDATED"
      ? `${TSA_LABELS[p.rfc3161Status]}${at}`
      : TSA_LABELS[p.rfc3161Status]!;
  }
  // An older server: "applied" only ever claimed a recorded token.
  return p.rfc3161Applied ? `Recorded${at}` : "Not applied";
}
export function provenancePreservationRows(
  p: ProvenanceView,
  fmt: (iso: string) => string,
  locale?: string | null,
): Array<{ label: string; value: string }> {
  // Bitcoin anchoring: the server's verification in the locale's words. Only
  // CHAIN_VERIFIED carries a ✓; an unchecked attestation says so.
  const ots = otsAnchoringCopy(locale);
  const card = otsCardForVerification(p.otsVerification ?? otsVerificationOf(p.otsStatus, null), locale);
  const rows = [
    { label: "PROOVRA countersignature", value: p.countersigned ? `Applied${p.countersignedAtUtc ? ` · ${fmt(p.countersignedAtUtc)}` : ""}` : "Not applied" },
    { label: "Independent timestamp", value: rfc3161Text(p, fmt) },
    { label: ots.title, value: otsStatusLine(card) },
  ];
  if (p.otsBlockHeight !== null) rows.push({ label: ots.facts.blockHeight, value: String(p.otsBlockHeight) });
  if (p.otsAnchorTxId) rows.push({ label: ots.facts.txid, value: p.otsAnchorTxId });
  if (p.otsAppliedAtUtc) rows.push({ label: ots.facts.anchoredAt, value: fmt(p.otsAppliedAtUtc) });
  return rows;
}

/** LIMITATION_COPY, verbatim; an unknown code is humanised, never dropped. */
const LIMITATION_COPY: Record<string, string> = {
  PROVENANCE_DOES_NOT_PROVE_CONTENT_TRUTH:
    "A provenance record shows how a file reached PROOVRA. It does not establish whether what the file shows is true.",
  PROVENANCE_DOES_NOT_PROVE_LEGAL_ADMISSIBILITY:
    "A provenance record is not a ruling on admissibility. That decision belongs to the court or tribunal.",
  PROVENANCE_CLASS_C_HAS_NO_CAPTURE_SIDE_INTEGRITY:
    "Imported files carry no capture-device evidence, because PROOVRA was not present when they were recorded.",
  ATTESTATION_REVOCATION_IS_RETROACTIVE:
    "If a capture device is later found to be compromised, earlier device checks for that device stop being reliable.",
  "OFFLINE_CAPTURES_ARE_TIME-BOUNDED_BY_LOCAL_CLOCK":
    "Captures taken offline are timed by the device's own clock until PROOVRA can apply an independent timestamp.",
};
export function provenanceLimitationText(code: string): string {
  return LIMITATION_COPY[code] ?? humanise(code);
}

export const PROVENANCE_COPY = {
  kicker: "Provenance",
  title: "How this record reached PROOVRA",
  loading: "Loading the provenance record…",
  notAvailable: "A provenance record is not available for this evidence in the workspace you are in.",
  personalDenied:
    "Provenance records are kept for organisation workspaces. Switch to the organisation that holds this evidence to view its provenance.",
  failed: "We couldn't load the provenance record.",
  preservation: "Preservation steps recorded",
  custodyNote: "These steps are the same events listed on the Custody tab — open Custody for the full timeline, including who performed each step.",
  derived: "Files derived from this one",
  limits: "What this does not tell you",
} as const;
