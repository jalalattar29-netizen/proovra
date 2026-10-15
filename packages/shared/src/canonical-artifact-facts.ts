/**
 * CANONICAL ARTIFACT FACTS — what a report or verification package MUST say,
 * derived independently of the projection that rendered it (2026-10-07).
 *
 * A consistency check that compares the documents of one package with each
 * other trusts their common source: if the projection that fed every document
 * was wrong, they agree and the check passes. These facts are derived from the
 * RECORD (its columns and its custody chain, read fresh) through the same
 * resolvers every surface uses, and every output is checked against them:
 *
 *   before rendering   the payload about to be rendered must yield the same
 *                      states as the record (`compareCanonicalFacts`);
 *   after rendering    the PDF's EXTRACTED TEXT must state them, and must not
 *                      state anything stronger (`checkRenderedReportText`);
 *   after sealing      the SEALED documents read back from the final ZIP must
 *                      state them (`checkSealedPackageFacts`).
 */
import { resolveAcquisitionIdentitySnapshot, type AcquisitionIdentitySnapshot } from "./acquisition-identity.js";
import {
  OTS_STATE_SENTENCES,
  OTS_VERIFICATION_LABELS,
  otsBoundaryFor,
  otsChainRecordOf,
  otsVerificationKeyOfState,
  parseOtsState,
  parseOtsVerificationKey,
  resolveOtsAnchoring,
  type OtsState,
  type OtsVerificationKey,
} from "./ots-anchoring.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  resolveOtsCustodyFacts,
  resolveTsaTrustState,
  toVerificationStatus,
  type TrustSignalState,
} from "./trust-signal-state.js";
import { resolveEvidenceAcquisition } from "./evidence-acquisition.js";
import {
  VERIFICATION_LIMITATION,
  findForbiddenCustomerClaims,
  isAccountAuthenticationVerified,
  parseVerificationMatrix,
} from "./verification-matrix.js";

/** The record's own columns that decide the trust and identity states. */
export type CanonicalFactsSource = {
  fileSha256?: string | null;
  tsaStatus?: string | null;
  tsaFailureCode?: string | null;
  tsaTokenPresent?: boolean | null;
  tsaValidatedAtUtc?: Date | string | null;
  /**
   * (2026-10-13) The OpenTimestamps record: the state is resolved from the
   * stored proof bytes against the fingerprint digest (ots-anchoring.ts).
   */
  otsStatus?: string | null;
  otsAnchoredAtUtc?: Date | string | null;
  otsUpgradedAtUtc?: Date | string | null;
  /** The independent Bitcoin-chain check (evidence.ots_chain_*). */
  otsChainVerificationStatus?: string | null;
  otsChainCheckedAtUtc?: Date | string | null;
  otsChainVerifiedAtUtc?: Date | string | null;
  otsChainBlockHeight?: number | null;
  otsChainBlockHash?: string | null;
  otsChainBlockTimeUtc?: Date | string | null;
  otsChainConfirmations?: number | null;
  otsChainVerifier?: string | null;
  otsChainFailureCode?: string | null;
  otsFailureReason?: string | null;
  fingerprintHash?: string | null;
  otsHash?: string | null;
  otsProofBase64?: string | null;
  acquisitionMode?: string | null;
  identityLevelSnapshot?: string | null;
  submittedByAuthProvider?: string | null;
  submittedByEmail?: string | null;
  submittedByUserId?: string | null;
  workspaceNameSnapshot?: string | null;
  organizationNameSnapshot?: string | null;
  organizationVerifiedSnapshot?: boolean | null;
};

export type CanonicalArtifactFacts = {
  evidenceFileSha256: string | null;
  tsaState: TrustSignalState;
  /** The canonical OpenTimestamps state (ots-anchoring.ts). */
  otsState: OtsState;
  /** The canonical OpenTimestamps verification (CHAIN_VERIFIED is the only positive claim). */
  otsVerification: OtsVerificationKey;
  /** SHA-256 of the stored proof the state was resolved from. */
  otsProofSha256: string | null;
  /** The bounded failure / unavailability code; null otherwise. */
  otsFailureCode: string | null;
  acquisition: AcquisitionIdentitySnapshot;
  /**
   * AUD-015 — the acquisition channel's observation boundary (what PROOVRA
   * proves from receipt onward; what it did not observe before). A rendered
   * report states it exactly once.
   */
  acquisitionBoundary: string;
};

