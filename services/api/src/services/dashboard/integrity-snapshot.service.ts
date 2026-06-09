/**
 * Phase 32.8C++++ — EvidenceIntegritySnapshot writer + reader.
 *
 * Advisory operational snapshot of evidence integrity classifier
 * state. The dashboard reads this table for fast "deep integrity"
 * intelligence. When rows are missing (older evidence, fresh
 * workspace, deferred subsystem), the dashboard falls back to live
 * derivation from `Evidence.verificationStatus` + TSA + OTS columns.
 *
 * Hard rules:
 *   - This is ADVISORY data. Writer failures NEVER block evidence /
 *     report / package / verify core flows. Callers wrap every
 *     `recordSnapshotFromEvidence` invocation in `.catch(() => {})`.
 *   - The snapshot mirrors EXISTING worker classifier output (the
 *     `verificationStatus` enum + TSA/OTS columns). It does NOT
 *     recompute hashes from raw bytes — that lives in the worker.
 *   - The dashboard reader is read-only.
 *   - Bounded fields only — no raw file bytes, no signed URLs.
 *   - Operator-safe language: "review required", "TSA signal
 *     unavailable" — no legal-admissibility claims.
 */

import { prisma } from "../../db.js";
// Phase IA-digest-policy — the snapshot writer now sources its
// timestampDigestMatches / otsHashMatches signals from the canonical
// digest-policy evaluator instead of presence-checking the token. The
// evaluator runs over the persisted digest columns and reports bounded
// violations; the snapshot flips matches → false ONLY when a real
// digest disagreement is observed.
import { evaluateDigestPolicy } from "@proovra/shared";

export type IntegritySnapshotOverallStatus =
  | "OK"
  | "REVIEW_REQUIRED"
  | "FAILED"
  | "UNKNOWN";

export type IntegritySnapshotInput = {
  evidenceId: string;
  teamId: string | null;
  verificationStatus: string | null;
  // ---- TSA canonical-digest set (Phase IA-digest-policy) ----
  // Token presence was the only TSA input pre-fix; that let the writer
  // claim `timestampDigestMatches: true` without ever comparing any
  // digest. The canonical digest columns are now passed explicitly so
  // the evaluator can actually run.
  tsaStatus: string | null;
  tsaTokenBase64: string | null;
  tsaGenTimeUtc: Date | null;
  tsaMessageImprint: string | null;
  tsaInputDigestHex: string | null;
  tsaInputKind: string | null;
  // ---- OTS canonical-digest set ----
  otsStatus: string | null;
  otsHash: string | null;
  // ---- Content + fingerprint anchor digests ----
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64: string | null;
};

/** Bounded source-version label. Bump when the derivation rules change. */
const INTEGRITY_SOURCE_VERSION = "v2-2026-06";

/**
 * Phase 32.8C+++++ — TSA issuer parsing. Returns parsed identity fields
 * if a parser is wired; UNAVAILABLE otherwise. The default API-side
 * parser is intentionally a no-op stub: a real ASN.1 TSA token parser
 * lives in the worker package and runs asynchronously. The dashboard
 * NEVER fabricates parsed fields — when the parser is missing the
 * status is the bounded string "UNAVAILABLE".
 */
export function deriveTsaIssuerProjection(input: {
  tsaTokenBase64: string | null;
}): {
  tsaIssuerCommonName: string | null;
  tsaIssuerOrganization: string | null;
  tsaPolicyOid: string | null;
  tsaParseStatus: "PARSED" | "UNAVAILABLE";
  tsaParseErrorCode: string | null;
} {
  if (!input.tsaTokenBase64) {
    return {
      tsaIssuerCommonName: null,
      tsaIssuerOrganization: null,
      tsaPolicyOid: null,
      tsaParseStatus: "UNAVAILABLE",
      tsaParseErrorCode: "TSA_TOKEN_ABSENT",
    };
  }
  // API does not parse ASN.1 — defer to the worker-side parser. The
  // status is UNAVAILABLE (never PARSED, never faked).
  return {
    tsaIssuerCommonName: null,
    tsaIssuerOrganization: null,
    tsaPolicyOid: null,
    tsaParseStatus: "UNAVAILABLE",
    tsaParseErrorCode: "PARSER_NOT_AVAILABLE_IN_API",
  };
}

/**
 * Derive the bounded integrity snapshot shape from existing Evidence
 * fields. Pure function — no DB access. Used by both the writer
 * (which persists the row) and the dashboard fallback (which uses
 * the same logic at read time when no snapshot row exists).
 */
