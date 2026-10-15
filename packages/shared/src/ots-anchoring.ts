/**
 * THE OPENTIMESTAMPS ANCHORING STATE — the ONE authority.
 *
 * PROOVRA's evidentiary trust rests on SHA-256 integrity, signatures, RFC 3161
 * timestamps, the custody hash chain, immutable storage and the verification
 * package. OpenTimestamps adds a public Bitcoin anchor on top of that, and its
 * state is decided here — from the stored proof's own bytes, executed against
 * the record's canonical evidence digest (ots-proof.ts), plus the independent
 * Bitcoin-chain verification fact the worker records (ots-chain-verification.ts)
 * — and nowhere else. Worker, API, report, verification package, Public Verify,
 * web and mobile all carry what this resolves; none re-derives it from a txid,
 * a block height, a timestamp or a status string.
 *
 * ONE LIFECYCLE (`state`, persisted as evidence.ots_status):
 *
 *   NOT_REQUESTED  anchoring was not requested (or is disabled) for the record
 *   PENDING        the digest is at one or more calendars; the stored proof
 *                  carries no usable Bitcoin block attestation yet
 *   ANCHORED       the stored proof commits from the record's digest through
 *                  its executed operations to a Bitcoin block-height
 *                  attestation. It NAMES a block. It is NOT a verification:
 *                  nothing about the Bitcoin chain was checked to reach it.
 *   FAILED         a genuine terminal proof defect (malformed proof, digest
 *                  mismatch, unsupported operation, invalid attestation,
 *                  exhausted upgrade attempts), with a bounded code
 *   UNAVAILABLE    the record references proof material that cannot currently
 *                  be read (missing bytes, no digest to bind them to)
 *
 * ONE PRESENTATION (`verification`), derived — never persisted on its own:
 * an ANCHORED proof is further qualified by the chain fact bound to it.
 *
 *   ATTESTATION_RECORDED         ANCHORED, never independently checked
 *   CHAIN_CONFIRMATIONS_PENDING  matches an active-chain block, not deep enough
 *   CHAIN_UNAVAILABLE            the verifier could not check (retryable)
 *   CHAIN_FAILED                 the chain contradicts the proof
 *   CHAIN_VERIFIED               matches a confirmed block of the active main
 *                                chain — the ONLY success, green or "verified"
 */
import { boundedOtsFailureCode, normalizeOtsStatusValue } from "./ots.js";
import { checkOtsDigestBinding, otsProofSha256Hex, OTS_PROOF_VALIDATOR } from "./ots-proof.js";
import {
  bindOtsChainRecord,
  parseOtsChainFailureCode,
  parseOtsChainStatus,
  type OtsChainFacts,
  type OtsChainRecord,
} from "./ots-chain-verification.js";

export const OTS_STATES = ["NOT_REQUESTED", "PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"] as const;
export type OtsState = (typeof OTS_STATES)[number];

/** A state a server sent. Anything else — including a future value — reads as UNAVAILABLE, never anchored. */
export function parseOtsState(value: unknown): OtsState {
  return typeof value === "string" && (OTS_STATES as readonly string[]).includes(value) ? (value as OtsState) : "UNAVAILABLE";
}

/** The derived presentation of one record's OpenTimestamps truth. */
export const OTS_VERIFICATION_KEYS = [
  "NOT_REQUESTED",
  "PENDING",
  "ATTESTATION_RECORDED",
  "CHAIN_CONFIRMATIONS_PENDING",
  "CHAIN_UNAVAILABLE",
  "CHAIN_FAILED",
  "CHAIN_VERIFIED",
  "FAILED",
  "UNAVAILABLE",
] as const;
export type OtsVerificationKey = (typeof OTS_VERIFICATION_KEYS)[number];

export function parseOtsVerificationKey(value: unknown): OtsVerificationKey | null {
  return typeof value === "string" && (OTS_VERIFICATION_KEYS as readonly string[]).includes(value)
    ? (value as OtsVerificationKey)
    : null;
}

/** The verification key of a state with no chain fact (the conservative reading). */
export function otsVerificationKeyOfState(state: OtsState): OtsVerificationKey {
  return state === "ANCHORED" ? "ATTESTATION_RECORDED" : state;
}

/** The verification key of a state qualified by its (already bound) chain fact. */
export function deriveOtsVerificationKey(state: OtsState, chain: Pick<OtsChainFacts, "status"> | null): OtsVerificationKey {
  if (state !== "ANCHORED") return otsVerificationKeyOfState(state);
  switch (chain?.status) {
    case "VERIFIED":
      return "CHAIN_VERIFIED";
    case "INSUFFICIENT_CONFIRMATIONS":
      return "CHAIN_CONFIRMATIONS_PENDING";
    case "UNAVAILABLE":
      return "CHAIN_UNAVAILABLE";
    case "FAILED":
      return "CHAIN_FAILED";
    default:
      return "ATTESTATION_RECORDED";
  }
}

/** The ONE predicate for a positive Bitcoin claim. */
export function isOtsChainVerified(a: { verification?: unknown } | null | undefined): boolean {
  return parseOtsVerificationKey(a?.verification) === "CHAIN_VERIFIED";
}

/** Proof-integrity failures: no report or package is published from such a proof. */
export const OTS_PROOF_INTEGRITY_FAILURES = [
  "MALFORMED_PROOF",
  "PROOF_HASH_MISMATCH",
  "UNSUPPORTED_PROOF_OPERATION",
  "INVALID_ATTESTATION",
] as const;
export type OtsProofIntegrityFailure = (typeof OTS_PROOF_INTEGRITY_FAILURES)[number];

/** Why proof material is unavailable. */
export const OTS_UNAVAILABLE_CODES = ["PROOF_MATERIAL_MISSING", "FINGERPRINT_MISSING"] as const;
export type OtsUnavailableCode = (typeof OTS_UNAVAILABLE_CODES)[number];

export type OtsAnchoringInput = {
  /** evidence.ots_status as stored (PENDING | ANCHORED | FAILED | DISABLED | null). */
  status: string | null | undefined;
  /** evidence.ots_proof_base64 — the stored proof bytes, or null. */
  proofBase64: string | null | undefined;
  /** evidence.fingerprint_hash — the canonical digest the proof must commit to. */
  fingerprintHash: string | null | undefined;
  /** evidence.ots_hash — the digest the record says was stamped. */
  otsHash?: string | null;
  /** evidence.ots_failure_reason (bounded on read). */
  failureReason?: string | null;
  calendar?: string | null;
  /** When the digest was submitted (the first OTS custody event), when known. */
  submittedAtUtc?: Date | string | null;
  /** When PROOVRA recorded the attestation-bearing proof (evidence.ots_anchored_at_utc). */
  anchoredAtUtc?: Date | string | null;
  /** When PROOVRA last upgraded the proof (evidence.ots_upgraded_at_utc). */
  upgradedAtUtc?: Date | string | null;
  /** The independent chain check (evidence.ots_chain_*). Omitted = never checked. */
  chain?: OtsChainRecord | null;
};

export type OtsBitcoinAttestationFact = { blockHeight: number; merkleRootHex: string };

