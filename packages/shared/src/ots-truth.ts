/**
 * THE OPENTIMESTAMPS TRUTH MODEL (2026-10-12) — one projection for the worker,
 * the API, the report, the verification package and Public Verify.
 *
 * Three facts used to be collapsed into "anchored":
 *   1. the proof CARRIES a Bitcoin attestation (read offline from its bytes);
 *   2. PROOVRA RECORDED that proof at some moment (a worker clock reading);
 *   3. the attestation was INDEPENDENTLY VERIFIED against the Bitcoin chain.
 * Only (3) establishes a Bitcoin anchor, and only (3) has a block time. The
 * worker's observation time was written into `ots_anchored_at_utc` and shown as
 * "OTS anchored at"; it is the time PROOVRA recorded the proof, nothing more.
 *
 * States:
 *   NOT_REQUESTED                      no OpenTimestamps proof for this record
 *   PENDING                            no usable Bitcoin attestation yet
 *   ATTESTATION_PRESENT_NOT_VERIFIED   the proof commits to the fingerprint digest
 *                                      and carries a Bitcoin attestation; PROOVRA
 *                                      has not verified it against Bitcoin
 *   CHAIN_VERIFICATION_UNAVAILABLE     a configured verifier could not be reached;
 *                                      NOT a verification failure
 *   CHAIN_VERIFICATION_FAILED          a configured verifier ran and the proof,
 *                                      block or commitment did not verify
 *   CHAIN_VERIFIED                     independently verified, with the verifier,
 *                                      time, block height/hash/time and
 *                                      confirmations recorded
 *   PROOF_INVALID                      the proof does not commit to this record's
 *                                      fingerprint, cannot be read, or was
 *                                      abandoned (budget exhausted)
 *   UNKNOWN_OR_STALE                   stored data cannot establish any of the above
 *
 * A txid, a block height read from the proof, an `ANCHORED` status or an
 * anchored-at time is never enough for CHAIN_VERIFIED. Missing inputs only
 * ever lower a state, never raise it.
 */
import {
  isValidOtsBitcoinTxid,
  normalizeOtsAnchorCheck,
  resolveEffectiveOtsStatus,
  type OtsAnchorClaim,
} from "./ots.js";
import { checkOtsDigestBinding, type OtsDigestBinding } from "./ots-proof.js";

export const OTS_TRUTH_STATES = [
  "NOT_REQUESTED",
  "PENDING",
  "ATTESTATION_PRESENT_NOT_VERIFIED",
  "CHAIN_VERIFICATION_UNAVAILABLE",
  "CHAIN_VERIFICATION_FAILED",
  "CHAIN_VERIFIED",
  "PROOF_INVALID",
  "UNKNOWN_OR_STALE",
] as const;
export type OtsTruthState = (typeof OTS_TRUTH_STATES)[number];

/** evidence.ots_chain_verification_status — the outcome of the latest independent check. */
export const OTS_CHAIN_VERIFICATION_STATUSES = [
  "NOT_CONFIGURED",
  "UNAVAILABLE",
  "INSUFFICIENT_CONFIRMATIONS",
  "FAILED",
  "VERIFIED",
] as const;
export type OtsChainVerificationStatus = (typeof OTS_CHAIN_VERIFICATION_STATUSES)[number];

export function normalizeOtsChainVerificationStatus(value: unknown): OtsChainVerificationStatus | null {
  return typeof value === "string" && (OTS_CHAIN_VERIFICATION_STATUSES as readonly string[]).includes(value)
    ? (value as OtsChainVerificationStatus)
    : null;
}

/** Bounded failure vocabulary for a chain check that ran and did not verify. */
export const OTS_CHAIN_FAILURE_CODES = [
  "ATTESTATION_NOT_IN_CHAIN",
  "BLOCK_NOT_FOUND",
  "BLOCK_HEIGHT_MISMATCH",
  "NO_BITCOIN_ATTESTATION",
  "VERIFIER_REJECTED_PROOF",
] as const;
export type OtsChainFailureCode = (typeof OTS_CHAIN_FAILURE_CODES)[number];

