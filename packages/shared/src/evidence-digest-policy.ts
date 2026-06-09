/**
 * Phase IA-digest-policy — single canonical digest set for an Evidence row.
 *
 * The platform persists FIVE distinct digests for any single piece of
 * evidence. Mixing them up — or worse, comparing a TSA response against
 * the wrong one — would silently lie to the verifier. This module is the
 * single source of truth for:
 *
 *   1. `contentDigest`    — the original file SHA-256 OR, for a
 *                            multipart record, the canonical package
 *                            SHA-256. Source-of-truth column:
 *                            `evidence.fileSha256`.
 *
 *   2. `fingerprintHash`  — the canonical evidence-fingerprint hash
 *                            (sha256 of the canonicalized JSON
 *                            fingerprint envelope). Source-of-truth
 *                            column: `evidence.fingerprintHash`.
 *
 *   3. `signatureDigest`  — the exact bytes the platform's Ed25519
 *                            signer signs. Today this IS the fingerprint
 *                            hash (`signer.signFingerprintHex(fingerprintHash)`)
 *                            — we surface it as a separate label so a
 *                            future divergence (signing a different
 *                            envelope) does not silently change the
 *                            verification chain.
 *
 *   4. `tsaDigest`        — the message imprint the platform sent to the
 *                            RFC 3161 TSA AND the imprint the response
 *                            certifies. Source-of-truth columns:
 *                              * sent — `evidence.tsaMessageImprint`
 *                              * accepted — `evidence.tsaInputDigestHex`
 *                            On a STAMPED row, both columns MUST be
 *                            equal AND MUST equal what was sent to the
 *                            provider. `evidence.tsaInputKind` carries
 *                            the operator-facing label
 *                            (`FILE_SHA256` or `CANONICAL_PACKAGE_SHA256`).
 *
 *   5. `otsDigest`        — the hash OpenTimestamps anchors. Source-of-
 *                            truth column: `evidence.otsHash`.
 *
 * RULES every read/write site MUST follow:
 *
 *   * NEVER compare a TSA response message imprint against
 *     `evidence.fileSha256` or `evidence.fingerprintHash`. Compare it
 *     against the digest that was sent (i.e. the request digest the
 *     finalize callsite passed to `createEvidenceTimestamp`, which is
 *     mirrored on the persisted row as `evidence.tsaMessageImprint`).
 *
 *   * NEVER source the "timestamped digest" displayed in the report or
 *     verification package from `evidence.fileSha256` directly. Read
 *     `evidence.tsaInputDigestHex` (the accepted-input column, only
 *     non-null when STAMPED) — falling back to
 *     `evidence.tsaMessageImprint` for legacy rows.
 *
 *   * NEVER claim "OTS hash matches" when the OTS column would be
 *     null/empty. Compare `evidence.otsHash` to whatever the report
 *     decides is the OTS-canonical digest (today: the same column).
 *
 *   * NEVER change the digest TARGET (file → package, fingerprint →
 *     file, etc.) without a migration, documentation update, report-
 *     label update, AND new tests. This module is the gatekeeper —
 *     a future change has to update the equality predicate here, which
 *     is pinned by `phase-ia-digest-policy.test.ts`.
 *
 * NOT in scope here: the actual hashing, signing, timestamping, or
 * anchoring. This module is the labeling + invariant layer only.
 */

/**
 * Bounded label for what the TSA actually accepted as the message
 * imprint. Stored on `evidence.tsaInputKind`. The label is part of the
 * trust chain — a STAMPED row whose label disagrees with the digest
 * source would be a regression.
 */
export type TsaInputKind = "FILE_SHA256" | "CANONICAL_PACKAGE_SHA256";

/**
 * The canonical digest set for a single Evidence row. Use this shape
 * everywhere the chain needs to be displayed, packaged, or verified.
 */