export type OtsAnchoring = {
  state: OtsState;
  /** The derived presentation; CHAIN_VERIFIED is the only positive Bitcoin claim. */
  verification: OtsVerificationKey;
  /** Bounded failure or unavailability code; null otherwise. */
  failureCode: string | null;
  /** The digest the proof commits to (the record's fingerprint digest when bound). */
  committedDigestHex: string | null;
  /** SHA-256 of the stored proof bytes — the proof's identity. */
  proofSha256: string | null;
  attestationType: "BITCOIN_BLOCK_HEADER" | "PENDING_CALENDAR" | null;
  /**
   * The block height: the chain-checked block when the chain fact names one,
   * otherwise the lowest height the proof NAMES (an unverified claim).
   */
  bitcoinBlockHeight: number | null;
  /** Only when the executed proof path derives it. */
  bitcoinTxid: string | null;
  /** The merkle root the proof path produces for that attestation (internal byte order). */
  merkleRootHex: string | null;
  /** Every valid Bitcoin attestation the executed proof names, ascending height. */
  bitcoinAttestations: OtsBitcoinAttestationFact[];
  /** The independent chain fact bound to THIS proof, or null when never checked. */
  chain: OtsChainFacts | null;
  pendingCalendars: string[];
  calendar: string | null;
  submittedAtUtc: string | null;
  /** When PROOVRA recorded the attestation-bearing proof — never a Bitcoin block time. */
  anchoredAtUtc: string | null;
  /** The executor that decided this state. */
  validator: string;
};

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/** THE resolver. Pure, deterministic, and the same in every runtime. */
export function resolveOtsAnchoring(input: OtsAnchoringInput): OtsAnchoring {
  const status = normalizeOtsStatusValue(input.status);
  const proof = typeof input.proofBase64 === "string" ? input.proofBase64.trim() : "";
  const base: OtsAnchoring = {
    state: "NOT_REQUESTED",
    verification: "NOT_REQUESTED",
    failureCode: null,
    committedDigestHex: null,
    proofSha256: null,
    attestationType: null,
    bitcoinBlockHeight: null,
    bitcoinTxid: null,
    merkleRootHex: null,
    bitcoinAttestations: [],
    chain: null,
    pendingCalendars: [],
    calendar: input.calendar?.trim() || null,
    submittedAtUtc: iso(input.submittedAtUtc),
    anchoredAtUtc: null,
    validator: OTS_PROOF_VALIDATOR,
  };
  const as = (a: OtsAnchoring): OtsAnchoring => ({ ...a, verification: deriveOtsVerificationKey(a.state, a.chain) });

  if (status === "DISABLED") return base;

  if (!proof) {
    if (status === "PENDING" || status === "ANCHORED") {
      return as({ ...base, state: "UNAVAILABLE", failureCode: "PROOF_MATERIAL_MISSING" });
    }
    if (status === "FAILED") {
      return as({ ...base, state: "FAILED", failureCode: boundedOtsFailureCode(input.failureReason) ?? "OTS_PROCESSING_FAILED" });
    }
    return base;
  }

  let proofSha256: string | null = null;
  try {
    proofSha256 = otsProofSha256Hex(proof);
  } catch {
    return as({ ...base, state: "FAILED", failureCode: "MALFORMED_PROOF" });
  }
  const withProof = { ...base, proofSha256 };
  const binding = checkOtsDigestBinding({
    proofBase64: proof,
    fingerprintHash: input.fingerprintHash,
    otsHash: input.otsHash ?? null,
  });
  if (binding.kind === "UNREADABLE") {
    return binding.code === "NO_FINGERPRINT"
      ? as({ ...withProof, state: "UNAVAILABLE", failureCode: "FINGERPRINT_MISSING" })
      : as({ ...withProof, state: "FAILED", failureCode: "MALFORMED_PROOF" });
  }
  if (binding.kind === "MISMATCH") {
    return as({ ...withProof, state: "FAILED", failureCode: "PROOF_HASH_MISMATCH", committedDigestHex: binding.committedDigestHex });
  }
  if (binding.kind !== "MATCH") return base;
  const bound = { ...withProof, committedDigestHex: binding.committedDigestHex, pendingCalendars: binding.pendingCalendars };

  // A malformed or unexecuted Bitcoin attestation is a proof defect even when
  // another attestation in the same proof is well-formed: it is never ignored.
  if (binding.invalidBitcoinAttestations > 0) return as({ ...bound, state: "FAILED", failureCode: "INVALID_ATTESTATION" });
  if (binding.unexecutedBitcoinAttestations > 0) return as({ ...bound, state: "FAILED", failureCode: "UNSUPPORTED_PROOF_OPERATION" });

  const attestations = [...binding.bitcoinAttestations]
    .sort((a, b) => a.blockHeight - b.blockHeight || a.merkleRootHex.localeCompare(b.merkleRootHex))
    .map((a) => ({ blockHeight: a.blockHeight, merkleRootHex: a.merkleRootHex, bitcoinTxid: a.bitcoinTxid ?? null }));
  if (attestations.length > 0) {
    const chain = bindOtsChainRecord(input.chain ?? null, {
      proofSha256,
      attestedHeights: attestations.map((a) => a.blockHeight),
    });
    // The block a chain outcome is about, when it names one; otherwise the
    // lowest height the proof NAMES — an unverified claim, labelled as such.
    const named = (chain?.blockHeight != null && attestations.find((a) => a.blockHeight === chain.blockHeight)) || attestations[0]!;
    return as({
      ...bound,
      state: "ANCHORED",
      attestationType: "BITCOIN_BLOCK_HEADER",
      bitcoinBlockHeight: named.blockHeight,
      // The txid of THIS attestation's path only — never one from another branch.
      bitcoinTxid: named.bitcoinTxid,
      merkleRootHex: named.merkleRootHex,
      bitcoinAttestations: attestations.map((a) => ({ blockHeight: a.blockHeight, merkleRootHex: a.merkleRootHex })),
      chain,
      anchoredAtUtc: iso(input.anchoredAtUtc) ?? iso(input.upgradedAtUtc),
    });
  }
  if (status === "FAILED") {
    return as({ ...bound, state: "FAILED", failureCode: boundedOtsFailureCode(input.failureReason) ?? "OTS_PROCESSING_FAILED" });
  }
  return as({ ...bound, state: "PENDING", attestationType: binding.pendingCalendars.length ? "PENDING_CALENDAR" : null });
}