export const OTS_PROOF_RECORDED_AT_LABEL = "Proof recorded by PROOVRA (UTC)";
export const OTS_REPORTED_BY_PROOF_QUALIFIER = "Reported by the OpenTimestamps proof; not independently verified";
export const OTS_NOT_INDEPENDENTLY_VERIFIED = "Not independently verified against the Bitcoin blockchain";

/** Days after which a still-pending proof is no longer called pending. */
export const OTS_TRUTH_PENDING_STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

type DateLike = Date | string | null | undefined;

function iso(v: DateLike): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function posInt(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

export type OtsTruthInput = {
  /** evidence.ots_status */
  status: string | null | undefined;
  /** evidence.ots_anchored_at_utc — LEGACY completeness marker; see header. */
  anchoredAtUtc: DateLike;
  /** evidence.ots_anchor_check */
  anchorCheck: string | null | undefined;
  /** evidence.ots_bitcoin_txid — read from the proof by `ots info`. */
  bitcoinTxid?: string | null;
  proofPresent?: boolean | null;
  /** evidence.ots_upgraded_at_utc — when PROOVRA last upgraded the proof. */
  upgradedAtUtc?: DateLike;
  /** When the proof was requested; drives staleness of a pending proof. */
  submittedAtUtc?: DateLike;
  /** evidence.ots_attestation_recorded_at_utc */
  attestationRecordedAtUtc?: DateLike;
  /** evidence.ots_attestation_block_height — reported by the proof, unverified. */
  attestationBlockHeight?: number | string | null;
  /** evidence.ots_chain_* — the latest independent chain check. */
  chainVerificationStatus?: string | null;
  chainCheckedAtUtc?: DateLike;
  chainVerifiedAtUtc?: DateLike;
  chainBlockHeight?: number | string | null;
  chainBlockHash?: string | null;
  chainBlockTimeUtc?: DateLike;
  chainConfirmations?: number | string | null;
  chainVerifier?: string | null;
  chainFailureCode?: string | null;
  /**
   * The proof's digest binding, when the caller holds the proof bytes. A
   * MISMATCH or UNREADABLE binding is PROOF_INVALID whatever the row says.
   */
  digestBinding?: OtsDigestBinding | null;
  now?: Date;
};

export type OtsChainEvidence = {
  verifier: string;
  verifiedAtUtc: string;
  blockHeight: number;
  blockHash: string;
  blockTimeUtc: string;
  confirmations: number;
};

export type OtsTruth = {
  state: OtsTruthState;
  /** The six-value claim older readers still consume, derived from `state`. */
  claim: OtsAnchorClaim;
  /** Primary reviewer-facing statement. Never a raw code. */
  headline: string;
  /** ONE line for status rows and package labels — the same text on every surface. */
  statusLine: string;
  /** Second sentence, always shown beside the headline. */
  detail: string;
  /** When PROOVRA recorded the attestation-bearing proof. Never an anchor time. */
  proofRecordedAtUtc: string | null;
  /** When PROOVRA last upgraded the proof. */
  proofUpgradedAtUtc: string | null;
  /** Values the proof itself reports. Unverified unless `chain` is present. */
  reported: { txid: string | null; blockHeight: number | null; qualifier: string } | null;
  /** Populated only for CHAIN_VERIFIED, from the independent check. */
  chain: OtsChainEvidence | null;
  /** The latest chain check, whatever its outcome. */
  chainCheck: { status: OtsChainVerificationStatus; checkedAtUtc: string | null; failureCode: string | null } | null;
  /** The only Bitcoin anchor time any surface may show: the verified block time. */
  verifiedAnchorTimeUtc: string | null;
};

const HEX64 = /^[0-9a-f]{64}$/i;

/** The recorded chain evidence, or null unless every field of a verified check is present. */
export function completeOtsChainEvidence(input: OtsTruthInput): OtsChainEvidence | null {
  if (normalizeOtsChainVerificationStatus(input.chainVerificationStatus) !== "VERIFIED") return null;
  const verifiedAtUtc = iso(input.chainVerifiedAtUtc);
  const blockHeight = posInt(input.chainBlockHeight);
  const blockHash = typeof input.chainBlockHash === "string" && HEX64.test(input.chainBlockHash) ? input.chainBlockHash.toLowerCase() : null;
  const blockTimeUtc = iso(input.chainBlockTimeUtc);
  const confirmations = posInt(input.chainConfirmations);
  const verifier = typeof input.chainVerifier === "string" && input.chainVerifier.trim() ? input.chainVerifier.trim() : null;
  if (!verifiedAtUtc || blockHeight === null || !blockHash || !blockTimeUtc || !confirmations || !verifier) return null;
  return { verifier, verifiedAtUtc, blockHeight, blockHash, blockTimeUtc, confirmations };
}

/**
 * THE CUSTOMER-FACING OTS VOCABULARY (2026-10-12): four words and one short
 * sentence. The eight internal states stay internal; every reader-facing
 * surface (report card, Public Verify summary, apps, package summaries) says
 * one of these, and technical detail lives only in technical materials.
 */
export const OTS_PRESENTATION_TITLE = "OpenTimestamps";
export const OTS_PUBLIC_STATUSES = ["Pending", "Attestation recorded", "Verified", "Unavailable"] as const;
export type OtsPublicStatus = (typeof OTS_PUBLIC_STATUSES)[number];

const COPY: Readonly<Record<OtsTruthState, { headline: OtsPublicStatus; detail: string }>> = {
  NOT_REQUESTED: { headline: "Unavailable", detail: "No OpenTimestamps proof was requested for this record." },
  PENDING: { headline: "Pending", detail: "The anchoring proof is still being prepared." },
  ATTESTATION_PRESENT_NOT_VERIFIED: { headline: "Attestation recorded", detail: "Independent Bitcoin verification was not performed." },
  CHAIN_VERIFICATION_UNAVAILABLE: { headline: "Attestation recorded", detail: "Independent verification is currently unavailable." },
  // Never presented on a published report or package: publication is refused.
  CHAIN_VERIFICATION_FAILED: { headline: "Unavailable", detail: "The proof did not verify against the Bitcoin blockchain." },
  CHAIN_VERIFIED: { headline: "Verified", detail: "The proof was independently verified against the Bitcoin blockchain." },
  PROOF_INVALID: { headline: "Unavailable", detail: "Bitcoin anchoring did not complete for this record." },
  UNKNOWN_OR_STALE: { headline: "Unavailable", detail: "The anchoring state could not be established." },
};

/** ONE status word per state — the same on every surface. */
export const OTS_TRUTH_STATUS_LINES: Readonly<Record<OtsTruthState, OtsPublicStatus>> = {
  NOT_REQUESTED: COPY.NOT_REQUESTED.headline,
  PENDING: COPY.PENDING.headline,
  ATTESTATION_PRESENT_NOT_VERIFIED: COPY.ATTESTATION_PRESENT_NOT_VERIFIED.headline,
  CHAIN_VERIFICATION_UNAVAILABLE: COPY.CHAIN_VERIFICATION_UNAVAILABLE.headline,
  CHAIN_VERIFICATION_FAILED: COPY.CHAIN_VERIFICATION_FAILED.headline,
  CHAIN_VERIFIED: COPY.CHAIN_VERIFIED.headline,
  PROOF_INVALID: COPY.PROOF_INVALID.headline,
  UNKNOWN_OR_STALE: COPY.UNKNOWN_OR_STALE.headline,
};

/** The one explanatory sentence per state. */
export const OTS_TRUTH_SENTENCES: Readonly<Record<OtsTruthState, string>> = Object.fromEntries(
  Object.entries(COPY).map(([k, v]) => [k, v.detail]),
) as Record<OtsTruthState, string>;

export type OtsPresentation = {
  title: typeof OTS_PRESENTATION_TITLE;
  status: OtsPublicStatus;
  sentence: string;
  /** "Recorded by PROOVRA" (when the proof was recorded) or "Verified" — never an anchor time. */
  dateLabel: "Recorded by PROOVRA" | "Verified" | null;
  dateUtc: string | null;
};

/** THE OTS card: title, one status, one sentence, at most one date. */
export function presentOtsTruth(truth: Pick<OtsTruth, "state" | "proofRecordedAtUtc" | "chain">): OtsPresentation {
  const copy = COPY[truth.state];
  const attestation = truth.state === "ATTESTATION_PRESENT_NOT_VERIFIED" || truth.state === "CHAIN_VERIFICATION_UNAVAILABLE";
  const verified = truth.state === "CHAIN_VERIFIED" && truth.chain;
  return {
    title: OTS_PRESENTATION_TITLE,
    status: copy.headline,
    sentence: copy.detail,
    dateLabel: verified ? "Verified" : attestation && truth.proofRecordedAtUtc ? "Recorded by PROOVRA" : null,
    dateUtc: verified ? truth.chain!.verifiedAtUtc : attestation ? truth.proofRecordedAtUtc : null,
  };
}

/**
 * THE PUBLICATION POLICY (2026-10-12). A proof that does not commit to the
 * record's fingerprint digest, cannot be read, or that an independent Bitcoin
 * check ran against and did NOT verify, is a cryptographic-integrity failure:
 * no report or verification package is published from it (refused with
 * OTS_PROOF_DIGEST_MISMATCH, deterministically, on every retry). A correctly
 * bound proof that was simply not independently verified — no verifier, or the
 * verifier unreachable — publishes as "Attestation recorded".
 */
export function otsBlocksPublication(input: {
  digestBinding: OtsDigestBinding["kind"] | "NOT_EVALUATED" | null | undefined;
  truthState: OtsTruthState;
}): boolean {
  return (
    input.digestBinding === "MISMATCH" ||
    input.digestBinding === "UNREADABLE" ||
    input.truthState === "CHAIN_VERIFICATION_FAILED"
  );
}

const CLAIM: Readonly<Record<OtsTruthState, OtsAnchorClaim>> = {
  NOT_REQUESTED: "NOT_CONFIGURED",
  PENDING: "PENDING",
  ATTESTATION_PRESENT_NOT_VERIFIED: "ANCHORED_NOT_CHECKED",
  CHAIN_VERIFICATION_UNAVAILABLE: "ANCHORED_NOT_CHECKED",
  CHAIN_VERIFICATION_FAILED: "FAILED",
  CHAIN_VERIFIED: "VERIFIED",
  PROOF_INVALID: "FAILED",
  UNKNOWN_OR_STALE: "PENDING",
};

function decideState(input: OtsTruthInput): OtsTruthState {
  const binding = input.digestBinding;
  if (binding && (binding.kind === "MISMATCH" || binding.kind === "UNREADABLE")) return "PROOF_INVALID";

  const effective = resolveEffectiveOtsStatus({ status: input.status, anchoredAtUtc: input.anchoredAtUtc });
  if (effective === "FAILED") return "PROOF_INVALID";

  if (effective === "ANCHORED") {
    const check = normalizeOtsAnchorCheck(input.anchorCheck);
    if (check === "BITCOIN_VERIFIED") {
      // Recorded as chain-checked but without the chain evidence (rows written
      // before ots_chain_* existed): the attestation exists, verification is
      // not claimable.
      return completeOtsChainEvidence(input) && isValidOtsBitcoinTxid(input.bitcoinTxid ?? null)
        ? "CHAIN_VERIFIED"
        : "ATTESTATION_PRESENT_NOT_VERIFIED";
    }
    // Anchored before the check was recorded: how it was established is unknown.
    if (check === null) return "UNKNOWN_OR_STALE";
    switch (normalizeOtsChainVerificationStatus(input.chainVerificationStatus)) {
      case "FAILED":
        return "CHAIN_VERIFICATION_FAILED";
      case "UNAVAILABLE":
        return "CHAIN_VERIFICATION_UNAVAILABLE";
      default:
        return "ATTESTATION_PRESENT_NOT_VERIFIED";
    }
  }

  if (effective === "PENDING" || (effective !== "DISABLED" && input.proofPresent)) {
    const now = input.now ?? new Date();
    const since = iso(input.submittedAtUtc);
    if (since && now.getTime() - new Date(since).getTime() > OTS_TRUTH_PENDING_STALE_AFTER_DAYS * DAY_MS) {
      return "UNKNOWN_OR_STALE";
    }
    return "PENDING";
  }
  return "NOT_REQUESTED";
}

export function resolveOtsTruth(input: OtsTruthInput): OtsTruth {
  const state = decideState(input);
  const effective = resolveEffectiveOtsStatus({ status: input.status, anchoredAtUtc: input.anchoredAtUtc });
  const check = normalizeOtsAnchorCheck(input.anchorCheck);
  const chain = state === "CHAIN_VERIFIED" ? completeOtsChainEvidence(input) : null;

  // COMPATIBILITY PROJECTION — rows written before ots_attestation_recorded_at_utc
  // existed carry the worker's recording time in ots_anchored_at_utc for every
  // anchor that was not chain-verified. That value is the recording time.
  const proofRecordedAtUtc =
    iso(input.attestationRecordedAtUtc) ??
    (effective === "ANCHORED" && check !== "BITCOIN_VERIFIED" ? iso(input.anchoredAtUtc) : null);

  const hasAttestation =
    state === "ATTESTATION_PRESENT_NOT_VERIFIED" ||
    state === "CHAIN_VERIFICATION_UNAVAILABLE" ||
    state === "CHAIN_VERIFICATION_FAILED" ||
    state === "CHAIN_VERIFIED";
  const reportedTxid = isValidOtsBitcoinTxid(input.bitcoinTxid ?? null) ? input.bitcoinTxid!.trim().toLowerCase() : null;
  const reportedHeight =
    posInt(input.attestationBlockHeight) ??
    (input.digestBinding?.kind === "MATCH" && input.digestBinding.bitcoinBlockHeights.length > 0
      ? Math.max(...input.digestBinding.bitcoinBlockHeights)
      : null);

  const chainStatus = normalizeOtsChainVerificationStatus(input.chainVerificationStatus);
  const copy = COPY[state];
  // ONE sentence. The block, confirmations and verification time are
  // technical material: they travel in `chain`, never in the sentence.
  const detail = copy.detail;

  // An anchor recorded before the check existed is stale/unknown, but its claim
  // stays "attestation, chain not checked" — it is not a pending proof.
  const claim = state === "UNKNOWN_OR_STALE" && effective === "ANCHORED" ? "ANCHORED_NOT_CHECKED" : CLAIM[state];

  return {
    state,
    claim,
    headline: copy.headline,
    // A legacy anchor whose check was never recorded still reads as an
    // attestation that was not verified — never "pending".
    statusLine:
      state === "UNKNOWN_OR_STALE" && effective === "ANCHORED"
        ? OTS_TRUTH_STATUS_LINES.ATTESTATION_PRESENT_NOT_VERIFIED
        : OTS_TRUTH_STATUS_LINES[state],
    detail,
    proofRecordedAtUtc: hasAttestation || state === "UNKNOWN_OR_STALE" ? proofRecordedAtUtc : null,
    proofUpgradedAtUtc: iso(input.upgradedAtUtc),
    reported:
      hasAttestation && (reportedTxid || reportedHeight !== null)
        ? { txid: reportedTxid, blockHeight: reportedHeight, qualifier: OTS_REPORTED_BY_PROOF_QUALIFIER }
        : null,
    chain,
    chainCheck: chainStatus
      ? {
          status: chainStatus,
          checkedAtUtc: iso(input.chainCheckedAtUtc),
          failureCode: chainStatus === "FAILED" ? String(input.chainFailureCode ?? "VERIFIER_REJECTED_PROOF") : null,
        }
      : null,
    verifiedAnchorTimeUtc: chain ? chain.blockTimeUtc : null,
  };
}

/** True only for a proof independently verified against the Bitcoin chain. */
export function isOtsChainVerified(truth: Pick<OtsTruth, "state">): boolean {
  return truth.state === "CHAIN_VERIFIED";
}

/**
 * The evidence row's OTS columns, as every reader selects them. The proof
 * bytes and the fingerprint digest are optional: without them the binding is
 * not evaluated (and nothing is promoted by its absence).
 */
export type OtsRecordColumns = {
  otsStatus?: string | null;
  otsAnchoredAtUtc?: Date | string | null;
  otsAnchorCheck?: string | null;
  otsBitcoinTxid?: string | null;
  otsUpgradedAtUtc?: Date | string | null;
  otsProofBase64?: string | null;
  otsHash?: string | null;
  fingerprintHash?: string | null;
  otsAttestationRecordedAtUtc?: Date | string | null;
  otsAttestationBlockHeight?: number | null;
  otsChainVerificationStatus?: string | null;
  otsChainCheckedAtUtc?: Date | string | null;
  otsChainVerifiedAtUtc?: Date | string | null;
  otsChainBlockHeight?: number | null;
  otsChainBlockHash?: string | null;
  otsChainBlockTimeUtc?: Date | string | null;
  otsChainConfirmations?: number | null;
  otsChainVerifier?: string | null;
  otsChainFailureCode?: string | null;
};

/** The selection every OTS reader adds to its evidence query (Prisma field names). */
export const OTS_TRUTH_RECORD_SELECT = {
  otsStatus: true,
  otsAnchoredAtUtc: true,
  otsAnchorCheck: true,
  otsBitcoinTxid: true,
  otsUpgradedAtUtc: true,
  otsProofBase64: true,
  otsHash: true,
  fingerprintHash: true,
  otsAttestationRecordedAtUtc: true,
  otsAttestationBlockHeight: true,
  otsChainVerificationStatus: true,
  otsChainCheckedAtUtc: true,
  otsChainVerifiedAtUtc: true,
  otsChainBlockHeight: true,
  otsChainBlockHash: true,
  otsChainBlockTimeUtc: true,
  otsChainConfirmations: true,
  otsChainVerifier: true,
  otsChainFailureCode: true,
} as const;

/** The OTS truth of one evidence row, its proof bytes bound to its fingerprint digest. */
export function resolveRecordOtsTruth(
  row: OtsRecordColumns,
  opts: { now?: Date; submittedAtUtc?: Date | string | null } = {},
): OtsTruth {
  return resolveOtsTruth({
    status: row.otsStatus ?? null,
    anchoredAtUtc: row.otsAnchoredAtUtc ?? null,
    anchorCheck: row.otsAnchorCheck ?? null,
    bitcoinTxid: row.otsBitcoinTxid ?? null,
    proofPresent: Boolean(row.otsProofBase64),
    upgradedAtUtc: row.otsUpgradedAtUtc ?? null,
    submittedAtUtc: opts.submittedAtUtc ?? null,
    attestationRecordedAtUtc: row.otsAttestationRecordedAtUtc ?? null,
    attestationBlockHeight: row.otsAttestationBlockHeight ?? null,
    chainVerificationStatus: row.otsChainVerificationStatus ?? null,
    chainCheckedAtUtc: row.otsChainCheckedAtUtc ?? null,
    chainVerifiedAtUtc: row.otsChainVerifiedAtUtc ?? null,
    chainBlockHeight: row.otsChainBlockHeight ?? null,
    chainBlockHash: row.otsChainBlockHash ?? null,
    chainBlockTimeUtc: row.otsChainBlockTimeUtc ?? null,
    chainConfirmations: row.otsChainConfirmations ?? null,
    chainVerifier: row.otsChainVerifier ?? null,
    chainFailureCode: row.otsChainFailureCode ?? null,
    digestBinding:
      row.otsProofBase64 && row.fingerprintHash !== undefined
        ? checkOtsDigestBinding({ proofBase64: row.otsProofBase64, fingerprintHash: row.fingerprintHash, otsHash: row.otsHash ?? null })
        : null,
    ...(opts.now ? { now: opts.now } : {}),
  });
}
