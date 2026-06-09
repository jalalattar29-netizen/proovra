/**
 * Phase IA-forward-path — smoke script safety contract.
 *
 * `smoke-evidence-forward-path.ts` runs against PRODUCTION at the
 * operator's direction. The contract: it makes ZERO writes, ZERO
 * subprocess calls, and ZERO provider re-contact. These tests pin that
 * contract so a future "let me just patch this one thing" refactor
 * cannot quietly turn the diagnostic into a stealth migration tool.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("Phase IA-forward-path — smoke-evidence-forward-path safety contract", () => {
  const SCRIPT = readSource(
    "../src/scripts/smoke-evidence-forward-path.ts",
  );

  it("requires --evidence-id and exits 1 when missing", () => {
    expect(SCRIPT).toMatch(/--evidence-id <uuid> is required/);
    expect(SCRIPT).toMatch(/if \(!args\.evidenceId\)/);
  });

  it("ONLY uses read-only Prisma calls (findUnique / findMany)", () => {
    const writeSites = SCRIPT.match(
      /prisma\.[a-zA-Z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g,
    );
    expect(writeSites ?? []).toEqual([]);
    // No raw SQL execute either.
    expect(SCRIPT).not.toMatch(/\$executeRaw/);
    expect(SCRIPT).not.toMatch(/\$queryRawUnsafe/);
  });

  it("NEVER shells out to openssl / curl / external commands", () => {
    expect(SCRIPT).not.toMatch(/execFile/);
    expect(SCRIPT).not.toMatch(/child_process/);
    expect(SCRIPT).not.toMatch(/"openssl"/);
    expect(SCRIPT).not.toMatch(/"curl"/);
  });

  it("NEVER enqueues a BullMQ job", () => {
    expect(SCRIPT).not.toMatch(/enqueue[A-Z][A-Za-z]*Job\(/);
    expect(SCRIPT).not.toMatch(/\.add\(/);
  });

  it("disconnects Prisma on both success and fatal paths", () => {
    expect(SCRIPT).toMatch(/await prisma\.\$disconnect\(\)/);
    expect(SCRIPT).toMatch(
      /main\(\)[\s\S]{0,100}\.then\(async[\s\S]{0,200}\$disconnect[\s\S]{0,500}\.catch\(async[\s\S]{0,200}\$disconnect/,
    );
  });

  it("emits PASS/FAIL probe results (operator-readable)", () => {
    expect(SCRIPT).toMatch(/\[\$\{mark\}\] \$\{p\.name\}/);
    expect(SCRIPT).toMatch(/mark = p\.ok \? "PASS" : "FAIL"/);
  });

  it("reads the canonical TSA truth columns (Issue #8)", () => {
    // The diagnostic MUST observe the columns the truth surface reads,
    // not a subset, so the operator can see exactly what the
    // verify/report pipeline will see.
    for (const col of [
      "tsaProvider",
      "tsaUrl",
      "tsaSerialNumber",
      "tsaGenTimeUtc",
      "tsaTokenBase64",
      "tsaMessageImprint",
      "tsaInputDigestHex",
      "tsaInputKind",
      "tsaHashAlgorithm",
      "tsaStatus",
      "tsaFailureReason",
    ]) {
      expect(SCRIPT, `smoke script should select ${col}`).toMatch(
        new RegExp(`${col}:\\s*true`),
      );
    }
  });

  it("reads the OTS truth columns (status, txid, anchoredAtUtc, proof)", () => {
    for (const col of [
      "otsStatus",
      "otsHash",
      "otsProofBase64",
      "otsCalendar",
      "otsBitcoinTxid",
      "otsAnchoredAtUtc",
      "otsUpgradedAtUtc",
      "otsFailureReason",
    ]) {
      expect(SCRIPT, `smoke script should select ${col}`).toMatch(
        new RegExp(`${col}:\\s*true`),
      );
    }
  });

  it("enforces FAILED-row truthful semantics: tsaInputDigestHex must be NULL", () => {
    // Truthful semantics (Issue #8): a FAILED row should NEVER carry an
    // accepted-input digest because the provider did not accept anything.
    expect(SCRIPT).toMatch(
      /tsaInputDigestHex !== null[\s\S]{0,200}truthful semantics violated/,
    );
  });

  it("recognises the ANCHOR_MATERIAL_RECOVERED legitimate intermediate state", () => {
    // PENDING + txid is NOT a failure — it is the legitimate hybrid
    // intermediate state. The diagnostic must reflect that.
    expect(SCRIPT).toMatch(/ANCHOR_MATERIAL_RECOVERED state/);
    expect(SCRIPT).toMatch(/STILL_PENDING state/);
  });
});