/** The columns `resolveRecordOtsAnchoring` reads from an evidence row. */
export const OTS_ANCHORING_RECORD_SELECT = {
  otsStatus: true,
  otsProofBase64: true,
  otsHash: true,
  fingerprintHash: true,
  otsFailureReason: true,
  otsCalendar: true,
  otsAnchoredAtUtc: true,
  otsUpgradedAtUtc: true,
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

export type OtsAnchoringRecord = {
  otsStatus?: string | null;
  otsProofBase64?: string | null;
  otsHash?: string | null;
  fingerprintHash?: string | null;
  otsFailureReason?: string | null;
  otsCalendar?: string | null;
  otsAnchoredAtUtc?: Date | string | null;
  otsUpgradedAtUtc?: Date | string | null;
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

/** The chain columns of an evidence row, as the resolver reads them. */
export function otsChainRecordOf(row: OtsAnchoringRecord): OtsChainRecord | null {
  if (row.otsChainVerificationStatus == null) return null;
  return {
    status: row.otsChainVerificationStatus,
    checkedAtUtc: row.otsChainCheckedAtUtc ?? null,
    verifiedAtUtc: row.otsChainVerifiedAtUtc ?? null,
    blockHeight: row.otsChainBlockHeight ?? null,
    blockHash: row.otsChainBlockHash ?? null,
    blockTimeUtc: row.otsChainBlockTimeUtc ?? null,
    confirmations: row.otsChainConfirmations ?? null,
    verifier: row.otsChainVerifier ?? null,
    failureCode: row.otsChainFailureCode ?? null,
  };
}

/** The same resolver over an evidence row's stored OTS columns. */
export function resolveRecordOtsAnchoring(row: OtsAnchoringRecord, opts: { submittedAtUtc?: Date | string | null } = {}): OtsAnchoring {
  return resolveOtsAnchoring({
    status: row.otsStatus ?? null,
    proofBase64: row.otsProofBase64 ?? null,
    fingerprintHash: row.fingerprintHash ?? null,
    otsHash: row.otsHash ?? null,
    failureReason: row.otsFailureReason ?? null,
    calendar: row.otsCalendar ?? null,
    anchoredAtUtc: row.otsAnchoredAtUtc ?? null,
    upgradedAtUtc: row.otsUpgradedAtUtc ?? null,
    submittedAtUtc: opts.submittedAtUtc ?? null,
    chain: otsChainRecordOf(row),
  });
}

/** A proof-integrity failure refuses publication; pending, unavailable or an exhausted budget do not. */
export function otsBlocksPublication(a: Pick<OtsAnchoring, "state" | "failureCode">): boolean {
  return a.state === "FAILED" && (OTS_PROOF_INTEGRITY_FAILURES as readonly string[]).includes(String(a.failureCode));
}

// ---------------------------------------------------------------------------
// THE WORDS — every surface prints these (English; OTS_ANCHORING_COPY carries de/ar).
// ---------------------------------------------------------------------------

/**
 * The status word beside "Bitcoin anchoring", per lifecycle state. ANCHORED
 * means only that the proof names a block: it is "Attestation recorded".
 */
export const OTS_STATE_WORDS: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Pending",
  ANCHORED: "Attestation recorded",
  FAILED: "Failed",
  UNAVAILABLE: "Unavailable",
};

/** The standalone label (badges, lists, Public Verify), per lifecycle state. */
export const OTS_STATE_LABELS: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "OpenTimestamps proof pending",
  ANCHORED: "Bitcoin attestation recorded",
  FAILED: "Bitcoin anchoring failed",
  UNAVAILABLE: "Bitcoin anchoring unavailable",
};

/** The one concise sentence, per lifecycle state (no chain facts). */
export const OTS_STATE_SENTENCES: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "No OpenTimestamps anchoring was requested for this record.",
  PENDING: "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.",
  ANCHORED: "The proof names a Bitcoin block; PROOVRA has not checked it against the Bitcoin main chain.",
  FAILED: "Bitcoin anchoring did not complete for this record.",
  UNAVAILABLE: "The OpenTimestamps proof material cannot currently be read.",
};

export type OtsStateTone = "success" | "neutral" | "danger";

/** No lifecycle state on its own is a success: only CHAIN_VERIFIED is. */
export const OTS_STATE_TONES: Readonly<Record<OtsState, OtsStateTone>> = {
  NOT_REQUESTED: "neutral",
  PENDING: "neutral",
  ANCHORED: "neutral",
  FAILED: "danger",
  UNAVAILABLE: "neutral",
};

/** Tones per verification key. CHAIN_VERIFIED is the only success. */
export const OTS_VERIFICATION_TONES: Readonly<Record<OtsVerificationKey, OtsStateTone>> = {
  NOT_REQUESTED: "neutral",
  PENDING: "neutral",
  ATTESTATION_RECORDED: "neutral",
  CHAIN_CONFIRMATIONS_PENDING: "neutral",
  CHAIN_UNAVAILABLE: "neutral",
  CHAIN_FAILED: "danger",
  CHAIN_VERIFIED: "success",
  FAILED: "danger",
  UNAVAILABLE: "neutral",
};

/**
 * Stated once, in technical material, for an attestation that was NOT checked
 * against the chain (ATTESTATION_RECORDED, pending confirmations, unavailable).
 */
export const OTS_ANCHORED_BOUNDARY =
  "The stored OpenTimestamps proof names a Bitcoin block for the recorded evidence digest. It is not independently checked against the Bitcoin main chain until PROOVRA's verifier confirms the block's merkle root.";

/** Stated once, in technical material, for CHAIN_VERIFIED. */
export const OTS_CHAIN_VERIFIED_BOUNDARY =
  "PROOVRA compared the proof's replayed commitment with the merkle root of the named block in the active Bitcoin main chain of a Bitcoin Core node. A reviewer can repeat the check against a node of their own.";

/** Bounded failure/unavailability codes in words. */
export const OTS_FAILURE_LABELS: Readonly<Record<string, string>> = {
  MALFORMED_PROOF: "The OpenTimestamps proof could not be read.",
  PROOF_HASH_MISMATCH: "The OpenTimestamps proof does not commit to this record's evidence digest.",
  UNSUPPORTED_PROOF_OPERATION: "The OpenTimestamps proof uses an operation PROOVRA does not execute.",
  INVALID_ATTESTATION: "The OpenTimestamps proof carries a malformed Bitcoin attestation.",
  OTS_GLOBAL_BUDGET_EXHAUSTED: "The proof did not anchor in Bitcoin within the upgrade budget.",
  OTS_PROCESSING_FAILED: "OpenTimestamps processing did not complete for this record.",
  PROOF_MATERIAL_MISSING: "The stored OpenTimestamps proof is missing.",
  FINGERPRINT_MISSING: "The record has no evidence digest to bind the proof to.",
};

// ---------------------------------------------------------------------------
// LOCALIZED COPY (en / de / ar) — the same concepts on every surface.
// ---------------------------------------------------------------------------

export type OtsCopyLocale = "en" | "de" | "ar";

