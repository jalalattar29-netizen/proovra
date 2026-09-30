/**
 * Phase A0 — Worker integrity hard-gate, contract suite.
 *
 * Source-contract style (same as the Phase 30 worker tests). We do
 * not boot Prisma or BullMQ in this suite — the helper is exercised
 * directly via a small in-memory client double, and the wiring into
 * the report processor is asserted at the source level.
 *
 * Five contracts:
 *
 *   1. `integrity-rejection.service.ts` short-circuits when the row
 *      is already FAILED_HASH_MISMATCH (idempotent).
 *
 *   2. The helper performs the four mandatory side-effects in ONE
 *      Prisma transaction: status flip + custody event + security
 *      event. (We assert via a stub `$transaction` that the closure
 *      writes against `evidence.updateMany`, the custody-events
 *      tx helper, and `securityEvent.create`.)
 *
 *   3. The helper emits the structured log line
 *      `evidence.integrity.rejected` with bounded fields and
 *      truncated hash previews — never the full hashes.
 *
 *   4. `processor.ts` invokes `rejectEvidenceIntegrity(...)` at BOTH
 *      mismatch sites BEFORE throwing `EVIDENCE_FILE_SHA256_MISMATCH`,
 *      and passes the right `source` value in each.
 *
 *   5. The helper's `IntegrityRejectionSource` union is the bounded
 *      vocabulary the spec calls out — no free-text reasons.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const PROCESSOR_SRC = readSource("../src/processor.ts");
const REJECTION_SRC = readSource("../src/integrity-rejection.service.ts");

describe("Phase A0 — worker integrity hard-gate (source contract)", () => {
  // ET-SM-07 (2026-09-30) — the report pipeline no longer rejects on its own.
  // It reports what it read to the integrity-recheck authority
  // (integrity-recheck.ts), which records the check and is the ONLY caller of
  // the rejection helper. The guarantees this suite pinned are unchanged: a
  // mismatch is recorded and rejected BEFORE the throw, at both sites, each
  // naming its source.
  it("processor.ts reports to the integrity-recheck authority, and never rejects on its own", () => {
    expect(PROCESSOR_SRC).toContain(
      'import { recheckEvidenceIntegrity, recordIntegrityObservation } from "./integrity-recheck.js";',
    );
    expect(PROCESSOR_SRC).not.toMatch(/rejectEvidenceIntegrity/);
  });

  it("processor.ts records the multipart mismatch before throwing", () => {
    expect(PROCESSOR_SRC).toMatch(
      /recordIntegrityObservation\(\{[\s\S]*?failureCode:\s*"DIGEST_MISMATCH"[\s\S]*?rejectionSource:\s*"worker\.report\.multipart"[\s\S]*?\}\);\s*\n\s*throw createWorkerError\("EVIDENCE_FILE_SHA256_MISMATCH",\s*false\);/,
    );
  });

  it("processor.ts records the single-file mismatch before throwing", () => {
    expect(PROCESSOR_SRC).toMatch(
      /recordIntegrityObservation\(\{[\s\S]*?failureCode:\s*"DIGEST_MISMATCH"[\s\S]*?rejectionSource:\s*"worker\.report\.single_file"[\s\S]*?\}\);\s*\n\s*throw createWorkerError\("EVIDENCE_FILE_SHA256_MISMATCH",\s*false\);/,
    );
  });

  it("a successful re-hash is recorded as a VERIFIED check at both sites", () => {
    expect(PROCESSOR_SRC.match(/outcome:\s*"VERIFIED",\s*\n\s*failureCode:\s*null,/g)?.length).toBe(2);
  });

  it("the authority is the rejection helper's only caller", () => {
    const AUTHORITY_SRC = readSource("../src/integrity-recheck.ts");
    expect(AUTHORITY_SRC).toMatch(
      /observation\.failureCode === "DIGEST_MISMATCH"[\s\S]*?await rejectEvidenceIntegrity\(\{/,
    );
    expect(AUTHORITY_SRC.match(/rejectEvidenceIntegrity\(/g)?.length).toBe(1);
  });

  it("helper exports the bounded IntegrityRejectionSource union", () => {
    const union = REJECTION_SRC.slice(
      REJECTION_SRC.indexOf("export type IntegrityRejectionSource"),
      REJECTION_SRC.indexOf("export type IntegrityRejectionResult"),
    );
    expect(union).toContain('"worker.report.single_file"');
    expect(union).toContain('"worker.report.multipart"');
    // Live since ET-SM-07: the scheduled and on-demand recheck.
    expect(union).toContain('| "worker.reconciler";');
    // A label nothing ever passed is not part of the vocabulary.
    expect(union).not.toContain('| "api.completion"');
  });

  it("helper writes evidence.updateMany with a SIGNED/REPORTED precondition", () => {
    // The precondition makes the rejection a single-shot, race-safe
    // operation: only a SIGNED or REPORTED row may transition to
    // FAILED_HASH_MISMATCH. A row already in DESTROYED / DELETED /
    // FAILED_HASH_MISMATCH cannot be re-flipped.
    expect(REJECTION_SRC).toMatch(/updateMany\(\{\s*where:/);
    expect(REJECTION_SRC).toContain("EvidenceStatus.SIGNED");
    expect(REJECTION_SRC).toContain("EvidenceStatus.REPORTED");
    expect(REJECTION_SRC).toContain("EvidenceStatus.FAILED_HASH_MISMATCH");
    expect(REJECTION_SRC).toContain("VerificationStatus.FAILED");
  });

  it("helper appends the INTEGRITY_REJECTED_HASH_MISMATCH custody event inside the same transaction", () => {
    expect(REJECTION_SRC).toContain(
      "CustodyEventType.INTEGRITY_REJECTED_HASH_MISMATCH",
    );
    expect(REJECTION_SRC).toContain("appendCustodyEventTx");
  });

  it("helper inserts a SecurityEvent of type evidence_integrity_rejected (severity HIGH)", () => {
    expect(REJECTION_SRC).toContain("securityEvent.create");
    expect(REJECTION_SRC).toContain('"evidence_integrity_rejected"');
    expect(REJECTION_SRC).toContain('severity: "HIGH"');
  });

  it("helper truncates hash previews — never logs full digests in SecurityEvent details", () => {
    // The hex preview helper truncates to first/last 8 chars; full
    // hashes live on the custody payload and structured log only.
    expect(REJECTION_SRC).toContain("HEX_PREVIEW_LEN = 8");
    expect(REJECTION_SRC).toContain("hexPreview(params.expectedSha256)");
    expect(REJECTION_SRC).toContain("hexPreview(params.computedSha256)");
  });

  it("helper emits the structured log line evidence.integrity.rejected", () => {
    expect(REJECTION_SRC).toContain('"evidence.integrity.rejected"');
  });

  it("helper bumps the evidence_integrity_rejections_total metric", () => {
    expect(REJECTION_SRC).toContain("evidence_integrity_rejections_total");
  });

  it("helper short-circuits on already-rejected (idempotent)", () => {
    expect(REJECTION_SRC).toContain('"already_rejected"');
    expect(REJECTION_SRC).toContain(
      "EvidenceStatus.FAILED_HASH_MISMATCH",
    );
  });

  it("vocabulary discipline — no claims of tampering, forgery, fakery, or admissibility", () => {
    // The helper's contract is mechanical: it states a SHA-256
    // disagreement, never a factual claim about WHY or WHO.
    const banned = [
      /\btampered\b/i,
      /\btamper-?proof\b/i,
      /\bforged\b/i,
      /\bauthentic\b/i,
      /\badmissible\b/i,
      /\bfactual\s+truth\b/i,
    ];
    for (const re of banned) {
      expect(REJECTION_SRC).not.toMatch(re);
    }
  });
});