export function deriveIntegritySnapshot(input: IntegritySnapshotInput): {
  canonicalHashMatches: boolean | null;
  signatureValid: boolean | null;
  custodyChainValid: boolean | null;
  timestampDigestMatches: boolean | null;
  otsHashMatches: boolean | null;
  tsaStatus: string;
  otsStatus: string;
  overallStatus: IntegritySnapshotOverallStatus;
  reasonCodes: string[];
} {
  const reasonCodes: string[] = [];

  // verificationStatus is the bounded worker classifier output we trust.
  const vs = input.verificationStatus;
  const isReviewRequired = vs === "REVIEW_REQUIRED";
  const isFailed = vs === "FAILED";
  const isOk =
    vs === "RECORDED_INTEGRITY_VERIFIED" || vs === "MATERIALS_AVAILABLE";

  // Dashboard tri-state derivation — null when not computed.
  const canonicalHashMatches =
    isOk === true ? true : isFailed ? false : isReviewRequired ? false : null;
  const signatureValid =
    isOk === true ? true : isFailed ? false : isReviewRequired ? null : null;
  const custodyChainValid =
    isOk === true ? true : isFailed ? false : isReviewRequired ? null : null;

  // Phase IA-digest-policy — run the canonical digest evaluator over
  // the persisted columns. The evaluator returns bounded violation
  // codes when, e.g., tsaMessageImprint != tsaInputDigestHex on a
  // STAMPED row or otsStatus claims anchored while otsHash is null.
  // We use those bounded codes to drive the `…Matches` flags so the
  // dashboard can no longer claim a match without an actual
  // comparison.
  const policy = evaluateDigestPolicy({
    fileSha256: input.fileSha256,
    fingerprintHash: input.fingerprintHash,
    signatureBase64: input.signatureBase64,
    tsaStatus: input.tsaStatus,
    tsaMessageImprint: input.tsaMessageImprint,
    tsaInputDigestHex: input.tsaInputDigestHex,
    tsaInputKind: input.tsaInputKind,
    otsStatus: input.otsStatus,
    otsHash: input.otsHash,
  });
  const policyCodes = new Set(policy.violations.map((v) => v.code));

  // TSA derivation:
  //   * OK + timestampDigestMatches=true ONLY when the row is STAMPED
  //     AND no TSA-related digest-policy violation surfaced.
  //   * timestampDigestMatches=false when the policy violation says
  //     the persisted imprint and input digest disagree (real bug we
  //     want surfaced, never silently absorbed).
  //   * null otherwise — PENDING / UNAVAILABLE / FAILED rows do not
  //     get a definitive signal from this writer.
  let tsaStatus: string;
  let timestampDigestMatches: boolean | null;
  const rawTsa = (input.tsaStatus ?? "").toUpperCase();
  const tsaDigestPolicyViolated =
    policyCodes.has("tsa_message_imprint_disagrees_with_input_digest") ||
    policyCodes.has("tsa_kind_label_disagrees_with_digest_source");
  if (rawTsa === "STAMPED" && input.tsaTokenBase64) {
    // Phase IA-digest-policy-hard-invariant — a STAMPED row IS OK even
    // when `tsaGenTimeUtc` is null. The token bytes are the authoritative
    // signal; missing genTime is a soft parser issue that the repair
    // tool can later fill in. Pre-fix we treated null genTime as PENDING,
    // which forced a re-poll loop on a row that had already succeeded.
    tsaStatus = tsaDigestPolicyViolated ? "REVIEW_REQUIRED" : "OK";
    timestampDigestMatches = tsaDigestPolicyViolated ? false : true;
    if (tsaDigestPolicyViolated) reasonCodes.push("TSA_DIGEST_POLICY_VIOLATED");
  } else if (rawTsa === "FAILED") {
    tsaStatus = "FAILED";
    timestampDigestMatches = null;
    if (isOk || isReviewRequired) reasonCodes.push("TSA_FAILED");
  } else if (
    input.tsaTokenBase64 == null &&
    input.tsaGenTimeUtc == null &&
    rawTsa === ""
  ) {
    tsaStatus = "UNAVAILABLE";
    timestampDigestMatches = null;
    if (isOk || isReviewRequired) reasonCodes.push("TSA_UNAVAILABLE");
  } else {
    tsaStatus = "PENDING";
    timestampDigestMatches = null;
  }

  // OTS derivation:
  //   * OK + otsHashMatches=true ONLY when the chain says ANCHORED
  //     AND the digest policy did NOT flag a missing otsHash.
  //   * otsHashMatches=false on FAILED rows or when policy says
  //     anchored-without-persisted-hash (the chain is incomplete).
  let otsStatus: string;
  let otsHashMatches: boolean | null;
  const rawOts = (input.otsStatus ?? "").toUpperCase();
  const otsPolicyViolated = policyCodes.has("ots_anchored_without_persisted_hash");
  if (rawOts === "ANCHORED" || rawOts === "VERIFIED") {
    otsStatus = otsPolicyViolated ? "REVIEW_REQUIRED" : "OK";
    otsHashMatches = otsPolicyViolated ? false : true;
    if (otsPolicyViolated) reasonCodes.push("OTS_DIGEST_POLICY_VIOLATED");
  } else if (rawOts === "FAILED" || rawOts === "ERRORED") {
    otsStatus = "FAILED";
    otsHashMatches = false;
    reasonCodes.push("OTS_FAILED");
  } else if (rawOts === "" || input.otsStatus == null) {
    otsStatus = "UNAVAILABLE";
    otsHashMatches = null;
    if (isOk) reasonCodes.push("OTS_UNAVAILABLE");
  } else {
    otsStatus = "PENDING";
    otsHashMatches = null;
  }

  if (isReviewRequired) reasonCodes.push("INTEGRITY_REVIEW_REQUIRED");
  if (isFailed) reasonCodes.push("INTEGRITY_FAILED");

  const overallStatus: IntegritySnapshotOverallStatus = isFailed
    ? "FAILED"
    : isReviewRequired
      ? "REVIEW_REQUIRED"
      : isOk
        ? "OK"
        : "UNKNOWN";

  return {
    canonicalHashMatches,
    signatureValid,
    custodyChainValid,
    timestampDigestMatches,
    otsHashMatches,
    tsaStatus,
    otsStatus,
    overallStatus,
    reasonCodes,
  };
}

