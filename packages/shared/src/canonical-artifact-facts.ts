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
import { normalizeOtsAnchorCheck } from "./ots.js";
import { presentedTsaStatus } from "./tsa-validation-state.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  resolveOtsCustodyFacts,
  resolveOtsTrustState,
  resolveTsaTrustState,
  toVerificationStatus,
  type TrustSignalState,
} from "./trust-signal-state.js";
import { VERIFICATION_LIMITATION, findForbiddenCustomerClaims, parseVerificationMatrix } from "./verification-matrix.js";

/** The record's own columns that decide the trust and identity states. */
export type CanonicalFactsSource = {
  fileSha256?: string | null;
  tsaStatus?: string | null;
  tsaFailureCode?: string | null;
  tsaTokenPresent?: boolean | null;
  tsaValidatedAtUtc?: Date | string | null;
  otsStatus?: string | null;
  otsAnchoredAtUtc?: Date | string | null;
  otsAnchorCheck?: string | null;
  otsBitcoinTxid?: string | null;
  otsProofPresent?: boolean | null;
  otsUpgradedAtUtc?: Date | string | null;
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
  otsState: TrustSignalState;
  acquisition: AcquisitionIdentitySnapshot;
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
  const anchorCheck = normalizeOtsAnchorCheck(source.otsAnchorCheck ?? null);
  const custody = resolveOtsCustodyFacts(custodyEvents, anchorCheck);
  const ots = resolveOtsTrustState({
    status: source.otsStatus ?? null,
    anchoredAtUtc: source.otsAnchoredAtUtc ?? null,
    anchorCheck,
    proofPresent: source.otsProofPresent ?? null,
    upgradedAtUtc: source.otsUpgradedAtUtc ?? null,
    submittedAtUtc: custody.submittedAtUtc,
    anchorCheckedAtUtc: custody.anchorCheckedAtUtc,
    bitcoinTxid: source.otsBitcoinTxid ?? null,
  });
  return {
    evidenceFileSha256: source.fileSha256 ? source.fileSha256.toLowerCase() : null,
    tsaState: tsa.state,
    otsState: ots.state,
    acquisition: resolveAcquisitionIdentitySnapshot({
      custodyEvents,
      row: source,
      acquisitionMode: source.acquisitionMode ?? null,
    }),
  };
}

export type CanonicalFactsFinding = { check: string; detail: string };

/**
 * BEFORE RENDERING: the facts the record yields and the facts the payload
 * about to be rendered yields must be the same.
 */
export function compareCanonicalFacts(record: CanonicalArtifactFacts, rendered: CanonicalArtifactFacts): CanonicalFactsFinding[] {
  const out: CanonicalFactsFinding[] = [];
  if (record.tsaState !== rendered.tsaState) out.push({ check: "TSA_STATE", detail: `record ${record.tsaState}, payload ${rendered.tsaState}` });
  if (record.otsState !== rendered.otsState) out.push({ check: "OTS_STATE", detail: `record ${record.otsState}, payload ${rendered.otsState}` });
  if (record.evidenceFileSha256 !== rendered.evidenceFileSha256) out.push({ check: "EVIDENCE_DIGEST", detail: "payload digest differs from the record" });
  for (const k of ["basis", "actorKind", "accountRole", "identityLevel", "authProvider", "emailVerified", "workspaceKind", "organizationVerified"] as const) {
    if (record.acquisition[k] !== rendered.acquisition[k]) {
      out.push({ check: "IDENTITY", detail: `${k}: record ${String(record.acquisition[k])}, payload ${String(rendered.acquisition[k])}` });
    }
  }
  return out;
}

/**
 * THE LIFECYCLE ORDER of the two asynchronous layers (2026-10-08). OTS and TSA
 * advance AFTER a record is finalized — OTS initialization writes PENDING, an
 * upgrade attaches a Bitcoin attestation, a chain check may verify it; a kept
 * TSA token may later validate or fail — so the facts an issuance stated and
 * the record's facts read later may differ by FORWARD progress only.
 *
 *   OTS  stage 0  UNAVAILABLE / NOT_APPLICABLE   (not requested yet)
 *        stage 1  PENDING / STALE / FAILED       (requested; a failed request
 *                                                  may be requested again)
 *        stage 2  PRESENT_NOT_INDEPENDENTLY_VERIFIED / NOT_CHECKED (proof present)
 *        stage 3  PASSED                          (chain-verified)
 *   TSA  UNAVAILABLE / PENDING → anything; a kept token (PRESENT / NOT_CHECKED)
 *        → itself, PASSED or FAILED; PASSED and FAILED are final.
 *
 * A later fact at a LOWER stage is a contradiction (a verified anchor cannot
 * become a bare proof; a proof cannot disappear; a validated token cannot
 * become unvalidated) and stays a finding.
 */
