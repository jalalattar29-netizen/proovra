/**
 * TRUST DECISION (T-14 TrustDecisionSummary) — the record's trust signals, as
 * the review workspace carries them (`artifactVersions.trustDecision`,
 * evidence.routes.ts).
 *
 * Evidence-claims correction (2026-10-08): PROOVRA states each signal and a
 * bounded summary — never a score, a weighted point, an overall verdict, a
 * reliance level or a confidence. The payload is read through the shared
 * `readStoredTrustDecision`, so an older API or a stored snapshot that still
 * carries `score`, `verdictLabel`, `relianceLevel` or `points` is reduced to
 * the score-free shape before anything here sees it.
 *
 * Pure: no React, no fetch.
 */

import {
  VERIFICATION_LIMITATION,
  readStoredTrustDecision,
  toVerificationStatus,
  type TrustSignalState,
  type VerificationStatus, VERIFICATION_STATUS_LABELS } from "@proovra/shared";
import { otsVerificationFromAnchoringBucket, otsVerificationFromTrustSignal, type OtsVerificationKey } from "./ots-anchoring";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim().length > 0 ? v : null);

export interface TrustSignal {
  key: string;
  label: string;
  /** THE canonical state (re-read conservatively from older payloads). */
  state: TrustSignalState;
  /** The verification status shown for it: VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE. */
  status: VerificationStatus;
  summary: string | null;
  detail: string | null;
  /**
   * bitcoin_anchoring only: the canonical OTS verification key the signal
   * carries (render via ots-anchoring.ts otsCardForVerification). Only
   * CHAIN_VERIFIED is a verification; ATTESTATION_RECORDED is not.
   */
  otsVerification?: OtsVerificationKey;
}

export interface TrustDecision {
  /** The bounded summary sentence (ends with the fixed limitation). */
  summary: string;
  /** The fixed limitation, shown on its own when the summary does not carry it. */
  limitation: string;
  reviewerAction: string | null;
  /** The canonical OTS verification key of the decision's anchoring bucket (render via ots-anchoring.ts). */
  anchoring: OtsVerificationKey | null;
  /** A file-integrity, record-signature or custody check FAILED. */
  integrityReviewRequired: boolean;
  signals: TrustSignal[];
}

/** Null when no signal is recorded (the web's "not yet available"). */
export function projectTrustDecision(rw: unknown): TrustDecision | null {
  const decision = readStoredTrustDecision(obj(obj(rw).artifactVersions).trustDecision);
  if (!decision) return null;
  return {
    summary: decision.summary,
    limitation: VERIFICATION_LIMITATION,
    reviewerAction: str(decision.reviewerAction),
    anchoring: decision.anchoringState ? otsVerificationFromAnchoringBucket(decision.anchoringState) : null,
    integrityReviewRequired: decision.integrityReviewRequired,
    signals: decision.signals.map((s) => ({
      key: s.key,
      label: s.label,
      state: s.state,
      status: toVerificationStatus(s.state),
      summary: str(s.summary),
      detail: str(s.detail),
      ...(s.key === "bitcoin_anchoring" ? { otsVerification: otsVerificationFromTrustSignal(s.state, s.otsVerification) } : {}),
    })),
  };
}

/** The status word and its native tone. "VERIFIED" is reserved for a PASSED check. */
export function verificationStatusBadge(status: VerificationStatus): { label: string; tone: "verified" | "pending" | "risk" | "neutral" } {
  // AUD-47 (2026-10-20) — NOT_CHECKED is neutral on every surface (THE shared VERIFICATION_STATUS_TONES): not checked is not a warning. The label is the reader's word, never the code.
  const tone = status === "VERIFIED" ? "verified" : status === "FAILED" ? "risk" : "neutral";
  return { label: VERIFICATION_STATUS_LABELS[status] ?? status, tone };
}

export const TRUST_STATUS_BOUNDARY =
  "Each signal is reported on its own. NOT_CHECKED means PROOVRA did not independently verify that signal; there is no overall score.";
