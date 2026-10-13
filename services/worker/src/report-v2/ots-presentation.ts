/**
 * THE REPORT'S OPENTIMESTAMPS PRESENTATION (2026-10-13) — every OTS status,
 * sentence and technical row in the PDF comes from here, and here comes only
 * from the canonical anchoring state (`resolveOtsAnchoring`, packages/shared
 * ots-anchoring.ts). Nothing in report-v2 maps an OTS status string to words
 * on its own.
 *
 *   card      "Bitcoin anchoring" — Pending / Anchored ✓ / Failed /
 *             Unavailable / Not requested, with the state's one sentence
 *   appendix  the facts the stored proof yields, and — once, for ANCHORED —
 *             the boundary of what PROOVRA establishes
 *
 * A txid appears only when the executed proof path derived it. The anchored
 * time is when PROOVRA recorded the anchor, never a Bitcoin block time.
 */
import {
  OTS_ANCHORED_BOUNDARY,
  OTS_ANCHORING_COPY,
  OTS_FAILURE_LABELS,
  OTS_STATE_LABELS,
  OTS_STATE_WORDS,
  formatTimestampForReportUtc,
  resolveOtsAnchoring,
  type OtsAnchoring,
  type OtsState,
} from "@proovra/shared";

import type { KeyValueRow, ReportEvidence } from "./types.js";

type OtsEvidenceFields = Pick<
  ReportEvidence,
  | "id"
  | "otsStatus"
  | "otsAnchoredAtUtc"
  | "otsUpgradedAtUtc"
  | "otsProofBase64"
  | "otsHash"
  | "otsCalendar"
  | "otsFailureReason"
  | "fingerprintHash"
  | "otsSubmittedAtUtc"
>;

/** The canonical anchoring state for one report payload. */
export function reportOtsAnchoring(ev: Partial<OtsEvidenceFields>): OtsAnchoring {
  return resolveOtsAnchoring({
    status: ev.otsStatus ?? null,
    proofBase64: ev.otsProofBase64 ?? null,
    fingerprintHash: ev.fingerprintHash ?? null,
    otsHash: ev.otsHash ?? null,
    failureReason: ev.otsFailureReason ?? null,
    calendar: ev.otsCalendar ?? null,
    anchoredAtUtc: ev.otsAnchoredAtUtc ?? null,
    upgradedAtUtc: ev.otsUpgradedAtUtc ?? null,
    submittedAtUtc: ev.otsSubmittedAtUtc ?? null,
  });
}

/** The status word beside "Bitcoin anchoring" (cover, index, cards). */
export function otsStatusWordFor(state: OtsState): string {
  return OTS_STATE_WORDS[state];
}

/** The standalone label ("Bitcoin anchored", "Bitcoin anchoring pending", …). */
export function otsStatusLineFor(state: OtsState): string {
  return OTS_STATE_LABELS[state];
}

/** The boundary sentence, stated once in the technical appendix for ANCHORED. */
export const OTS_REPORT_BOUNDARY = OTS_ANCHORED_BOUNDARY;

/**
 * The technical OTS rows: state, the digest the proof commits to, the proof's
 * own SHA-256 and reference, its attestation, and the recording times. No
 * bucket name, storage key, credential or URL.
 */
export function buildOtsAnchoringRows(
  ev: Partial<OtsEvidenceFields>,
  a: OtsAnchoring = reportOtsAnchoring(ev),
): KeyValueRow[] {
  const facts = OTS_ANCHORING_COPY.en.facts;
  const rows: KeyValueRow[] = [{ label: "Bitcoin Anchoring", value: OTS_STATE_WORDS[a.state] }];
  if (a.state === "NOT_REQUESTED") return rows;
  if (a.committedDigestHex) rows.push({ label: facts.digest, value: a.committedDigestHex });
  if (a.proofSha256) {
    rows.push({ label: facts.proofSha256, value: a.proofSha256 });
    rows.push({
      label: "Proof Reference",
      value: `${ev.id ? `record ${ev.id}, ` : ""}opentimestamps-proof.ots (sha256:${a.proofSha256.slice(0, 16)})`,
    });
  }
  if (a.attestationType) {
    rows.push({ label: facts.attestationType, value: OTS_ANCHORING_COPY.en.attestationTypes[a.attestationType] });
  }
  if (a.state === "ANCHORED") {
    if (a.bitcoinBlockHeight != null) rows.push({ label: facts.blockHeight, value: String(a.bitcoinBlockHeight) });
    if (a.bitcoinTxid) rows.push({ label: "Bitcoin Transaction ID", value: a.bitcoinTxid });
  }
  if (a.submittedAtUtc) rows.push({ label: facts.submittedAt, value: formatTimestampForReportUtc(a.submittedAtUtc) });
  if (a.state === "ANCHORED" && a.anchoredAtUtc) {
    rows.push({ label: facts.anchoredAt, value: formatTimestampForReportUtc(a.anchoredAtUtc) });
  }
  if ((a.state === "FAILED" || a.state === "UNAVAILABLE") && a.failureCode) {
    rows.push({ label: "Reason", value: OTS_FAILURE_LABELS[a.failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED! });
  }
  rows.push({ label: facts.validator, value: a.validator });
  return rows;
}
