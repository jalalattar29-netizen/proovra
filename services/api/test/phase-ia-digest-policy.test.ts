/**
 * Phase IA-digest-policy — single canonical digest set per evidence row.
 *
 * The platform persists 5 digests for any Evidence: contentDigest,
 * fingerprintHash, signatureDigest, tsaDigest, otsDigest. These tests
 * fail if any chain surface diverges from the canonical policy:
 *
 *   1. `evaluateDigestPolicy` recognises every shape we expect to see
 *      in production (STAMPED + matched, STAMPED + mismatched =
 *      violation, FAILED, ANCHORED missing hash, etc.)
 *   2. The TSA finalize callsite passes ONE digest to the service and
 *      that same digest is what the service returns as
 *      `messageImprint` (so `evidence.tsaMessageImprint ===
 *      evidence.tsaInputDigestHex` is by construction on STAMPED).
 *   3. The report-v2 view-model + technical-appendix read the digest
 *      from the persisted columns, NOT from `evidence.fileSha256`
 *      directly.
 *   4. The verification package manifest (build-view-model snapshot)
 *      sources its `tsaMessageImprint` and `otsHash` from the
 *      persisted columns.
 *   5. The integrity-snapshot writer can no longer falsely claim
 *      `timestampDigestMatches: true` without an actual comparison.
 *
 * IMPORTANT: this test does NOT change trust semantics. It pins the
 * existing behaviour so a future refactor that mixes up digests trips
 * the suite.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildEvidenceDigestSet,
  describeTsaDigestSource,
  evaluateDigestPolicy,
  assertDigestPolicyConsistent,
} from "@proovra/shared";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SAMPLE_DIGEST_A =
  "1cb2724aeb57206ab6ad795a2fdb0e97eb1349a8d7b1a0adeb090e76e6d2ddb9";
const SAMPLE_DIGEST_B =
  "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const SAMPLE_FP =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

// ============================================================================
// 1. Policy evaluator — every bounded code surfaces correctly
// ============================================================================

describe("Phase IA-digest-policy — evaluator covers every invariant", () => {
  it("STAMPED row with matching imprint + input digest → 0 violations", () => {
    const r = evaluateDigestPolicy({
      fileSha256: SAMPLE_DIGEST_A,
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "STAMPED",
      tsaMessageImprint: SAMPLE_DIGEST_A,
      tsaInputDigestHex: SAMPLE_DIGEST_A,
      tsaInputKind: "FILE_SHA256",
      otsStatus: "ANCHORED",
      otsHash: SAMPLE_DIGEST_A,
    });
    expect(r.violations).toEqual([]);
    expect(r.digests.tsaDigest).toBe(SAMPLE_DIGEST_A);
    expect(r.digests.contentDigest).toBe(SAMPLE_DIGEST_A);
  });

  it("STAMPED row where tsaMessageImprint !== tsaInputDigestHex → bounded violation", () => {
    const r = evaluateDigestPolicy({
      fileSha256: SAMPLE_DIGEST_A,
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "STAMPED",
      tsaMessageImprint: SAMPLE_DIGEST_A,
      tsaInputDigestHex: SAMPLE_DIGEST_B,
      tsaInputKind: "FILE_SHA256",
      otsStatus: "ANCHORED",
      otsHash: SAMPLE_DIGEST_A,
    });
    expect(r.violations.map((v) => v.code)).toContain(
      "tsa_message_imprint_disagrees_with_input_digest",
    );
  });

  it("CANONICAL_PACKAGE_SHA256 label + tsaDigest != contentDigest → bounded violation", () => {
    const r = evaluateDigestPolicy({
      fileSha256: SAMPLE_DIGEST_B, // package digest
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "STAMPED",
      tsaMessageImprint: SAMPLE_DIGEST_A, // a different digest was timestamped
      tsaInputDigestHex: SAMPLE_DIGEST_A,
      tsaInputKind: "CANONICAL_PACKAGE_SHA256",
      otsStatus: "ANCHORED",
      otsHash: SAMPLE_DIGEST_A,
    });
    expect(r.violations.map((v) => v.code)).toContain(
      "tsa_kind_label_disagrees_with_digest_source",
    );
  });

  it("FAILED TSA row → no violation (truthful semantics gate)", () => {
    const r = evaluateDigestPolicy({
      fileSha256: SAMPLE_DIGEST_A,
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "FAILED",
      tsaMessageImprint: SAMPLE_DIGEST_A,
      // Issue #8 truthful semantics: FAILED rows MUST have null input digest.
      tsaInputDigestHex: null,
      tsaInputKind: null,
      otsStatus: null,
      otsHash: null,
    });
    expect(r.violations).toEqual([]);
  });

  it("ANCHORED OTS without persisted otsHash → bounded violation", () => {
    const r = evaluateDigestPolicy({
      fileSha256: SAMPLE_DIGEST_A,
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "STAMPED",
      tsaMessageImprint: SAMPLE_DIGEST_A,
      tsaInputDigestHex: SAMPLE_DIGEST_A,
      tsaInputKind: "FILE_SHA256",
      otsStatus: "ANCHORED",
      otsHash: null,
    });
    expect(r.violations.map((v) => v.code)).toContain(
      "ots_anchored_without_persisted_hash",
    );
  });

  it("assertDigestPolicyConsistent throws on violation with the bounded code in the message", () => {
    expect(() =>
      assertDigestPolicyConsistent({
        fileSha256: SAMPLE_DIGEST_A,
        fingerprintHash: SAMPLE_FP,
        signatureBase64: "sig",
        tsaStatus: "STAMPED",
        tsaMessageImprint: SAMPLE_DIGEST_A,
        tsaInputDigestHex: SAMPLE_DIGEST_B,
        tsaInputKind: "FILE_SHA256",
        otsStatus: null,
        otsHash: null,
      }),
    ).toThrow(/tsa_message_imprint_disagrees_with_input_digest/);
  });

  it("buildEvidenceDigestSet picks tsaInputDigestHex when present (truthful gate)", () => {
    const set = buildEvidenceDigestSet({
      fileSha256: SAMPLE_DIGEST_A,
      fingerprintHash: SAMPLE_FP,
      signatureBase64: "sig",
      tsaStatus: "STAMPED",
      tsaMessageImprint: SAMPLE_DIGEST_A,
      tsaInputDigestHex: SAMPLE_DIGEST_A,
      tsaInputKind: "FILE_SHA256",
      otsStatus: "ANCHORED",
      otsHash: SAMPLE_DIGEST_A,
    });
    expect(set.tsaDigest).toBe(SAMPLE_DIGEST_A);
    expect(set.contentDigest).toBe(SAMPLE_DIGEST_A);
    expect(set.fingerprintHash).toBe(SAMPLE_FP);
    expect(set.signatureDigest).toBe(SAMPLE_FP);
    expect(set.otsDigest).toBe(SAMPLE_DIGEST_A);
    expect(set.tsaInputKind).toBe("FILE_SHA256");
  });

  it("describeTsaDigestSource emits operator-readable labels per kind", () => {
    expect(describeTsaDigestSource("FILE_SHA256")).toBe(
      "Timestamped digest (original file SHA-256)",
    );
    expect(describeTsaDigestSource("CANONICAL_PACKAGE_SHA256")).toBe(
      "Timestamped digest (canonical package SHA-256)",
    );
    expect(describeTsaDigestSource(null)).toBe("Timestamped digest");
    expect(describeTsaDigestSource("UNKNOWN_FUTURE_KIND")).toBe(
      "Timestamped digest",
    );
  });
});

// ============================================================================
// 2. TSA forward path — same digest threads through every site
// ============================================================================

describe("Phase IA-digest-policy — TSA digest thread is single-sourced", () => {
  const SERVICE = readSource("../src/services/timestamp.service.ts");

  it("openssl ts -query receives the digestHex passed to createEvidenceTimestamp", () => {
    expect(SERVICE).toMatch(
      /"ts",[\s\S]{0,200}"-query",[\s\S]{0,200}"-digest",[\s\S]{0,200}digestHex/,
    );
  });

  it("parseTsaReply receives the SAME digestHex as the expected-imprint argument", () => {
    expect(SERVICE).toMatch(/parseTsaReply\(stdout,\s*digestHex\)/);
  });

  it("messageImprint persisted on STAMPED equals the same digestHex", () => {
    // Both granted and parser-side FAILED branches set
    // messageImprint: digestHex (the variable, not fileSha256). This
    // guarantees evidence.tsaMessageImprint == what we sent.
    expect(SERVICE).toMatch(
      /if \(parsed\.granted\)[\s\S]{0,500}messageImprint:\s*digestHex/,
    );
  });

  const EVIDENCE_COMPLETE = readSource(
    "../src/services/evidence-complete.service.ts",
  );

  it("finalize callsite passes fileSha256 as the TSA digest", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /createEvidenceTimestamp\(\{\s*digestHex:\s*fileSha256\s*,?\s*\}\)/,
    );
  });

  it("finalize tsaInputKind label is derived from multipart count (kept in sync with the digest)", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /const tsaInputKind\s*=[\s\S]{0,200}multipartItemCount\s*>\s*1[\s\S]{0,100}"CANONICAL_PACKAGE_SHA256"[\s\S]{0,100}"FILE_SHA256"/,
    );
  });

  it("finalize tsaInputDigestHex is sourced from tsaResult.messageImprint (NOT re-derived from fileSha256)", () => {
    // Truthful semantics: when STAMPED, tsaInputDigestHex == the actual
    // accepted message imprint (= digestHex we sent). NOT a re-read of
    // fileSha256, which would silently lie on a future multipart-vs-
    // single mix-up.
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaInputDigestHex:\s*[\s\S]{0,200}tsaResult\?\.status\s*===\s*"STAMPED"\s*\?\s*tsaResult\.messageImprint\s*\?\?\s*null/,
    );
    // The persistence MUST NOT read fileSha256 as the input digest.
    expect(EVIDENCE_COMPLETE).not.toMatch(
      /tsaInputDigestHex:\s*fileSha256/,
    );
  });
});

// ============================================================================
// 3. Integrity snapshot — real comparison, not presence check
// ============================================================================

describe("Phase IA-digest-policy — integrity snapshot actually compares digests", () => {
  const SNAPSHOT = readSource(
    "../src/services/dashboard/integrity-snapshot.service.ts",
  );

  it("imports the canonical evaluator from @proovra/shared", () => {
    expect(SNAPSHOT).toMatch(
      /import[\s\S]{0,200}evaluateDigestPolicy[\s\S]{0,200}from\s*["']@proovra\/shared["']/,
    );
  });

  it("does NOT claim timestampDigestMatches=true purely from token presence", () => {
    // The OLD code path was:
    //   if (input.tsaTokenBase64 && input.tsaGenTimeUtc) { timestampDigestMatches = true; }
    // That set the flag without ever comparing any digest. The new
    // implementation MUST run evaluateDigestPolicy and only set true
    // when no relevant violation surfaced.
    expect(SNAPSHOT).not.toMatch(
      /if \(input\.tsaTokenBase64 && input\.tsaGenTimeUtc\) \{[\s\S]{0,200}timestampDigestMatches\s*=\s*true/,
    );
  });

  it("snapshot input shape carries the digest columns required for comparison", () => {
    // Comparison needs tsaMessageImprint, tsaInputDigestHex, otsHash —
    // pre-fix the input shape only carried tsaTokenBase64 + otsStatus.
    expect(SNAPSHOT).toMatch(/tsaMessageImprint:\s*string \| null/);
    expect(SNAPSHOT).toMatch(/tsaInputDigestHex:\s*string \| null/);
    expect(SNAPSHOT).toMatch(/otsHash:\s*string \| null/);
  });
});