type CustodyLike = ReadonlyArray<{ eventType?: string | null; atUtc?: Date | string | null; payload?: unknown }>;

export function deriveCanonicalArtifactFacts(source: CanonicalFactsSource, custodyEvents: CustodyLike): CanonicalArtifactFacts {
  const tsa = resolveTsaTrustState({
    presentedStatus: presentedTsaStatus({
      tsaStatus: source.tsaStatus ?? null,
      tsaValidatedAtUtc: source.tsaValidatedAtUtc ?? null,
    }),
    tokenPresent: source.tsaTokenPresent ?? null,
    failureCode: source.tsaFailureCode ?? null,
    validatedAtUtc: source.tsaValidatedAtUtc ?? null,
  });
  const custody = resolveOtsCustodyFacts(custodyEvents);
  const ots = resolveOtsAnchoring({
    status: source.otsStatus ?? null,
    proofBase64: source.otsProofBase64 ?? null,
    fingerprintHash: source.fingerprintHash ?? null,
    otsHash: source.otsHash ?? null,
    failureReason: source.otsFailureReason ?? null,
    anchoredAtUtc: source.otsAnchoredAtUtc ?? null,
    upgradedAtUtc: source.otsUpgradedAtUtc ?? null,
    submittedAtUtc: custody.submittedAtUtc,
    chain: otsChainRecordOf(source),
  });
  return {
    evidenceFileSha256: source.fileSha256 ? source.fileSha256.toLowerCase() : null,
    tsaState: tsa.state,
    otsState: ots.state,
    otsVerification: ots.verification,
    otsProofSha256: ots.proofSha256,
    otsFailureCode: ots.failureCode,
    acquisition: resolveAcquisitionIdentitySnapshot({
      custodyEvents,
      row: source,
      acquisitionMode: source.acquisitionMode ?? null,
    }),
    acquisitionBoundary: resolveEvidenceAcquisition({ acquisitionMode: source.acquisitionMode ?? null }).boundary,
  };
}

export type CanonicalFactsFinding = { check: string; detail: string };

/** A document's stated verification; a document without one states the conservative reading of its state. */
function manifestVerification(doc: Record<string, unknown>, field = "otsVerification"): OtsVerificationKey {
  const stated = parseOtsVerificationKey(doc[field]);
  return stated ?? otsVerificationKeyOfState(parseOtsState(doc.otsState ?? doc.state));
}

/**
 * BEFORE RENDERING: the facts the record yields and the facts the payload
 * about to be rendered yields must be the same.
 */
export function compareCanonicalFacts(record: CanonicalArtifactFacts, rendered: CanonicalArtifactFacts): CanonicalFactsFinding[] {
  const out: CanonicalFactsFinding[] = [];
  if (record.tsaState !== rendered.tsaState) out.push({ check: "TSA_STATE", detail: `record ${record.tsaState}, payload ${rendered.tsaState}` });
  if (record.otsState !== rendered.otsState) out.push({ check: "OTS_STATE", detail: `record ${record.otsState}, payload ${rendered.otsState}` });
  if (record.otsState === rendered.otsState && record.otsVerification !== rendered.otsVerification) {
    out.push({ check: "OTS_VERIFICATION", detail: `record ${record.otsVerification}, payload ${rendered.otsVerification}` });
  }
  if (record.otsState === rendered.otsState && record.otsProofSha256 !== rendered.otsProofSha256) {
    out.push({ check: "OTS_PROOF", detail: "payload proof differs from the record's stored proof" });
  }
  if (record.evidenceFileSha256 !== rendered.evidenceFileSha256) out.push({ check: "EVIDENCE_DIGEST", detail: "payload digest differs from the record" });
  for (const k of ["basis", "actorKind", "accountRole", "identityLevel", "authProvider", "emailVerified", "workspaceKind", "organizationVerified"] as const) {
    if (record.acquisition[k] !== rendered.acquisition[k]) {
      out.push({ check: "IDENTITY", detail: `${k}: record ${String(record.acquisition[k])}, payload ${String(rendered.acquisition[k])}` });
    }
  }
  return out;
}

