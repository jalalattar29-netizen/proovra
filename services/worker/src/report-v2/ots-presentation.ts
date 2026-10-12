/**
 * THE REPORT'S OPENTIMESTAMPS PRESENTATION (2026-10-12) — every OTS sentence,
 * status and technical row in the PDF comes from here, and here comes only
 * from the shared truth model (`resolveOtsTruth`). Nothing in report-v2 maps
 * an OTS status string to words on its own.
 *
 * The worker's recording time is "Proof recorded by PROOVRA (UTC)". A txid or
 * block height read from the proof is "Reported by the OpenTimestamps proof;
 * not independently verified" unless an independent chain check verified it,
 * and only that check's block time is ever a Bitcoin anchor time.
 */
import {
  OTS_PROOF_RECORDED_AT_LABEL,
  OTS_REPORTED_BY_PROOF_QUALIFIER,
  OTS_TRUTH_STATUS_LINES,
  checkOtsDigestBinding,
  formatTimestampForReportUtc,
  resolveOtsTruth,
  type CanonicalEvidenceMaterials,
  type OtsTruth,
} from "@proovra/shared";


import type { KeyValueRow, ReportEvidence } from "./types.js";

type OtsEvidenceFields = Pick<
  ReportEvidence,
  | "otsStatus"
  | "otsAnchoredAtUtc"
  | "otsAnchorCheck"
  | "otsBitcoinTxid"
  | "otsUpgradedAtUtc"
  | "otsProofBase64"
  | "otsHash"
  | "fingerprintHash"
  | "otsSubmittedAtUtc"
  | "otsAttestationRecordedAtUtc"
  | "otsAttestationBlockHeight"
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

/** The OTS truth for one report payload, its proof bytes bound to its fingerprint digest. */
export function reportOtsTruth(ev: Partial<OtsEvidenceFields>, now?: Date): OtsTruth {
  return resolveOtsTruth({
    status: ev.otsStatus ?? null,
    anchoredAtUtc: ev.otsAnchoredAtUtc ?? null,
    anchorCheck: ev.otsAnchorCheck ?? null,
    bitcoinTxid: ev.otsBitcoinTxid ?? null,
    proofPresent: Boolean(ev.otsProofBase64),
    upgradedAtUtc: ev.otsUpgradedAtUtc ?? null,
    submittedAtUtc: ev.otsSubmittedAtUtc ?? null,
    attestationRecordedAtUtc: ev.otsAttestationRecordedAtUtc ?? null,
    attestationBlockHeight: ev.otsAttestationBlockHeight ?? null,
    chainVerificationStatus: ev.otsChainVerificationStatus ?? null,
    chainCheckedAtUtc: ev.otsChainCheckedAtUtc ?? null,
    chainVerifiedAtUtc: ev.otsChainVerifiedAtUtc ?? null,
    chainBlockHeight: ev.otsChainBlockHeight ?? null,
    chainBlockHash: ev.otsChainBlockHash ?? null,
    chainBlockTimeUtc: ev.otsChainBlockTimeUtc ?? null,
    chainConfirmations: ev.otsChainConfirmations ?? null,
    chainVerifier: ev.otsChainVerifier ?? null,
    chainFailureCode: ev.otsChainFailureCode ?? null,
    digestBinding: ev.otsProofBase64
      ? checkOtsDigestBinding({
          proofBase64: ev.otsProofBase64,
          fingerprintHash: ev.fingerprintHash ?? null,
          otsHash: ev.otsHash ?? null,
        })
      : null,
    ...(now ? { now } : {}),
  });
}

/** The one status line for the canonical materials' OTS state. */
export function otsStatusLineFor(otsState: CanonicalEvidenceMaterials["otsState"]): string {
  // A legacy anchor whose check was never recorded is an unverified attestation.
  if (otsState.truthState === "UNKNOWN_OR_STALE" && (otsState.effectiveStatus ?? otsState.otsStatus) === "ANCHORED") {
    return OTS_TRUTH_STATUS_LINES.ATTESTATION_PRESENT_NOT_VERIFIED;
  }
  return OTS_TRUTH_STATUS_LINES[otsState.truthState];
}

const CHAIN_CHECK_WORDS: Readonly<Record<string, string>> = {
  NOT_CONFIGURED: "Not performed",
  UNAVAILABLE: "Unavailable",
  INSUFFICIENT_CONFIRMATIONS: "Not completed",
  FAILED: "Did not verify",
  VERIFIED: "Verified",
};

/**
 * The technical OTS rows. They name what each value IS: a recording time, a
 * value reported by the proof, or a value an independent chain check verified.
 */
export function buildOtsTruthRows(
  ev: Partial<OtsEvidenceFields> & { otsCalendar?: string | null },
  truth: OtsTruth = reportOtsTruth(ev),
): KeyValueRow[] {
  const rows: KeyValueRow[] = [{ label: "OpenTimestamps Status", value: truth.statusLine }];
  if (ev.otsHash) {
    const binding = ev.otsProofBase64
      ? checkOtsDigestBinding({ proofBase64: ev.otsProofBase64, fingerprintHash: ev.fingerprintHash ?? null, otsHash: ev.otsHash })
      : null;
    rows.push({
      label: "Digest Committed by the Proof (SHA-256)",
      value:
        binding?.kind === "MATCH"
          ? `${binding.committedDigestHex} (the record's fingerprint digest)`
          : binding?.kind === "MISMATCH"
            ? `${binding.committedDigestHex ?? "unknown"} (does NOT match the record's fingerprint digest)`
            : ev.otsHash,
    });
  }
  if (ev.otsCalendar) rows.push({ label: "OpenTimestamps Calendar", value: ev.otsCalendar });
  if (truth.proofRecordedAtUtc) {
    rows.push({ label: OTS_PROOF_RECORDED_AT_LABEL, value: formatTimestampForReportUtc(truth.proofRecordedAtUtc) });
  }
  if (truth.proofUpgradedAtUtc) {
    rows.push({ label: "Proof Upgraded by PROOVRA (UTC)", value: formatTimestampForReportUtc(truth.proofUpgradedAtUtc) });
  }
  if (truth.chain) {
    const c = truth.chain;
    if (truth.reported?.txid) rows.push({ label: "Bitcoin Transaction ID", value: truth.reported.txid });
    rows.push(
      { label: "Verified Bitcoin Block", value: `${c.blockHeight} (${c.blockHash})` },
      { label: "Verified Block Time (UTC)", value: formatTimestampForReportUtc(c.blockTimeUtc) },
      { label: "Confirmations at Verification", value: String(c.confirmations) },
      { label: "Independently Verified At (UTC)", value: formatTimestampForReportUtc(c.verifiedAtUtc) },
      { label: "Bitcoin Verifier", value: c.verifier },
    );
    return rows;
  }
  if (truth.reported?.txid) {
    rows.push({ label: "Bitcoin Transaction ID", value: `${truth.reported.txid} — ${OTS_REPORTED_BY_PROOF_QUALIFIER}` });
  }
  if (truth.reported?.blockHeight != null) {
    rows.push({ label: "Bitcoin Block Height", value: `${truth.reported.blockHeight} — ${OTS_REPORTED_BY_PROOF_QUALIFIER}` });
  }
  if (truth.chainCheck) {
    rows.push({
      label: "Independent Bitcoin Verification",
      value: CHAIN_CHECK_WORDS[truth.chainCheck.status] ?? truth.chainCheck.status,
    });
  }
  return rows;
}