export type OtsAnchoringCopy = {
  title: string;
  /** Per lifecycle state (a reader that only knows the state). */
  words: Readonly<Record<OtsState, string>>;
  labels: Readonly<Record<OtsState, string>>;
  sentences: Readonly<Record<OtsState, string>>;
  /** Per verification key — the canonical presentation. */
  verificationWords: Readonly<Record<OtsVerificationKey, string>>;
  verificationLabels: Readonly<Record<OtsVerificationKey, string>>;
  /**
   * Sentence templates per verification key. Placeholders: {height},
   * {confirmations}, {minimum}, {checkedAt}. A template whose facts are
   * missing falls back to `verificationSentencesPlain`.
   */
  verificationSentences: Readonly<Record<OtsVerificationKey, string>>;
  verificationSentencesPlain: Readonly<Record<OtsVerificationKey, string>>;
  /** "Not independently checked against Bitcoin" — the secondary status of an unchecked attestation. */
  notCheckedStatus: string;
  boundary: string;
  chainVerifiedBoundary: string;
  facts: {
    digest: string;
    proofSha256: string;
    attestationType: string;
    blockHeight: string;
    txid: string;
    submittedAt: string;
    anchoredAt: string;
    validator: string;
    chainStatus: string;
    blockHash: string;
    blockTime: string;
    confirmations: string;
    checkedAt: string;
    verifiedAt: string;
    verifier: string;
  };
  attestationTypes: { BITCOIN_BLOCK_HEADER: string; PENDING_CALENDAR: string };
  /** Bounded failure / unavailability codes in words (OTS_FAILURE_LABELS keys). */
  failureLabels: Readonly<Record<string, string>>;
};

const EN: OtsAnchoringCopy = {
  title: "Bitcoin anchoring",
  words: OTS_STATE_WORDS,
  labels: OTS_STATE_LABELS,
  sentences: OTS_STATE_SENTENCES,
  verificationWords: {
    NOT_REQUESTED: "Not requested",
    PENDING: "Pending",
    ATTESTATION_RECORDED: "Attestation recorded",
    CHAIN_CONFIRMATIONS_PENDING: "Verification pending",
    CHAIN_UNAVAILABLE: "Verification unavailable",
    CHAIN_FAILED: "Verification failed",
    CHAIN_VERIFIED: "Independently verified",
    FAILED: "Failed",
    UNAVAILABLE: "Unavailable",
  },
  verificationLabels: {
    NOT_REQUESTED: "Not requested",
    PENDING: "OpenTimestamps proof pending",
    ATTESTATION_RECORDED: "Bitcoin attestation recorded",
    CHAIN_CONFIRMATIONS_PENDING: "Bitcoin verification pending",
    CHAIN_UNAVAILABLE: "Bitcoin verification temporarily unavailable",
    CHAIN_FAILED: "Bitcoin verification failed",
    CHAIN_VERIFIED: "Independently verified against the Bitcoin main chain",
    FAILED: "Bitcoin anchoring failed",
    UNAVAILABLE: "Bitcoin anchoring unavailable",
  },
  verificationSentences: {
    NOT_REQUESTED: "No OpenTimestamps anchoring was requested for this record.",
    PENDING: "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.",
    ATTESTATION_RECORDED: "The proof names Bitcoin block {height}; PROOVRA has not checked it against the Bitcoin main chain.",
    CHAIN_CONFIRMATIONS_PENDING: "The proof matches Bitcoin block {height}; {confirmations} of {minimum} confirmations recorded.",
    CHAIN_UNAVAILABLE: "The Bitcoin attestation remains recorded but could not be independently checked.",
    CHAIN_FAILED: "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain.",
    CHAIN_VERIFIED: "Merkle root matches Bitcoin block {height}; {confirmations} confirmations at {checkedAt}.",
    FAILED: "Bitcoin anchoring did not complete for this record.",
    UNAVAILABLE: "The OpenTimestamps proof material cannot currently be read.",
  },
  verificationSentencesPlain: {
    NOT_REQUESTED: "No OpenTimestamps anchoring was requested for this record.",
    PENDING: "Submitted to OpenTimestamps calendars; no Bitcoin attestation yet.",
    ATTESTATION_RECORDED: "The proof names a Bitcoin block; PROOVRA has not checked it against the Bitcoin main chain.",
    CHAIN_CONFIRMATIONS_PENDING: "The proof matches a Bitcoin block that does not yet have the required confirmations.",
    CHAIN_UNAVAILABLE: "The Bitcoin attestation remains recorded but could not be independently checked.",
    CHAIN_FAILED: "The OpenTimestamps proof does not match the referenced block in the active Bitcoin main chain.",
    CHAIN_VERIFIED: "Merkle root matches the named block in the active Bitcoin main chain.",
    FAILED: "Bitcoin anchoring did not complete for this record.",
    UNAVAILABLE: "The OpenTimestamps proof material cannot currently be read.",
  },
  notCheckedStatus: "Not independently checked against Bitcoin",
  boundary: OTS_ANCHORED_BOUNDARY,
  chainVerifiedBoundary: OTS_CHAIN_VERIFIED_BOUNDARY,
  facts: {
    digest: "Evidence digest (SHA-256)",
    proofSha256: "Proof SHA-256",
    attestationType: "Attestation type",
    blockHeight: "Bitcoin block height",
    txid: "Bitcoin transaction",
    submittedAt: "Submitted (UTC)",
    anchoredAt: "Attestation recorded by PROOVRA (UTC)",
    validator: "Proof validator",
    chainStatus: "Bitcoin main-chain check",
    blockHash: "Bitcoin block hash",
    blockTime: "Bitcoin block time (UTC)",
    confirmations: "Confirmations",
    checkedAt: "Checked (UTC)",
    verifiedAt: "Verified (UTC)",
    verifier: "Chain verifier",
  },
  attestationTypes: { BITCOIN_BLOCK_HEADER: "Bitcoin block header", PENDING_CALENDAR: "Pending calendar" },
  failureLabels: OTS_FAILURE_LABELS,
};