/**
 * THE LIFECYCLE ORDER of the two asynchronous layers (2026-10-13). OTS and TSA
 * advance AFTER a record is finalized — OTS initialization writes PENDING, an
 * upgrade attaches a Bitcoin block attestation; a kept TSA token may later
 * validate or fail — so the facts an issuance stated and the record's facts
 * read later may differ by FORWARD progress only.
 *
 *   OTS  stage 0  NOT_REQUESTED / UNAVAILABLE   (not requested, or unreadable)
 *        stage 1  PENDING / FAILED              (requested; a failed request
 *                                                 may be requested again)
 *        stage 2  ANCHORED                      (terminal per proof)
 *   TSA  UNAVAILABLE / PENDING → anything; a kept token (PRESENT / NOT_CHECKED)
 *        → itself, PASSED or FAILED; PASSED and FAILED are final.
 *
 * A later fact at a LOWER stage is a contradiction (an anchored proof cannot
 * become pending; a proof cannot disappear) and stays a finding.
 */
const OTS_STAGE: Readonly<Record<OtsState, number>> = {
  NOT_REQUESTED: 0,
  UNAVAILABLE: 0,
  PENDING: 1,
  FAILED: 1,
  ANCHORED: 2,
};

export function otsProgressionCompatible(stated: OtsState, later: OtsState): boolean {
  return OTS_STAGE[later] >= OTS_STAGE[stated];
}

export function tsaProgressionCompatible(stated: TrustSignalState, later: TrustSignalState): boolean {
  if (stated === later) return true;
  if (stated === "UNAVAILABLE" || stated === "PENDING" || stated === "NOT_APPLICABLE") return true;
  if (stated === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" || stated === "NOT_CHECKED") {
    return later === "PASSED" || later === "FAILED" || later === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" || later === "NOT_CHECKED";
  }
  return false; // PASSED, FAILED and STALE are final for a timestamp
}

/**
 * The facts an ISSUANCE stated (the snapshot a report and its packages were
 * built from) against the record's facts read LATER: the digest and the
 * capture-time identity must be identical (they never change), and the two
 * asynchronous layers may only have moved forward.
 */
export function compareIssuanceFactsToRecord(issuance: CanonicalArtifactFacts, later: CanonicalArtifactFacts): CanonicalFactsFinding[] {
  const out = compareCanonicalFacts(issuance, later).filter((f) => f.check !== "TSA_STATE" && f.check !== "OTS_STATE" && f.check !== "OTS_PROOF");
  if (!tsaProgressionCompatible(issuance.tsaState, later.tsaState)) {
    out.push({ check: "TSA_STATE", detail: `issuance ${issuance.tsaState} cannot precede record ${later.tsaState}` });
  }
  if (!otsProgressionCompatible(issuance.otsState, later.otsState)) {
    out.push({ check: "OTS_STATE", detail: `issuance ${issuance.otsState} cannot precede record ${later.otsState}` });
  }
  return out;
}

/**
 * (2026-10-13) Retired OTS wording no report may print in any state: the
 * chain-verifier vocabulary and the "attestation recorded" middle state are
 * gone. ANCHORED reads "Bitcoin anchoring — Anchored", nothing stronger.
 */
const OTS_RETIRED_PHRASES = [
  /OpenTimestamps Bitcoin anchoring verified/i,
  /Bitcoin anchoring verified/i,
  /Bitcoin attestation independently verified/i,
  /independently verified against the Bitcoin blockchain/i,
  // The pre-chain-verification claim: a proof that only NAMES a block was
  // printed as anchored in Bitcoin.
  /OpenTimestamps proof anchored in Bitcoin/i,
  /anchored to a Bitcoin block/i,
  /\bOTS Anchored At\b/i,
  /not independently chain-verified/i,
  /chain-verified/i,
  /proof (?:is )?still being prepared/i,
];
// The report's timestamp card ("RFC 3161 timestamp verified") and the
// appendix's validation scope (2026-10-13).
/** Cards of the retired 13-row matrix that no report may print again. */
export const RETIRED_REPORT_CARDS = [
  "Pre-PROOVRA provenance",
  "Package completeness",
  "Package signature",
  "Public Verify publication",
  "PROOVRA custody chain",
  "Account identity",
] as const;
/** (2026-10-14) The account card's verified statement (label and status). */
export const ACCOUNT_AUTHENTICATION_VERIFIED = "Account authentication Verified";
/** A report never verifies the package sealed after it. */
const PACKAGE_SELF_ATTESTATION = "Verification package Verified";
/**
 * (2026-10-14) Sections removed from the report: the review index's
 * three-card "Report boundary" block (the cover keeps its one-line form), the
 * Executive Summary's capture-context statement of absent location, and the
 * retired identity and package wording. (AUD-015: the observation boundary is
 * no longer retired — the cover states it exactly once.)
 */