export type EvidenceDigestSet = {
  /**
   * Original file SHA-256, or canonical package SHA-256 for multipart.
   * `evidence.fileSha256`.
   */
  contentDigest: string | null;
  /**
   * Canonical fingerprint hash. `evidence.fingerprintHash`.
   */
  fingerprintHash: string | null;
  /**
   * Bytes that were signed. Today equals `fingerprintHash`. Kept
   * separate so a future signing-envelope change is forced through
   * `assertDigestPolicyConsistent`.
   */
  signatureDigest: string | null;
  /**
   * Message imprint sent to the TSA AND certified by the response.
   * `evidence.tsaInputDigestHex` (accepted-input column) when STAMPED;
   * `evidence.tsaMessageImprint` is the legacy fallback for rows that
   * predate the truthful-semantics gate. Both must be equal on STAMPED.
   */
  tsaDigest: string | null;
  /**
   * Hash anchored by OpenTimestamps. `evidence.otsHash`.
   */
  otsDigest: string | null;
  /**
   * Bounded label for what the TSA accepted. Null when TSA was not
   * STAMPED. Operator-facing — drives the report label.
   */
  tsaInputKind: TsaInputKind | null;
};

/**
 * Bounded set of inconsistencies. Each code identifies ONE invariant
 * that, when violated, makes the chain misleading even if every
 * individual digest is internally well-formed.
 */
export type DigestPolicyViolationCode =
  /** `evidence.tsaMessageImprint` and `evidence.tsaInputDigestHex` disagree on a STAMPED row. */
  | "tsa_message_imprint_disagrees_with_input_digest"
  /** `tsaInputKind === "CANONICAL_PACKAGE_SHA256"` but the TSA digest equals the legacy file SHA-256 path. */
  | "tsa_kind_label_disagrees_with_digest_source"
  /** signature digest is non-null but disagrees with `fingerprintHash`. */
  | "signature_digest_disagrees_with_fingerprint_hash"
  /** OTS is marked anchored but `otsHash` is null. */
  | "ots_anchored_without_persisted_hash";

export type DigestPolicyViolation = {
  code: DigestPolicyViolationCode;
  detail: string;
};

/**
 * Input for `evaluateDigestPolicy`. Accepts the raw Evidence-row shape
 * so callers don't have to project first. Every field is optional so
 * partial reads (e.g. snapshot writer) still work.
 */
export type EvaluateDigestPolicyInput = {
  fileSha256: string | null;
  fingerprintHash: string | null;
  signatureBase64?: string | null;
  tsaStatus: string | null;
  tsaMessageImprint: string | null;
  tsaInputDigestHex: string | null;
  tsaInputKind: string | null;
  otsStatus: string | null;
  otsHash: string | null;
};

const TSA_KIND_VALUES: ReadonlySet<TsaInputKind> = new Set([
  "FILE_SHA256",
  "CANONICAL_PACKAGE_SHA256",
]);

function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[0-9a-f]+$/.test(trimmed) ? trimmed : null;
}

function isTsaKind(value: unknown): value is TsaInputKind {
  return typeof value === "string" && TSA_KIND_VALUES.has(value as TsaInputKind);
}

/**
 * Pure projection: build the canonical digest set for an Evidence row.
 * Returns `null` digests when the corresponding column is null.
 */
export function buildEvidenceDigestSet(
  input: EvaluateDigestPolicyInput,
): EvidenceDigestSet {
  // Truthful-semantics gate: `tsaInputDigestHex` is only non-null when
  // `tsaStatus === "STAMPED"` (Issue #8). Prefer it; fall back to the
  // message imprint column for forensic display on FAILED rows.
  const tsaDigest =
    normalizeHex(input.tsaInputDigestHex) ??
    normalizeHex(input.tsaMessageImprint);

  // Signature digest mirrors `fingerprintHash` by current platform
  // policy. Surfaced as a separate field so a future divergence is
  // caught by `assertDigestPolicyConsistent`.
  const fingerprintHash = normalizeHex(input.fingerprintHash);
  const signatureDigest = input.signatureBase64
    ? fingerprintHash
    : null;

  return {
    contentDigest: normalizeHex(input.fileSha256),
    fingerprintHash,
    signatureDigest,
    tsaDigest,
    otsDigest: normalizeHex(input.otsHash),
    tsaInputKind: isTsaKind(input.tsaInputKind) ? input.tsaInputKind : null,
  };
}

/**
 * Evaluate the row's chain against the canonical policy. Returns the
 * digest set + a bounded violation list. NEVER throws.
 *
 * Use the violation list for telemetry / smoke output. Use
 * `assertDigestPolicyConsistent` when you want a hard error.
 */