const DE: OtsAnchoringCopy = {
  title: "Bitcoin-Verankerung",
  words: {
    NOT_REQUESTED: "Nicht angefordert",
    PENDING: "Ausstehend",
    ANCHORED: "Attestierung erfasst",
    FAILED: "Fehlgeschlagen",
    UNAVAILABLE: "Nicht verfügbar",
  },
  labels: {
    NOT_REQUESTED: "Nicht angefordert",
    PENDING: "OpenTimestamps-Nachweis ausstehend",
    ANCHORED: "Bitcoin-Attestierung erfasst",
    FAILED: "Bitcoin-Verankerung fehlgeschlagen",
    UNAVAILABLE: "Bitcoin-Verankerung nicht verfügbar",
  },
  sentences: {
    NOT_REQUESTED: "Für diesen Datensatz wurde keine OpenTimestamps-Verankerung angefordert.",
    PENDING: "An OpenTimestamps-Kalender übermittelt; noch keine Bitcoin-Attestierung.",
    ANCHORED: "Der Nachweis nennt einen Bitcoin-Block; PROOVRA hat ihn nicht gegen die Bitcoin-Hauptkette geprüft.",
    FAILED: "Die Bitcoin-Verankerung wurde für diesen Datensatz nicht abgeschlossen.",
    UNAVAILABLE: "Das OpenTimestamps-Nachweismaterial kann derzeit nicht gelesen werden.",
  },
  verificationWords: {
    NOT_REQUESTED: "Nicht angefordert",
    PENDING: "Ausstehend",
    ATTESTATION_RECORDED: "Attestierung erfasst",
    CHAIN_CONFIRMATIONS_PENDING: "Prüfung ausstehend",
    CHAIN_UNAVAILABLE: "Prüfung nicht verfügbar",
    CHAIN_FAILED: "Prüfung fehlgeschlagen",
    CHAIN_VERIFIED: "Unabhängig geprüft",
    FAILED: "Fehlgeschlagen",
    UNAVAILABLE: "Nicht verfügbar",
  },
  verificationLabels: {
    NOT_REQUESTED: "Nicht angefordert",
    PENDING: "OpenTimestamps-Nachweis ausstehend",
    ATTESTATION_RECORDED: "Bitcoin-Attestierung erfasst",
    CHAIN_CONFIRMATIONS_PENDING: "Bitcoin-Prüfung ausstehend",
    CHAIN_UNAVAILABLE: "Bitcoin-Prüfung vorübergehend nicht verfügbar",
    CHAIN_FAILED: "Bitcoin-Prüfung fehlgeschlagen",
    CHAIN_VERIFIED: "Unabhängig gegen die Bitcoin-Hauptkette geprüft",
    FAILED: "Bitcoin-Verankerung fehlgeschlagen",
    UNAVAILABLE: "Bitcoin-Verankerung nicht verfügbar",
  },
  verificationSentences: {
    NOT_REQUESTED: "Für diesen Datensatz wurde keine OpenTimestamps-Verankerung angefordert.",
    PENDING: "An OpenTimestamps-Kalender übermittelt; noch keine Bitcoin-Attestierung.",
    ATTESTATION_RECORDED: "Der Nachweis nennt Bitcoin-Block {height}; PROOVRA hat ihn nicht gegen die Bitcoin-Hauptkette geprüft.",
    CHAIN_CONFIRMATIONS_PENDING: "Der Nachweis stimmt mit Bitcoin-Block {height} überein; {confirmations} von {minimum} Bestätigungen erfasst.",
    CHAIN_UNAVAILABLE: "Die Bitcoin-Attestierung bleibt erfasst, konnte aber nicht unabhängig geprüft werden.",
    CHAIN_FAILED: "Der OpenTimestamps-Nachweis stimmt nicht mit dem genannten Block der aktiven Bitcoin-Hauptkette überein.",
    CHAIN_VERIFIED: "Merkle-Wurzel stimmt mit Bitcoin-Block {height} überein; {confirmations} Bestätigungen am {checkedAt}.",
    FAILED: "Die Bitcoin-Verankerung wurde für diesen Datensatz nicht abgeschlossen.",
    UNAVAILABLE: "Das OpenTimestamps-Nachweismaterial kann derzeit nicht gelesen werden.",
  },
  verificationSentencesPlain: {
    NOT_REQUESTED: "Für diesen Datensatz wurde keine OpenTimestamps-Verankerung angefordert.",
    PENDING: "An OpenTimestamps-Kalender übermittelt; noch keine Bitcoin-Attestierung.",
    ATTESTATION_RECORDED: "Der Nachweis nennt einen Bitcoin-Block; PROOVRA hat ihn nicht gegen die Bitcoin-Hauptkette geprüft.",
    CHAIN_CONFIRMATIONS_PENDING: "Der Nachweis stimmt mit einem Bitcoin-Block überein, der die erforderlichen Bestätigungen noch nicht hat.",
    CHAIN_UNAVAILABLE: "Die Bitcoin-Attestierung bleibt erfasst, konnte aber nicht unabhängig geprüft werden.",
    CHAIN_FAILED: "Der OpenTimestamps-Nachweis stimmt nicht mit dem genannten Block der aktiven Bitcoin-Hauptkette überein.",
    CHAIN_VERIFIED: "Merkle-Wurzel stimmt mit dem genannten Block der aktiven Bitcoin-Hauptkette überein.",
    FAILED: "Die Bitcoin-Verankerung wurde für diesen Datensatz nicht abgeschlossen.",
    UNAVAILABLE: "Das OpenTimestamps-Nachweismaterial kann derzeit nicht gelesen werden.",
  },
  notCheckedStatus: "Nicht unabhängig gegen Bitcoin geprüft",
  boundary:
    "Der gespeicherte OpenTimestamps-Nachweis nennt einen Bitcoin-Block für den erfassten Beweis-Digest. Er gilt erst als unabhängig gegen die Bitcoin-Hauptkette geprüft, wenn PROOVRAs Prüfdienst die Merkle-Wurzel des Blocks bestätigt.",
  chainVerifiedBoundary:
    "PROOVRA hat die nachgerechnete Bindung des Nachweises mit der Merkle-Wurzel des genannten Blocks in der aktiven Bitcoin-Hauptkette eines Bitcoin-Core-Knotens verglichen. Prüfende können dies mit einem eigenen Knoten wiederholen.",
  facts: {
    digest: "Beweis-Digest (SHA-256)",
    proofSha256: "Nachweis-SHA-256",
    attestationType: "Attestierungstyp",
    blockHeight: "Bitcoin-Blockhöhe",
    txid: "Bitcoin-Transaktion",
    submittedAt: "Eingereicht (UTC)",
    anchoredAt: "Attestierung von PROOVRA erfasst (UTC)",
    validator: "Nachweis-Validator",
    chainStatus: "Prüfung gegen die Bitcoin-Hauptkette",
    blockHash: "Bitcoin-Block-Hash",
    blockTime: "Bitcoin-Blockzeit (UTC)",
    confirmations: "Bestätigungen",
    checkedAt: "Geprüft (UTC)",
    verifiedAt: "Bestätigt (UTC)",
    verifier: "Ketten-Prüfdienst",
  },
  attestationTypes: { BITCOIN_BLOCK_HEADER: "Bitcoin-Blockheader", PENDING_CALENDAR: "Ausstehender Kalender" },
  failureLabels: {
    MALFORMED_PROOF: "Der OpenTimestamps-Nachweis konnte nicht gelesen werden.",
    PROOF_HASH_MISMATCH: "Der OpenTimestamps-Nachweis bindet nicht den Beweis-Digest dieses Datensatzes.",
    UNSUPPORTED_PROOF_OPERATION: "Der OpenTimestamps-Nachweis verwendet eine Operation, die PROOVRA nicht ausführt.",
    INVALID_ATTESTATION: "Der OpenTimestamps-Nachweis enthält eine fehlerhafte Bitcoin-Attestierung.",
    OTS_GLOBAL_BUDGET_EXHAUSTED: "Der Nachweis wurde innerhalb des Aktualisierungsbudgets nicht in Bitcoin verankert.",
    OTS_PROCESSING_FAILED: "Die OpenTimestamps-Verarbeitung wurde für diesen Datensatz nicht abgeschlossen.",
    PROOF_MATERIAL_MISSING: "Der gespeicherte OpenTimestamps-Nachweis fehlt.",
    FINGERPRINT_MISSING: "Der Datensatz hat keinen Beweis-Digest, an den der Nachweis gebunden werden kann.",
  },
};

