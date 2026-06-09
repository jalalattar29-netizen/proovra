/**
 * Phase IA-forward-path-TSA — deterministic forward-path test.
 *
 * Pins the NEW EVIDENCE TSA forward path so it cannot regress without
 * tripping these assertions:
 *
 *   1. The finalize site in `evidence-complete.service.ts` calls the
 *      `createEvidenceTimestamp` service with the file SHA-256 digest.
 *   2. The service it calls is the bounded-parser one (parseTsaReply
 *      lives in `services/timestamp/parse-tsa-reply.ts` and is imported
 *      by `timestamp.service.ts`).
 *   3. The finalize-data block writes every TSA field that the truth
 *      surface (report / verify) reads — including `tsaTokenBase64`,
 *      `tsaSerialNumber`, `tsaGenTimeUtc`, `tsaStatus`, and the truth-
 *      gated `tsaInputDigestHex` / `tsaInputKind`.
 *   4. A TIMESTAMP_APPLIED custody event is emitted on STAMPED and a
 *      TIMESTAMP_FAILED custody event is emitted on FAILED — both in
 *      the SAME prisma.$transaction as the finalize update so the
 *      truth row and the chain stay in lock-step.
 *   5. The parser end-to-end recognises a real Granted reply.
 *
 * Source-contract checks (regex over the actual file text) instead of
 * mocking Prisma/openssl so the test stays meaningful even if the
 * runtime drift away from a specific mock. The trade-off: edits that
 * keep the contract but reshape syntax may require updating the
 * patterns.
 *
 * NOTE: this test runs without spinning up a TSA provider — the
 * production parser fixture from phase-ia-tsa-false-failed already
 * covers the end-to-end Granted parse. This test pins the FORWARD path
 * (callsite → service → persistence → custody event) so a refactor
 * cannot accidentally bypass the bounded parser or drop a custody
 * event.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTsaReply } from "../src/services/timestamp/parse-tsa-reply.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// ============================================================================
// 1. Finalize callsite — evidence-complete.service.ts
// ============================================================================

describe("Phase IA-forward-path-TSA — finalize callsite contract", () => {
  const EVIDENCE_COMPLETE = readSource(
    "../src/services/evidence-complete.service.ts",
  );

  it("imports createEvidenceTimestamp from timestamp.service.ts", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /import\s*\{\s*createEvidenceTimestamp\s*\}\s*from\s*["']\.\/timestamp\.service\.js["']/,
    );
  });

  it("calls createEvidenceTimestamp with the file SHA-256 digest (NOT a placeholder)", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /createEvidenceTimestamp\(\{\s*digestHex:\s*fileSha256\s*,?\s*\}\)/,
    );
  });

  it("finalize-data writes every TSA field the truth surface reads", () => {
    // These are the columns the report/verify code paths read to build
    // a TSA receipt. Missing any of them means the truth surface would
    // silently drop a piece of receipt material on a STAMPED row.
    for (const field of [
      "tsaProvider",
      "tsaUrl",
      "tsaSerialNumber",
      "tsaGenTimeUtc",
      "tsaTokenBase64",
      "tsaMessageImprint",
      "tsaHashAlgorithm",
      "tsaStatus",
      "tsaFailureReason",
    ]) {
      expect(
        EVIDENCE_COMPLETE,
        `finalizeData should write ${field} so report/verify see it`,
      ).toMatch(new RegExp(`${field}:\\s*tsaResult\\??`));
    }
  });

  it("tsaInputDigestHex ALWAYS records the request digest (Phase IA-digest-policy-hard-invariant)", () => {
    // Issue #8's intent (don't fall back to fileSha256 when TSA never
    // ran) is preserved: when tsaResult is null (TSA disabled) the
    // column stays null. But when a TSA REQUEST was made — STAMPED or
    // FAILED — we record what we asked it to certify, so triage can
    // see the digest target.
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaInputDigestHex:\s*tsaResult\s*\?\s*tsaResult\.messageImprint\s*:\s*null/,
    );
  });

  it("tsaInputKind ALWAYS records the request shape (Phase IA-digest-policy-hard-invariant)", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaInputKind:\s*tsaResult\s*\?\s*tsaInputKind\s*:\s*null/,
    );
  });

  it("emits TIMESTAMP_APPLIED on STAMPED and TIMESTAMP_FAILED on FAILED", () => {
    // Both arms must be emitted in the SAME conditional — never branch
    // away and lose the chain entry.
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaResult\.status\s*===\s*"STAMPED"[\s\S]{0,200}CustodyEventType\.TIMESTAMP_APPLIED[\s\S]{0,400}CustodyEventType\.TIMESTAMP_FAILED/,
    );
  });

  it("custody event runs inside the same transaction as the finalize update", () => {
    // The custody event for the TSA outcome MUST be emitted via the
    // same `tx` as the finalize update — never via a top-level
    // appendCustodyEvent call that would not be rolled back if the
    // transaction failed.
    const tsaCustodyIdx = EVIDENCE_COMPLETE.indexOf(
      "if (tsaResult) {",
    );
    expect(tsaCustodyIdx).toBeGreaterThan(-1);
    const block = EVIDENCE_COMPLETE.slice(tsaCustodyIdx, tsaCustodyIdx + 1500);
    expect(block).toMatch(/appendCustodyEventTx\(tx,/);
  });
});

// ============================================================================
// 2. Service — uses the bounded parser
// ============================================================================

describe("Phase IA-forward-path-TSA — service uses the bounded parser", () => {
  const SERVICE = readSource("../src/services/timestamp.service.ts");

  it("createEvidenceTimestamp is exported with the documented shape", () => {
    expect(SERVICE).toMatch(
      /export\s+async\s+function\s+createEvidenceTimestamp\(/,
    );
  });

  it("delegates the reply parse to parseTsaReply (bounded module)", () => {
    expect(SERVICE).toMatch(
      /parseTsaReply\(stdout,\s*digestHex\)/,
    );
  });

  it("returns status: \"STAMPED\" on parsed.granted", () => {
    expect(SERVICE).toMatch(/if \(parsed\.granted\)[\s\S]{0,1500}status:\s*"STAMPED"/);
  });

  it("returns status: \"FAILED\" + preserved tokenBase64 + bounded code on parser-side fail", () => {
    const idx = SERVICE.indexOf("Parser-side failure paths");
    expect(idx).toBeGreaterThan(-1);
    const block = SERVICE.slice(idx, idx + 1500);
    expect(block).toMatch(/status:\s*"FAILED"/);
    expect(block).toMatch(/tokenBase64,/);
    expect(block).toMatch(/failureCode:\s*parsed\.failureCode/);
  });

  it("subprocess error path writes empty token + bounded provider code", () => {
    const idx = SERVICE.indexOf("Subprocess / network");
    expect(idx).toBeGreaterThan(-1);
    const block = SERVICE.slice(idx, idx + 800);
    expect(block).toMatch(/tokenBase64:\s*""/);
    expect(block).toMatch(/failureCode:\s*classified\.code/);
  });
});

// ============================================================================
// 3. End-to-end parser — proves Granted replies stamp
// ============================================================================

describe("Phase IA-forward-path-TSA — Granted reply produces STAMPED material", () => {
  it("a real Granted TSR produces serial + genTime + matching imprint", () => {
    const reply = `Status info:
Status: Granted.
Status description: Operation Okay
Failure info: unspecified

TST info:
Version: 1
Policy OID: 1.2.40.0.36.1.1.8.1
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Serial number: 0x0310230FEA
Time stamp: Jun  9 09:50:34 2026 GMT
`;
    const digest =
      "1cb2724aeb57206ab6ad795a2fdb0e97eb1349a8d7b1a0adeb090e76e6d2ddb9";

    const out = parseTsaReply(reply, digest);
    expect(out.granted).toBe(true);
    expect(out.failureCode).toBeNull();
    expect(out.serialNumber).toBe("0x0310230FEA");
    expect(out.genTimeUtc).not.toBeNull();
    expect(out.imprintMatchesRequest).toBe(true);

    // The persistence layer maps these directly to the truth columns
    // it writes: serial, genTime, imprint. Pin the shape so a refactor
    // of the parser API would have to update this test (and would not
    // silently drop a field).
    const persistShape = {
      serialNumber: out.serialNumber,
      genTimeUtc: out.genTimeUtc?.toISOString() ?? null,
      messageImprintHex: out.messageImprintHex,
    };
    expect(persistShape.serialNumber).toBe("0x0310230FEA");
    expect(persistShape.genTimeUtc).not.toBeNull();
    expect(persistShape.messageImprintHex).toBe(digest);
  });
});
