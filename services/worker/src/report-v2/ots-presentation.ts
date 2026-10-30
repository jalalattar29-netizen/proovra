/**
 * THE REPORT'S OPENTIMESTAMPS PRESENTATION (2026-10-13) — every OTS status,
 * sentence and technical row in the PDF comes from here, and here comes only
 * from the canonical anchoring state (`resolveOtsAnchoring`, packages/shared
 * ots-anchoring.ts). Nothing in report-v2 maps an OTS status string to words
 * on its own.
 *
 *   card      "Bitcoin anchoring" — the canonical verification's word and
 *             one sentence. ✓ ONLY for "Independently verified against the
 *             Bitcoin main chain"; an attestation the proof merely names is
 *             "Attestation recorded — Not independently checked against Bitcoin"
 *   appendix  the facts the stored proof yields, the chain-check facts when a
 *             check is recorded, and — once — the boundary of what PROOVRA
 *             establishes
 *
 * A txid appears only when the executed proof path derived it. The anchored
 * time is when PROOVRA recorded the anchor, never a Bitcoin block time.
 */
import {
  OTS_ANCHORING_COPY,
  OTS_FAILURE_LABELS,
  OTS_STATE_LABELS,
  OTS_STATE_WORDS,
  OTS_VERIFICATION_LABELS,
  OTS_REPORT_SNAPSHOT_LABELS,
  OTS_REPORT_SNAPSHOT_SENTENCES,
  otsVerificationSentence,
  OTS_VERIFICATION_WORDS,
  formatTimestampForReportUtc,
  otsReportBoundaryFor,
  otsChainRecordOf,
  resolveOtsAnchoring,
  type OtsAnchoring,
  type OtsState,
  type OtsVerificationKey,
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
  | "otsChainVerificationStatus"
  | "otsChainCheckedAtUtc"
  | "otsChainVerifiedAtUtc"
  | "otsChainBlockHeight"
  | "otsChainBlockHash"
  | "otsChainBlockTimeUtc"
  | "otsChainConfirmations"
  | "otsChainVerifier"
  | "otsChainFailureCode"
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
    chain: otsChainRecordOf(ev),
  });
}

/** The verification word beside "Bitcoin anchoring" (cover, index, cards). */
export function otsVerificationWordFor(key: OtsVerificationKey): string {
  return OTS_VERIFICATION_WORDS[key];
}

/**
 * AUD-48 (2026-10-20) — a report is a SNAPSHOT: an operational outage at
 * render time ("temporarily unavailable", "cannot currently be read") would
 * become permanent text in an immutable PDF. The report states what was true
 * when it was issued instead; live surfaces keep the shared live wording.
 */
export const REPORT_SNAPSHOT_OTS_LABELS = OTS_REPORT_SNAPSHOT_LABELS;
export const REPORT_SNAPSHOT_OTS_SENTENCES = OTS_REPORT_SNAPSHOT_SENTENCES;

/** The standalone verification label ("Bitcoin attestation recorded", "Independently verified against the Bitcoin main chain", …). */
export function otsVerificationLabelFor(key: OtsVerificationKey): string {
  return REPORT_SNAPSHOT_OTS_LABELS[key] ?? OTS_VERIFICATION_LABELS[key];
}

/** The verification sentence as of issue (snapshot wording for an outage at render time). */
export function otsReportVerificationSentence(
  a: Parameters<typeof otsVerificationSentence>[0],
  formatTime: (iso: string) => string,
): string {
  const key = a.verification as OtsVerificationKey;
  return REPORT_SNAPSHOT_OTS_SENTENCES[key] ?? otsVerificationSentence(a, "en", formatTime);
}

/** The status word beside "Bitcoin anchoring" (cover, index, cards). */
export function otsStatusWordFor(state: OtsState): string {
  return OTS_STATE_WORDS[state];
}

/** The standalone label ("Bitcoin anchored", "Bitcoin anchoring pending", …). */
export function otsStatusLineFor(state: OtsState): string {
  return OTS_STATE_LABELS[state];
}

/**
 * The boundary sentence, stated once in the technical appendix for an anchored
 * proof: the report's own wording (the rendered-report gate reads the same).
 */
export function otsReportBoundary(a: Pick<OtsAnchoring, "verification">): string | null {
  return otsReportBoundaryFor(a);
}

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
  const rows: KeyValueRow[] = [{ label: "Bitcoin Anchoring", value: OTS_VERIFICATION_WORDS[a.verification] }];
  if (a.state === "NOT_REQUESTED") return rows;
  if (a.committedDigestHex) rows.push({ label: facts.digest, value: a.committedDigestHex });
  if (a.proofSha256) {
    rows.push({ label: facts.proofSha256, value: a.proofSha256 });
    rows.push({
      label: "Proof Reference",
      // 2026-10-20 (AUD-18): the proof file, never the internal evidence id.
      value: `opentimestamps-proof.ots (sha256:${a.proofSha256.slice(0, 16)})`,
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
  if (a.state === "ANCHORED") {
    // The independent Bitcoin-chain check: its outcome, and its facts when it named a block.
    rows.push({ label: facts.chainStatus, value: otsVerificationLabelFor(a.verification) });
    const c = a.chain;
    if (c && (c.status === "VERIFIED" || c.status === "INSUFFICIENT_CONFIRMATIONS")) {
      if (c.blockHash) rows.push({ label: facts.blockHash, value: c.blockHash });
      if (c.blockTimeUtc) rows.push({ label: facts.blockTime, value: formatTimestampForReportUtc(c.blockTimeUtc) });
      if (c.confirmations != null) {
        rows.push({ label: facts.confirmations, value: c.minConfirmations != null ? `${c.confirmations} (policy: ${c.minConfirmations})` : String(c.confirmations) });
      }
    }
    if (c?.checkedAtUtc) rows.push({ label: facts.checkedAt, value: formatTimestampForReportUtc(c.checkedAtUtc) });
    if (c?.verifiedAtUtc) rows.push({ label: facts.verifiedAt, value: formatTimestampForReportUtc(c.verifiedAtUtc) });
    if (c?.verifier) rows.push({ label: facts.verifier, value: c.verifier });
  }
  if ((a.state === "FAILED" || a.state === "UNAVAILABLE") && a.failureCode) {
    rows.push({ label: "Reason", value: OTS_FAILURE_LABELS[a.failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED! });
  }
  rows.push({ label: facts.validator, value: a.validator });
  return rows;
}