const AR: OtsAnchoringCopy = {
  title: "الترسيخ في بيتكوين",
  words: {
    NOT_REQUESTED: "غير مطلوب",
    PENDING: "قيد الانتظار",
    ANCHORED: "الشهادة مسجَّلة",
    FAILED: "فشل",
    UNAVAILABLE: "غير متاح",
  },
  labels: {
    NOT_REQUESTED: "غير مطلوب",
    PENDING: "إثبات OpenTimestamps قيد الانتظار",
    ANCHORED: "شهادة بيتكوين مسجَّلة",
    FAILED: "فشل الترسيخ في بيتكوين",
    UNAVAILABLE: "الترسيخ في بيتكوين غير متاح",
  },
  sentences: {
    NOT_REQUESTED: "لم يُطلب ترسيخ OpenTimestamps لهذا السجل.",
    PENDING: "أُرسل إلى تقاويم OpenTimestamps؛ لا توجد شهادة بيتكوين بعد.",
    ANCHORED: "يُسمّي الإثبات كتلة بيتكوين؛ لم تتحقق PROOVRA منها مقابل سلسلة بيتكوين الرئيسية.",
    FAILED: "لم يكتمل الترسيخ في بيتكوين لهذا السجل.",
    UNAVAILABLE: "تتعذر قراءة مادة إثبات OpenTimestamps حاليًا.",
  },
  verificationWords: {
    NOT_REQUESTED: "غير مطلوب",
    PENDING: "قيد الانتظار",
    ATTESTATION_RECORDED: "الشهادة مسجَّلة",
    CHAIN_CONFIRMATIONS_PENDING: "التحقق قيد الانتظار",
    CHAIN_UNAVAILABLE: "التحقق غير متاح",
    CHAIN_FAILED: "فشل التحقق",
    CHAIN_VERIFIED: "تم التحقق بشكل مستقل",
    FAILED: "فشل",
    UNAVAILABLE: "غير متاح",
  },
  verificationLabels: {
    NOT_REQUESTED: "غير مطلوب",
    PENDING: "إثبات OpenTimestamps قيد الانتظار",
    ATTESTATION_RECORDED: "شهادة بيتكوين مسجَّلة",
    CHAIN_CONFIRMATIONS_PENDING: "التحقق من بيتكوين قيد الانتظار",
    CHAIN_UNAVAILABLE: "التحقق من بيتكوين غير متاح مؤقتًا",
    CHAIN_FAILED: "فشل التحقق من بيتكوين",
    CHAIN_VERIFIED: "تم التحقق بشكل مستقل مقابل سلسلة بيتكوين الرئيسية",
    FAILED: "فشل الترسيخ في بيتكوين",
    UNAVAILABLE: "الترسيخ في بيتكوين غير متاح",
  },
  verificationSentences: {
    NOT_REQUESTED: "لم يُطلب ترسيخ OpenTimestamps لهذا السجل.",
    PENDING: "أُرسل إلى تقاويم OpenTimestamps؛ لا توجد شهادة بيتكوين بعد.",
    ATTESTATION_RECORDED: "يُسمّي الإثبات كتلة بيتكوين {height}؛ لم تتحقق PROOVRA منها مقابل سلسلة بيتكوين الرئيسية.",
    CHAIN_CONFIRMATIONS_PENDING: "يطابق الإثبات كتلة بيتكوين {height}؛ سُجِّل {confirmations} من {minimum} تأكيدات.",
    CHAIN_UNAVAILABLE: "تبقى شهادة بيتكوين مسجَّلة لكن تعذّر التحقق منها بشكل مستقل.",
    CHAIN_FAILED: "لا يطابق إثبات OpenTimestamps الكتلة المشار إليها في سلسلة بيتكوين الرئيسية النشطة.",
    CHAIN_VERIFIED: "يطابق جذر ميركل كتلة بيتكوين {height}؛ {confirmations} تأكيدات في {checkedAt}.",
    FAILED: "لم يكتمل الترسيخ في بيتكوين لهذا السجل.",
    UNAVAILABLE: "تتعذر قراءة مادة إثبات OpenTimestamps حاليًا.",
  },
  verificationSentencesPlain: {
    NOT_REQUESTED: "لم يُطلب ترسيخ OpenTimestamps لهذا السجل.",
    PENDING: "أُرسل إلى تقاويم OpenTimestamps؛ لا توجد شهادة بيتكوين بعد.",
    ATTESTATION_RECORDED: "يُسمّي الإثبات كتلة بيتكوين؛ لم تتحقق PROOVRA منها مقابل سلسلة بيتكوين الرئيسية.",
    CHAIN_CONFIRMATIONS_PENDING: "يطابق الإثبات كتلة بيتكوين لم تبلغ بعد عدد التأكيدات المطلوب.",
    CHAIN_UNAVAILABLE: "تبقى شهادة بيتكوين مسجَّلة لكن تعذّر التحقق منها بشكل مستقل.",
    CHAIN_FAILED: "لا يطابق إثبات OpenTimestamps الكتلة المشار إليها في سلسلة بيتكوين الرئيسية النشطة.",
    CHAIN_VERIFIED: "يطابق جذر ميركل الكتلة المسمّاة في سلسلة بيتكوين الرئيسية النشطة.",
    FAILED: "لم يكتمل الترسيخ في بيتكوين لهذا السجل.",
    UNAVAILABLE: "تتعذر قراءة مادة إثبات OpenTimestamps حاليًا.",
  },
  notCheckedStatus: "لم يُتحقق منها بشكل مستقل مقابل بيتكوين",
  boundary:
    "يُسمّي إثبات OpenTimestamps المخزَّن كتلة بيتكوين لبصمة الدليل المسجَّلة. لا يُعدّ متحققًا منه بشكل مستقل مقابل سلسلة بيتكوين الرئيسية إلا بعد أن يؤكد مدقق PROOVRA جذر ميركل للكتلة.",
  chainVerifiedBoundary:
    "قارنت PROOVRA الالتزام المعاد حسابه من الإثبات بجذر ميركل للكتلة المسمّاة في سلسلة بيتكوين الرئيسية النشطة لعقدة Bitcoin Core. يمكن للمراجع تكرار التحقق باستخدام عقدته الخاصة.",
  facts: {
    digest: "بصمة الدليل (SHA-256)",
    proofSha256: "SHA-256 للإثبات",
    attestationType: "نوع الشهادة",
    blockHeight: "ارتفاع كتلة بيتكوين",
    txid: "معاملة بيتكوين",
    submittedAt: "وقت الإرسال (UTC)",
    anchoredAt: "سجّلت PROOVRA الشهادة (UTC)",
    validator: "مدقق الإثبات",
    chainStatus: "التحقق مقابل سلسلة بيتكوين الرئيسية",
    blockHash: "تجزئة كتلة بيتكوين",
    blockTime: "وقت كتلة بيتكوين (UTC)",
    confirmations: "التأكيدات",
    checkedAt: "وقت الفحص (UTC)",
    verifiedAt: "وقت التحقق (UTC)",
    verifier: "مدقق السلسلة",
  },
  attestationTypes: { BITCOIN_BLOCK_HEADER: "ترويسة كتلة بيتكوين", PENDING_CALENDAR: "تقويم قيد الانتظار" },
  failureLabels: {
    MALFORMED_PROOF: "تعذرت قراءة إثبات OpenTimestamps.",
    PROOF_HASH_MISMATCH: "إثبات OpenTimestamps لا يرتبط ببصمة الدليل الخاصة بهذا السجل.",
    UNSUPPORTED_PROOF_OPERATION: "يستخدم إثبات OpenTimestamps عملية لا تنفذها PROOVRA.",
    INVALID_ATTESTATION: "يحتوي إثبات OpenTimestamps على شهادة بيتكوين غير صالحة الصيغة.",
    OTS_GLOBAL_BUDGET_EXHAUSTED: "لم يُرسَّخ الإثبات في بيتكوين ضمن ميزانية التحديث.",
    OTS_PROCESSING_FAILED: "لم تكتمل معالجة OpenTimestamps لهذا السجل.",
    PROOF_MATERIAL_MISSING: "إثبات OpenTimestamps المخزَّن مفقود.",
    FINGERPRINT_MISSING: "لا يملك السجل بصمة دليل يمكن ربط الإثبات بها.",
  },
};