export function evaluateDigestPolicy(
  input: EvaluateDigestPolicyInput,
): { digests: EvidenceDigestSet; violations: DigestPolicyViolation[] } {
  const digests = buildEvidenceDigestSet(input);
  const violations: DigestPolicyViolation[] = [];

  // Invariant 1: on STAMPED rows, tsaMessageImprint MUST equal
  // tsaInputDigestHex. They both record the same digest — one is the
  // "sent" view, the other the "accepted" view, and on success they
  // are by construction the same value.
  if ((input.tsaStatus ?? "").toUpperCase() === "STAMPED") {
    const sent = normalizeHex(input.tsaMessageImprint);
    const accepted = normalizeHex(input.tsaInputDigestHex);
    if (sent !== null && accepted !== null && sent !== accepted) {
      violations.push({
        code: "tsa_message_imprint_disagrees_with_input_digest",
        detail: `tsaMessageImprint=${sent.slice(0, 16)}… != tsaInputDigestHex=${accepted.slice(0, 16)}…`,
      });
    }
  }

  // Invariant 2: when tsaInputKind says CANONICAL_PACKAGE_SHA256, the
  // tsaDigest MUST equal the contentDigest (which IS the canonical
  // package SHA-256 for multipart records, per the schema comment).
  // When tsaInputKind says FILE_SHA256, same equality must hold for a
  // single-file record. Either way, tsaDigest === contentDigest on
  // any STAMPED row whose label is set.
  if (
    digests.tsaInputKind &&
    digests.tsaDigest !== null &&
    digests.contentDigest !== null &&
    digests.tsaDigest !== digests.contentDigest
  ) {
    violations.push({
      code: "tsa_kind_label_disagrees_with_digest_source",
      detail: `tsaInputKind=${digests.tsaInputKind} but tsaDigest != contentDigest (${digests.tsaDigest.slice(0, 16)}… vs ${digests.contentDigest.slice(0, 16)}…)`,
    });
  }

  // Invariant 3: when there IS a signature, signatureDigest must
  // equal fingerprintHash. Today this is by construction
  // (`signer.signFingerprintHex(fingerprintHash)`); pinning it makes
  // a future "let me sign a different envelope" refactor explicit.
  if (
    digests.signatureDigest !== null &&
    digests.fingerprintHash !== null &&
    digests.signatureDigest !== digests.fingerprintHash
  ) {
    violations.push({
      code: "signature_digest_disagrees_with_fingerprint_hash",
      detail: "the signed digest does not equal the fingerprint hash",
    });
  }

  // Invariant 4: ANCHORED OTS rows MUST have a persisted otsHash. If
  // not, the trust chain has no anchor digest to display and the
  // report cannot honestly claim anchored truth.
  const ots = (input.otsStatus ?? "").toUpperCase();
  if ((ots === "ANCHORED" || ots === "VERIFIED") && digests.otsDigest === null) {
    violations.push({
      code: "ots_anchored_without_persisted_hash",
      detail: "otsStatus claims anchored but evidence.otsHash is null",
    });
  }

  return { digests, violations };
}

/**
 * Throw if any digest-policy invariant is violated. Use at write sites
 * (finalize, OTS upgrade ANCHORED branch) so the row never lands in an
 * inconsistent state.
 */
export function assertDigestPolicyConsistent(
  input: EvaluateDigestPolicyInput,
): EvidenceDigestSet {
  const { digests, violations } = evaluateDigestPolicy(input);
  if (violations.length > 0) {
    const summary = violations.map((v) => `${v.code}: ${v.detail}`).join("; ");
    throw new Error(`DIGEST_POLICY_VIOLATION: ${summary}`);
  }
  return digests;
}

/**
 * Operator-facing label for the timestamped digest, derived from the
 * TSA input kind. Used by the technical-appendix report renderer and
 * the verification package manifest so they stop hard-coding
 * "lead item SHA-256" when the actual kind is CANONICAL_PACKAGE_SHA256.
 *
 * The label intentionally does NOT make a legal claim — it states the
 * digest source. The trust chain elsewhere already states what the TSA
 * certifies.
 */
export function describeTsaDigestSource(
  tsaInputKind: TsaInputKind | string | null | undefined,
): string {
  if (tsaInputKind === "CANONICAL_PACKAGE_SHA256") {
    return "Timestamped digest (canonical package SHA-256)";
  }
  if (tsaInputKind === "FILE_SHA256") {
    return "Timestamped digest (original file SHA-256)";
  }
  return "Timestamped digest";
}