export const RETIRED_REPORT_SECTIONS: readonly string[] = [
  "What this report is",
  "What it does not establish",
  "Embedded previews are reviewer aids",
  "Location metadata was not recorded for this evidence",
  "Location metadata was recorded incompletely",
  "Workspace identity",
  "paired with this report",
];
const clipPhrase = (s: string) => (s.length > 48 ? `${s.slice(0, 48)}…` : s);
const TSA_VALIDATED_PHRASES =["RFC 3161 timestamp verified", TSA_VALIDATED_QUALIFICATION_STATEMENT];
/** Raw codes that must never reach a reader. */
const RAW_CODES = /\b(ORGANIZATION_ACCOUNT|VERIFIED_EMAIL|BITCOIN_VERIFIED|PROOF_STRUCTURE|PRESENT_NOT_INDEPENDENTLY_VERIFIED|OBSERVED_AT_CAPTURE|RECORDED_ON_RECORD|INTAKE_CONTRIBUTOR|INTAKE_LINK_ISSUER|ACCOUNT_USER|GUEST_SESSION|NOT_CHECKED|NOT_APPLICABLE|NOT_CONFIGURED|INSUFFICIENT_CONFIRMATIONS|ANCHORED_NOT_CHECKED|ATTESTATION_PRESENT_NOT_VERIFIED|ATTESTATION_RECORDED|INDEPENDENTLY_VERIFIED|NOT_REQUESTED|PROOF_HASH_MISMATCH|MALFORMED_PROOF|CHAIN_VERIFICATION_UNAVAILABLE|CHAIN_VERIFICATION_FAILED|CHAIN_VERIFIED|UNKNOWN_OR_STALE|PROOF_INVALID|RECORDED_NOT_VALIDATED|tsa_[a-z_]+)\b/;
const STORAGE_KEY = /\b(?:reports|verification)\/[0-9a-f-]{36}\/v\d+\//;

// A line break after a hyphen is layout, not text ("qualified-\nservice").
const norm = (s: string) => s.replace(/(?<=\w)-\s+(?=\w)/g, "-").replace(/\s+/g, " ");

/**
 * AFTER RENDERING: the report's extracted text states the canonical facts and
 * nothing stronger. (Custody history may name earlier events; these checks are
 * on statements of the record's CURRENT state.)
 */