export const OTS_ANCHORING_COPY: Readonly<Record<OtsCopyLocale, OtsAnchoringCopy>> = { en: EN, de: DE, ar: AR };

/** The copy for a locale; any other locale reads English. */
export function otsAnchoringCopy(locale: string | null | undefined): OtsAnchoringCopy {
  const l = String(locale ?? "en").slice(0, 2).toLowerCase();
  return l === "de" || l === "ar" ? OTS_ANCHORING_COPY[l] : OTS_ANCHORING_COPY.en;
}

/** English verification tables (the default vocabulary every surface shares). */
export const OTS_VERIFICATION_WORDS = EN.verificationWords;
export const OTS_VERIFICATION_LABELS = EN.verificationLabels;

function fill(
  template: string,
  plain: string,
  facts: { height: number | null; confirmations: number | null; minimum: number | null; checkedAt: string | null },
): string {
  let missing = false;
  const out = template.replace(/\{(height|confirmations|minimum|checkedAt)\}/g, (_, k: keyof typeof facts) => {
    const v = facts[k];
    if (v == null || v === "") {
      missing = true;
      return "";
    }
    return String(v);
  });
  return missing ? plain : out;
}

/** The one sentence for a resolved anchoring, with its facts, in a locale. */
export function otsVerificationSentence(
  a: Pick<OtsAnchoring, "verification" | "bitcoinBlockHeight" | "chain">,
  locale: string | null | undefined = "en",
  formatTime: (iso: string) => string = (v) => v.replace("T", " ").replace(/\.\d{3}Z$/, " UTC"),
): string {
  const copy = otsAnchoringCopy(locale);
  const key = parseOtsVerificationKey(a.verification) ?? "UNAVAILABLE";
  return fill(copy.verificationSentences[key], copy.verificationSentencesPlain[key], {
    height: a.chain?.blockHeight ?? a.bitcoinBlockHeight ?? null,
    confirmations: a.chain?.confirmations ?? null,
    minimum: a.chain?.minConfirmations ?? null,
    checkedAt: a.chain?.checkedAtUtc ? formatTime(a.chain.checkedAtUtc) : null,
  });
}

/** The boundary stated once in technical material, or null when none applies. */
export function otsBoundaryFor(
  a: Pick<OtsAnchoring, "verification">,
  locale: string | null | undefined = "en",
): string | null {
  const copy = otsAnchoringCopy(locale);
  switch (parseOtsVerificationKey(a.verification)) {
    case "CHAIN_VERIFIED":
      return copy.chainVerifiedBoundary;
    case "ATTESTATION_RECORDED":
    case "CHAIN_CONFIRMATIONS_PENDING":
    case "CHAIN_UNAVAILABLE":
      return copy.boundary;
    default:
      return null;
  }
}

/** The presentation a surface renders: label, status word, sentence and tone. */
export function presentOtsAnchoring(
  a: Pick<OtsAnchoring, "state"> & Partial<Pick<OtsAnchoring, "verification" | "bitcoinBlockHeight" | "chain">>,
  locale: string | null | undefined = "en",
): {
  state: OtsState;
  verification: OtsVerificationKey;
  title: string;
  status: string;
  label: string;
  sentence: string;
  /** "Not independently checked against Bitcoin" for an unchecked attestation, else null. */
  secondaryStatus: string | null;
  tone: OtsStateTone;
} {
  const state = parseOtsState(a.state);
  const verification = coherentVerification(state, a.verification);
  const copy = otsAnchoringCopy(locale);
  return {
    state,
    verification,
    title: copy.title,
    status: copy.verificationWords[verification],
    label: copy.verificationLabels[verification],
    sentence: otsVerificationSentence({ verification, bitcoinBlockHeight: a.bitcoinBlockHeight ?? null, chain: a.chain ?? null }, locale),
    secondaryStatus: verification === "ATTESTATION_RECORDED" ? copy.notCheckedStatus : null,
    tone: OTS_VERIFICATION_TONES[verification],
  };
}

/** A verification key is only ever believed when it is coherent with the lifecycle state. */
function coherentVerification(state: OtsState, claimed: unknown): OtsVerificationKey {
  const key = parseOtsVerificationKey(claimed);
  if (state === "ANCHORED") {
    return key && key.startsWith("CHAIN_") ? key : key === "ATTESTATION_RECORDED" ? key : "ATTESTATION_RECORDED";
  }
  return otsVerificationKeyOfState(state);
}

// ---------------------------------------------------------------------------
// CUSTODY EVENT WORDING — one reading of an OTS_APPLIED event's payload
// ---------------------------------------------------------------------------

/**
 * The bounded lines an OpenTimestamps custody event is described with
 * (report custody section, Public Verify custody summaries). Decided from the
 * state and verification the worker recorded IN the event — never re-derived,
 * and never stronger than the event: an event that recorded ANCHORED without a
 * CHAIN_VERIFIED verification (every event written before independent chain
 * verification existed) reads as an attestation recorded, not as anchored.
 */
export function otsCustodyEventLines(payload: Record<string, unknown> | null | undefined): string[] {
  const p = payload ?? {};
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const stateRaw = s(p.otsState);
  const state = stateRaw ? parseOtsState(stateRaw) : null;
  const claimed = parseOtsVerificationKey(p.otsVerification);
  const verification: OtsVerificationKey | null =
    state === "ANCHORED"
      ? claimed && (claimed === "ATTESTATION_RECORDED" || claimed.startsWith("CHAIN_"))
        ? claimed
        : "ATTESTATION_RECORDED"
      : state
        ? otsVerificationKeyOfState(state)
        : null;
  const chain = p.chain && typeof p.chain === "object" ? (p.chain as Record<string, unknown>) : null;
  const height = typeof chain?.blockHeight === "number" ? chain.blockHeight : typeof p.bitcoinBlockHeight === "number" ? p.bitcoinBlockHeight : null;
  const confirmations = typeof chain?.confirmations === "number" ? chain.confirmations : null;
  const lines: Array<string | null> = [];
  if (!verification) {
    lines.push(s(p.otsStatus) === "PENDING" || !s(p.otsStatus) ? "OpenTimestamps proof submitted; Bitcoin attestation pending" : "OpenTimestamps proof updated");
  } else if (verification === "PENDING") {
    lines.push("OpenTimestamps proof submitted; Bitcoin attestation pending");
  } else {
    lines.push(OTS_VERIFICATION_LABELS[verification]);
  }
  if (state === "ANCHORED" && height != null) lines.push(`Bitcoin block ${height}`);
  if ((verification === "CHAIN_VERIFIED" || verification === "CHAIN_CONFIRMATIONS_PENDING") && confirmations != null) {
    lines.push(`Confirmations: ${confirmations}`);
  }
  if (verification === "ATTESTATION_RECORDED") lines.push(EN.notCheckedStatus);
  const txid = s(p.bitcoinTxid);
  if (state === "ANCHORED" && txid) lines.push(`Bitcoin Tx: ${txid}`);
  const calendar = s(p.calendar);
  if (calendar) lines.push(`Calendar: ${calendar}`);
  return lines.filter((l): l is string => Boolean(l));
}