const OTS_STAGE: Readonly<Record<TrustSignalState, number>> = {
  UNAVAILABLE: 0,
  NOT_APPLICABLE: 0,
  PENDING: 1,
  STALE: 1,
  FAILED: 1,
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: 2,
  NOT_CHECKED: 2,
  PASSED: 3,
};

export function otsProgressionCompatible(stated: TrustSignalState, later: TrustSignalState): boolean {
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
  const out = compareCanonicalFacts(issuance, later).filter((f) => f.check !== "TSA_STATE" && f.check !== "OTS_STATE");
  if (!tsaProgressionCompatible(issuance.tsaState, later.tsaState)) {
    out.push({ check: "TSA_STATE", detail: `issuance ${issuance.tsaState} cannot precede record ${later.tsaState}` });
  }
  if (!otsProgressionCompatible(issuance.otsState, later.otsState)) {
    out.push({ check: "OTS_STATE", detail: `issuance ${issuance.otsState} cannot precede record ${later.otsState}` });
  }
  return out;
}

/** Phrases that state a STRONGER fact than PRESENT / PENDING / FAILED. */
const OTS_VERIFIED_PHRASES = ["Anchored in Bitcoin; verified against the Bitcoin chain", "Anchored, chain-verified"];
const TSA_VALIDATED_PHRASES = ["RFC 3161 timestamp validated", TSA_VALIDATED_QUALIFICATION_STATEMENT];
/** Raw codes that must never reach a reader. */
const RAW_CODES = /\b(ORGANIZATION_ACCOUNT|VERIFIED_EMAIL|BITCOIN_VERIFIED|PROOF_STRUCTURE|PRESENT_NOT_INDEPENDENTLY_VERIFIED|OBSERVED_AT_CAPTURE|RECORDED_ON_RECORD|INTAKE_CONTRIBUTOR|INTAKE_LINK_ISSUER|ACCOUNT_USER|GUEST_SESSION|tsa_[a-z_]+)\b/;
const STORAGE_KEY = /\b(?:reports|verification)\/[0-9a-f-]{36}\/v\d+\//;

const norm = (s: string) => s.replace(/\s+/g, " ");

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
  if (facts.otsState !== "PASSED") {
    for (const p of OTS_VERIFIED_PHRASES) if (text.includes(p)) out.push({ check: "OTS_OVERCLAIM", detail: `states "${p}" while anchoring is ${facts.otsState}` });
  }
  if (facts.otsState === "PRESENT_NOT_INDEPENDENTLY_VERIFIED" && !/not independently (?:checked|chain-verified)/.test(text)) {
    out.push({ check: "OTS_PRESENT", detail: "does not say the anchoring proof is not independently chain-verified" });
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
  const raw = text.match(RAW_CODES);
  if (raw) out.push({ check: "RAW_CODE", detail: `raw code "${raw[0]}"` });
  if (STORAGE_KEY.test(text)) out.push({ check: "INFRASTRUCTURE", detail: "a storage key is printed" });
  // No score, weighted point or overall verdict; the bounded limitation is stated.
  for (const claim of findForbiddenCustomerClaims(text)) out.push({ check: "FORBIDDEN_CLAIM", detail: `states ${claim}` });
  if (!text.includes(norm(VERIFICATION_LIMITATION))) out.push({ check: "LIMITATION", detail: "the verification limitation is not stated" });
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
    if (Boolean(manifest.publicAnchoringVerified) !== (facts.otsState === "PASSED")) {
      out.push({ check: "OTS_STATE", detail: `manifest publicAnchoringVerified=${String(manifest.publicAnchoringVerified)}, record ${facts.otsState}` });
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
  if (ots && ots.status !== toVerificationStatus(facts.otsState)) {
    out.push({ check: "OTS_STATE", detail: `matrix anchoring ${ots.status}, record ${facts.otsState}` });
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