/**
 * Upsert a snapshot row from current Evidence state. Advisory — the
 * caller MUST wrap this in `.catch(() => {})` so a snapshot write
 * failure never blocks evidence/report/package core flows.
 *
 * Idempotent on `evidenceId` (1:1 with Evidence).
 */
export async function recordSnapshotFromEvidence(
  input: IntegritySnapshotInput,
): Promise<void> {
  const derived = deriveIntegritySnapshot(input);
  const issuer = deriveTsaIssuerProjection({
    tsaTokenBase64: input.tsaTokenBase64,
  });
  await prisma.evidenceIntegritySnapshot.upsert({
    where: { evidenceId: input.evidenceId },
    create: {
      evidenceId: input.evidenceId,
      teamId: input.teamId,
      canonicalHashMatches: derived.canonicalHashMatches,
      signatureValid: derived.signatureValid,
      custodyChainValid: derived.custodyChainValid,
      timestampDigestMatches: derived.timestampDigestMatches,
      otsHashMatches: derived.otsHashMatches,
      tsaStatus: derived.tsaStatus,
      otsStatus: derived.otsStatus,
      overallStatus: derived.overallStatus,
      reasonCodes: derived.reasonCodes,
      sourceVersion: INTEGRITY_SOURCE_VERSION,
      tsaIssuerCommonName: issuer.tsaIssuerCommonName,
      tsaIssuerOrganization: issuer.tsaIssuerOrganization,
      tsaPolicyOid: issuer.tsaPolicyOid,
      tsaParseStatus: issuer.tsaParseStatus,
      tsaParseErrorCode: issuer.tsaParseErrorCode,
      tsaParsedAtUtc: new Date(),
    },
    update: {
      teamId: input.teamId,
      canonicalHashMatches: derived.canonicalHashMatches,
      signatureValid: derived.signatureValid,
      custodyChainValid: derived.custodyChainValid,
      timestampDigestMatches: derived.timestampDigestMatches,
      otsHashMatches: derived.otsHashMatches,
      tsaStatus: derived.tsaStatus,
      otsStatus: derived.otsStatus,
      overallStatus: derived.overallStatus,
      reasonCodes: derived.reasonCodes,
      computedAtUtc: new Date(),
      sourceVersion: INTEGRITY_SOURCE_VERSION,
      tsaIssuerCommonName: issuer.tsaIssuerCommonName,
      tsaIssuerOrganization: issuer.tsaIssuerOrganization,
      tsaPolicyOid: issuer.tsaPolicyOid,
      tsaParseStatus: issuer.tsaParseStatus,
      tsaParseErrorCode: issuer.tsaParseErrorCode,
      tsaParsedAtUtc: new Date(),
    },
  });
}

/**
 * Read-side helper for the dashboard. Returns snapshots for the
 * workspace, ordered by overall-status severity then computedAtUtc.
 * The dashboard treats `null` snapshots as "fall back to live
 * derivation" — never as "OK".
 */