// ---------------------------------------------------------------------------
// THE WIRE CONTRACT — what the API sends and every client reads.
// ---------------------------------------------------------------------------

/** The bounded chain fact on the wire. No URL, credential or raw node response. */
export type OtsChainView = {
  status: string;
  failureCode: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  blockTimeUtc: string | null;
  confirmations: number | null;
  minConfirmations: number | null;
  checkedAtUtc: string | null;
  verifiedAtUtc: string | null;
  verifier: string | null;
};

/**
 * `otsAnchoring` on every API response that states OpenTimestamps. Clients
 * render `verification` through the words above (or `readOtsAnchoringView`);
 * they never re-derive it from the other fields. No storage key, URL or credential.
 */
export type OtsAnchoringView = {
  state: OtsState;
  verification: OtsVerificationKey;
  title: string;
  status: string;
  label: string;
  sentence: string;
  secondaryStatus: string | null;
  tone: OtsStateTone;
  failureCode: string | null;
  failureLabel: string | null;
  committedDigestHex: string | null;
  proofSha256: string | null;
  attestationType: "BITCOIN_BLOCK_HEADER" | "PENDING_CALENDAR" | null;
  bitcoinBlockHeight: number | null;
  bitcoinTxid: string | null;
  submittedAtUtc: string | null;
  anchoredAtUtc: string | null;
  validator: string | null;
  chain: OtsChainView | null;
};

const chainViewOf = (c: OtsChainFacts | null): OtsChainView | null =>
  c
    ? {
        status: c.status,
        failureCode: c.failureCode,
        blockHeight: c.blockHeight,
        blockHash: c.blockHash,
        blockTimeUtc: c.blockTimeUtc,
        confirmations: c.confirmations,
        minConfirmations: c.minConfirmations,
        checkedAtUtc: c.checkedAtUtc,
        verifiedAtUtc: c.verifiedAtUtc,
        verifier: c.verifier,
      }
    : null;

export function toOtsAnchoringView(a: OtsAnchoring): OtsAnchoringView {
  const anchored = a.state === "ANCHORED";
  return {
    ...presentOtsAnchoring(a),
    failureCode: a.failureCode,
    failureLabel: a.failureCode ? (OTS_FAILURE_LABELS[a.failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED!) : null,
    committedDigestHex: a.committedDigestHex,
    proofSha256: a.proofSha256,
    attestationType: a.attestationType,
    bitcoinBlockHeight: anchored ? a.bitcoinBlockHeight : null,
    bitcoinTxid: anchored ? a.bitcoinTxid : null,
    submittedAtUtc: a.submittedAtUtc,
    anchoredAtUtc: anchored ? a.anchoredAtUtc : null,
    validator: a.validator,
    chain: anchored ? chainViewOf(a.chain) : null,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

function readChainView(value: unknown): OtsChainView | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const status = parseOtsChainStatus(o.status);
  if (!status) return null;
  const hash = str(o.blockHash);
  return {
    status,
    failureCode: parseOtsChainFailureCode(o.failureCode),
    blockHeight: num(o.blockHeight),
    blockHash: hash && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
    blockTimeUtc: str(o.blockTimeUtc),
    confirmations: num(o.confirmations),
    minConfirmations: num(o.minConfirmations),
    checkedAtUtc: str(o.checkedAtUtc),
    verifiedAtUtc: str(o.verifiedAtUtc),
    verifier: str(o.verifier),
  };
}

/**
 * Read an `otsAnchoring` a server sent. A missing object, or a state this
 * client does not know, reads as UNAVAILABLE; the words always come from this
 * client's own table, never from the payload. CHAIN_VERIFIED is believed only
 * when the state is ANCHORED AND the chain fact itself says VERIFIED; a payload
 * from an older server (no `verification`) reads ANCHORED as an unchecked
 * attestation.
 */
export function readOtsAnchoringView(value: unknown, locale: string | null | undefined = "en"): OtsAnchoringView {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const state = parseOtsState(o.state);
  const anchored = state === "ANCHORED";
  const chain = anchored ? readChainView(o.chain) : null;
  const claimed = parseOtsVerificationKey(o.verification);
  const verification =
    anchored && claimed && claimed.startsWith("CHAIN_")
      ? deriveOtsVerificationKey("ANCHORED", chain ? { status: chain.status as OtsChainFacts["status"] } : null) === claimed
        ? claimed
        : "ATTESTATION_RECORDED"
      : otsVerificationKeyOfState(state);
  const failureCode = state === "FAILED" || state === "UNAVAILABLE" ? str(o.failureCode) : null;
  const attestation = o.attestationType === "BITCOIN_BLOCK_HEADER" || o.attestationType === "PENDING_CALENDAR" ? o.attestationType : null;
  const height = anchored ? num(o.bitcoinBlockHeight) : null;
  const chainFacts: OtsChainFacts | null = chain
    ? {
        status: chain.status as OtsChainFacts["status"],
        failureCode: chain.failureCode as OtsChainFacts["failureCode"],
        blockHeight: chain.blockHeight,
        blockHash: chain.blockHash,
        blockTimeUtc: chain.blockTimeUtc,
        confirmations: chain.confirmations,
        minConfirmations: chain.minConfirmations,
        checkedAtUtc: chain.checkedAtUtc,
        verifiedAtUtc: chain.verifiedAtUtc,
        verifier: chain.verifier,
      }
    : null;
  const copy = otsAnchoringCopy(locale);
  return {
    ...presentOtsAnchoring({ state, verification, bitcoinBlockHeight: height, chain: chainFacts }, locale),
    failureCode,
    failureLabel: failureCode ? (copy.failureLabels[failureCode] ?? copy.failureLabels.OTS_PROCESSING_FAILED ?? null) : null,
    committedDigestHex: str(o.committedDigestHex),
    proofSha256: str(o.proofSha256),
    attestationType: attestation,
    bitcoinBlockHeight: height,
    bitcoinTxid: anchored ? str(o.bitcoinTxid) : null,
    submittedAtUtc: str(o.submittedAtUtc),
    anchoredAtUtc: anchored ? str(o.anchoredAtUtc) : null,
    validator: str(o.validator),
    chain,
  };
}