export function checkRenderedReportText(
  rawText: string,
  facts: CanonicalArtifactFacts,
  expect: { reportVersion: number },
): CanonicalFactsFinding[] {
  const text = norm(rawText);
  const out: CanonicalFactsFinding[] = [];
  // THE BITCOIN ANCHORING CARD: the report states the record's verification
  // label and, for an anchored proof, its boundary once. Only a chain-verified
  // record may state the chain-verified label.
  const verifiedLabel = OTS_VERIFICATION_LABELS.CHAIN_VERIFIED;
  if (facts.otsState === "ANCHORED") {
    const label = OTS_VERIFICATION_LABELS[facts.otsVerification];
    if (!text.includes("Bitcoin anchoring") || !text.includes(label)) {
      out.push({ check: "OTS_ANCHORED", detail: `does not state "Bitcoin anchoring" with "${label}"` });
    }
    const boundary = otsBoundaryFor({ verification: facts.otsVerification });
    if (boundary && !text.includes(norm(boundary))) out.push({ check: "OTS_BOUNDARY", detail: "the anchoring boundary is not stated" });
  }
  if (facts.otsVerification !== "CHAIN_VERIFIED" && text.includes(verifiedLabel)) {
    out.push({ check: "OTS_OVERCLAIM", detail: `states "${verifiedLabel}" while anchoring is ${facts.otsVerification}` });
  }
  if (facts.otsState !== "PENDING" && text.includes(OTS_STATE_SENTENCES.PENDING)) {
    out.push({ check: "OTS_CONTRADICTION", detail: `states "${OTS_STATE_SENTENCES.PENDING}" while the proof is ${facts.otsState}` });
  }
  // (2026-10-13) The report states the evidence's eight verification layers;
  // the expanded matrix's product-mechanics cards are retired from it.
  for (const card of RETIRED_REPORT_CARDS) {
    if (text.includes(card)) out.push({ check: "RETIRED_SIGNAL", detail: `states the retired "${card}" card` });
  }
  for (const p of OTS_RETIRED_PHRASES) {
    const m = text.match(p);
    if (m) out.push({ check: "OTS_RETIRED_WORDING", detail: `states "${m[0]}"` });
  }
  if (facts.tsaState === "PASSED") {
    for (const p of TSA_VALIDATED_PHRASES) if (!text.includes(norm(p))) out.push({ check: "TSA_VALIDATED", detail: `does not state "${p}"` });
  } else {
    for (const p of TSA_VALIDATED_PHRASES) if (text.includes(norm(p))) out.push({ check: "TSA_OVERCLAIM", detail: `states "${p}" while the timestamp is ${facts.tsaState}` });
  }
  if (facts.evidenceFileSha256 && !text.replace(/\s/g, "").includes(facts.evidenceFileSha256)) {
    out.push({ check: "EVIDENCE_DIGEST", detail: "the original file's SHA-256 is not stated" });
  }
  if (!new RegExp(`\\bv${expect.reportVersion}\\b`).test(text)) out.push({ check: "REPORT_VERSION", detail: `v${expect.reportVersion} is not stated` });
  if (/OAuth/.test(text) && facts.acquisition.authProvider === "EMAIL") out.push({ check: "IDENTITY_WORDING", detail: "an email account is described as OAuth" });
  // (2026-10-14) The account card states the snapshot's verification exactly:
  // "Verified" when the submission-time snapshot verifies the account, and
  // never otherwise.
  const accountVerified = isAccountAuthenticationVerified(facts.acquisition);
  if (accountVerified !== text.includes(ACCOUNT_AUTHENTICATION_VERIFIED)) {
    out.push({
      check: "IDENTITY_STATUS",
      detail: accountVerified
        ? `does not state "${ACCOUNT_AUTHENTICATION_VERIFIED}" for a verified submission-time account`
        : `states "${ACCOUNT_AUTHENTICATION_VERIFIED}" while the submission-time snapshot does not verify the account`,
    });
  }
  // The paired package is sealed after the report: a report never verifies it.
  if (text.includes(PACKAGE_SELF_ATTESTATION)) {
    out.push({ check: "PACKAGE_SELF_ATTESTATION", detail: `states "${PACKAGE_SELF_ATTESTATION}" for a package sealed after it` });
  }
  for (const phrase of RETIRED_REPORT_SECTIONS) {
    if (text.includes(phrase)) out.push({ check: "RETIRED_SECTION", detail: `states the retired "${clipPhrase(phrase)}"` });
  }
  const raw = text.match(RAW_CODES);
  if (raw) out.push({ check: "RAW_CODE", detail: `raw code "${raw[0]}"` });
  if (STORAGE_KEY.test(text)) out.push({ check: "INFRASTRUCTURE", detail: "a storage key is printed" });
  // No score, weighted point or overall verdict; the bounded limitation is stated.
  for (const claim of findForbiddenCustomerClaims(text)) out.push({ check: "FORBIDDEN_CLAIM", detail: `states ${claim}` });
  if (!text.includes(norm(VERIFICATION_LIMITATION))) out.push({ check: "LIMITATION", detail: "the verification limitation is not stated" });
  // AUD-015 — the pre-PROOVRA boundary: stated, and stated once.
  if (facts.acquisitionBoundary) {
    const times = text.split(norm(facts.acquisitionBoundary)).length - 1;
    if (times !== 1) {
      out.push({
        check: "ACQUISITION_BOUNDARY",
        detail: times === 0 ? "the acquisition observation boundary is not stated" : `the acquisition observation boundary is stated ${times} times`,
      });
    }
  }
  return out;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/**
 * AFTER SEALING: the sealed documents (read back from the final ZIP) state the
 * canonical facts.
 */
export function checkSealedPackageFacts(
  docs: ReadonlyMap<string, unknown>,
  facts: CanonicalArtifactFacts,
): CanonicalFactsFinding[] {
  const out: CanonicalFactsFinding[] = [];
  const manifest = docs.get("package-manifest.json");
  if (isObj(manifest)) {
    if (parseOtsState(manifest.otsState) !== facts.otsState) {
      out.push({ check: "OTS_STATE", detail: `manifest otsState=${String(manifest.otsState)}, record ${facts.otsState}` });
    } else if (manifestVerification(manifest) !== facts.otsVerification) {
      out.push({ check: "OTS_VERIFICATION", detail: `manifest otsVerification=${String(manifest.otsVerification)}, record ${facts.otsVerification}` });
    }
    if ("publicAnchoringVerified" in manifest) {
      out.push({ check: "OTS_RETIRED_FIELD", detail: "manifest states the retired publicAnchoringVerified" });
    }
    if ((manifest.evidenceFileSha256 ?? null) !== facts.evidenceFileSha256) {
      out.push({ check: "EVIDENCE_DIGEST", detail: "manifest evidenceFileSha256 differs from the record" });
    }
  } else {
    out.push({ check: "MANIFEST_PRESENT", detail: "package-manifest.json is missing" });
  }
  const matrix = parseVerificationMatrix(docs.get("trust-decision.json"));
  if (!matrix) out.push({ check: "VERIFICATION_MATRIX", detail: "trust-decision.json is not a verification matrix" });
  const row = (key: string) => matrix?.rows.find((r) => r.key === key);
  const ots = row("ots_anchoring");
  if (ots && ots.otsState !== facts.otsState) {
    out.push({ check: "OTS_STATE", detail: `matrix anchoring ${String(ots.otsState)}, record ${facts.otsState}` });
  }
  if (ots && ots.otsState === facts.otsState && ots.otsVerification !== facts.otsVerification) {
    out.push({ check: "OTS_VERIFICATION", detail: `matrix anchoring ${String(ots.otsVerification)}, record ${facts.otsVerification}` });
  }
  const otsDoc = docs.get("opentimestamps.json");
  if (facts.otsState !== "NOT_REQUESTED") {
    if (!isObj(otsDoc)) out.push({ check: "OTS_RECORD", detail: "opentimestamps.json is missing" });
    else if (parseOtsState(otsDoc.state) !== facts.otsState) {
      out.push({ check: "OTS_STATE", detail: `opentimestamps.json ${String(otsDoc.state)}, record ${facts.otsState}` });
    } else if (manifestVerification(otsDoc, "verification") !== facts.otsVerification) {
      out.push({ check: "OTS_VERIFICATION", detail: `opentimestamps.json verification ${String(otsDoc.verification)}, record ${facts.otsVerification}` });
    } else if ((isObj(otsDoc.proof) ? (otsDoc.proof.sha256 ?? null) : null) !== facts.otsProofSha256) {
      out.push({ check: "OTS_PROOF", detail: "opentimestamps.json proofSha256 differs from the record's stored proof" });
    }
  }
  const tsa = row("tsa_token");
  if (tsa && tsa.status !== toVerificationStatus(facts.tsaState)) {
    out.push({ check: "TSA_STATE", detail: `matrix timestamp ${tsa.status}, record ${facts.tsaState}` });
  }
  const tsaRecord = docs.get("timestamp-validation.json");
  if (isObj(tsaRecord) && tsaRecord.trustState !== facts.tsaState) {
    out.push({ check: "TSA_STATE", detail: `timestamp-validation.json ${String(tsaRecord.trustState)}, record ${facts.tsaState}` });
  }
  const caseMeta = docs.get("case-metadata.json");
  const acq = isObj(caseMeta) && isObj(caseMeta.submitter) ? caseMeta.submitter.acquisitionIdentity : null;
  if (isObj(acq)) {
    for (const k of ["basis", "actorKind", "accountRole", "workspaceKind", "emailVerified", "organizationVerified"] as const) {
      const v = acq[k];
      if (v === "[withheld]") continue;
      if ((v ?? null) !== (facts.acquisition[k] ?? null)) {
        out.push({ check: "IDENTITY", detail: `case-metadata ${k}=${String(v)}, record ${String(facts.acquisition[k])}` });
      }
    }
  }
  return out;
}