export async function listWorkspaceIntegritySnapshots(input: {
  teamId: string;
  limit: number;
}): Promise<
  Array<{
    evidenceId: string;
    overallStatus: IntegritySnapshotOverallStatus;
    tsaStatus: string | null;
    otsStatus: string | null;
    reasonCodes: string[];
    computedAtUtc: string;
    /** Phase 32.8C++++++ — TSA issuer fields (never fabricated). */
    tsaIssuerCommonName: string | null;
    tsaIssuerOrganization: string | null;
    tsaPolicyOid: string | null;
    tsaParseStatus: string | null;
    tsaParseErrorCode: string | null;
    tsaParsedAtUtc: string | null;
  }>
> {
  const rows = await prisma.evidenceIntegritySnapshot.findMany({
    where: {
      teamId: input.teamId,
      // Surface only signals the operator needs to action.
      overallStatus: { in: ["REVIEW_REQUIRED", "FAILED"] },
    },
    orderBy: { computedAtUtc: "desc" },
    take: Math.min(Math.max(input.limit, 1), 100),
    select: {
      evidenceId: true,
      overallStatus: true,
      tsaStatus: true,
      otsStatus: true,
      reasonCodes: true,
      computedAtUtc: true,
      tsaIssuerCommonName: true,
      tsaIssuerOrganization: true,
      tsaPolicyOid: true,
      tsaParseStatus: true,
      tsaParseErrorCode: true,
      tsaParsedAtUtc: true,
    },
  });
  return rows.map((r) => ({
    evidenceId: r.evidenceId,
    overallStatus: (r.overallStatus ?? "UNKNOWN") as IntegritySnapshotOverallStatus,
    tsaStatus: r.tsaStatus,
    otsStatus: r.otsStatus,
    reasonCodes: Array.isArray(r.reasonCodes)
      ? (r.reasonCodes as string[])
      : [],
    computedAtUtc: r.computedAtUtc.toISOString(),
    tsaIssuerCommonName: r.tsaIssuerCommonName,
    tsaIssuerOrganization: r.tsaIssuerOrganization,
    tsaPolicyOid: r.tsaPolicyOid,
    tsaParseStatus: r.tsaParseStatus,
    tsaParseErrorCode: r.tsaParseErrorCode,
    tsaParsedAtUtc: r.tsaParsedAtUtc?.toISOString() ?? null,
  }));
}

/**
 * Backfill a bounded slice of workspace evidence into the snapshot
 * table. Used by:
 *   1. the dashboard's deep-integrity engine on first access (lazy
 *      backfill — wraps every write in try/catch so a single failure
 *      doesn't block the rest).
 *   2. an operator-triggered reconcile flow.
 *
 * Never throws — returns the count of rows actually persisted.
 */
export async function backfillIntegritySnapshots(input: {
  teamId: string;
  limit: number;
}): Promise<{ persisted: number; failed: number }> {
  let persisted = 0;
  let failed = 0;
  try {
    const evidence = await prisma.evidence.findMany({
      where: {
        teamId: input.teamId,
        status: { in: ["SIGNED", "REPORTED"] },
      },
      take: Math.min(Math.max(input.limit, 1), 200),
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        teamId: true,
        verificationStatus: true,
        // Phase IA-digest-policy — backfill MUST pass the full digest
        // set so the evaluator can compare. Pre-fix it only carried
        // token presence + ots status, which let the writer claim a
        // false-positive timestampDigestMatches=true.
        tsaStatus: true,
        tsaTokenBase64: true,
        tsaGenTimeUtc: true,
        tsaMessageImprint: true,
        tsaInputDigestHex: true,
        tsaInputKind: true,
        otsStatus: true,
        otsHash: true,
        fileSha256: true,
        fingerprintHash: true,
        signatureBase64: true,
      },
    });
    for (const e of evidence) {
      try {
        await recordSnapshotFromEvidence({
          evidenceId: e.id,
          teamId: e.teamId,
          verificationStatus: e.verificationStatus
            ? String(e.verificationStatus)
            : null,
          tsaStatus: e.tsaStatus ?? null,
          tsaTokenBase64: e.tsaTokenBase64 ?? null,
          tsaGenTimeUtc: e.tsaGenTimeUtc ?? null,
          tsaMessageImprint: e.tsaMessageImprint ?? null,
          tsaInputDigestHex: e.tsaInputDigestHex ?? null,
          tsaInputKind: e.tsaInputKind ?? null,
          otsStatus: e.otsStatus ?? null,
          otsHash: e.otsHash ?? null,
          fileSha256: e.fileSha256 ?? null,
          fingerprintHash: e.fingerprintHash ?? null,
          signatureBase64: e.signatureBase64 ?? null,
        });
        persisted += 1;
      } catch {
        failed += 1;
      }
    }
  } catch {
    /* If the outer query itself fails we silently degrade. */
  }
  return { persisted, failed };
}
