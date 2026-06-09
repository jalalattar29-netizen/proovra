/**
 * Phase IA-TSA-falseFailed — contract tests.
 *
 * Pins the parser fix + repair script + service refactor.
 *
 * The most important pin is the PRODUCTION FIXTURE: an `openssl ts
 * -reply -text` output that mirrors the exact response that confused
 * the legacy parser into writing `tsa_status='FAILED'` for evidence
 * 77406c16-…:
 *
 *   Status info:
 *   Status: Granted.
 *   Status description: Operation Okay
 *   Failure info: unspecified
 *
 *   TST info:
 *   Version: 1
 *   Policy OID: 1.2.40.0.36.1.1.8.1
 *   Hash Algorithm: sha256
 *   Message data:
 *       0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
 *       0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
 *   Serial number: 0x0310230FEA
 *   Time stamp: Jun  9 09:50:34 2026 GMT
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTsaReply,
  tsaFailureCodeToReason,
} from "../src/services/timestamp/parse-tsa-reply.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const PROD_REPLY_GRANTED = `Status info:
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

const PROD_DIGEST =
  "1cb2724aeb57206ab6ad795a2fdb0e97eb1349a8d7b1a0adeb090e76e6d2ddb9";

// ============================================================================
// Parser — happy path + production fixture
// ============================================================================

describe("parseTsaReply — production fixture (evidence 77406c16-…)", () => {
  it("recognizes `Status: Granted.` with trailing period", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST);
    expect(out.granted).toBe(true);
    expect(out.statusKind).toBe("granted");
    expect(out.failureCode).toBeNull();
  });

  it("extracts serial number `0x0310230FEA` from the TSR", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST);
    expect(out.serialNumber).toBe("0x0310230FEA");
  });

  it("parses `Time stamp: Jun  9 09:50:34 2026 GMT` (double-space day)", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST);
    expect(out.genTimeUtc).not.toBeNull();
    const iso = out.genTimeUtc!.toISOString();
    expect(iso.startsWith("2026-06-09T09:50:34")).toBe(true);
  });

  it("extracts the multi-line hex message imprint", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST);
    expect(out.messageImprintHex).toBe(PROD_DIGEST);
  });

  it("confirms the message imprint matches the digest we sent", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST);
    expect(out.imprintMatchesRequest).toBe(true);
  });
});

// ============================================================================
// Parser — status variants
// ============================================================================

describe("parseTsaReply — status variant handling", () => {
  it("`Status: Granted` (no period) → granted", () => {
    const reply = `Status: Granted\nSerial number: 0x1\nTime stamp: Jan  1 00:00:00 2026 GMT\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(true);
    expect(out.statusKind).toBe("granted");
  });

  it("`Status: GrantedWithMods.` → granted_with_mods", () => {
    const reply = `Status: GrantedWithMods.\nSerial number: 0x1\nTime stamp: Jan  1 00:00:00 2026 GMT\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(true);
    expect(out.statusKind).toBe("granted_with_mods");
  });

  it("`Status: Rejected` → not granted with bounded code tsa_response_not_granted", () => {
    const reply = `Status: Rejected\nFailure info: badPolicy\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(false);
    expect(out.statusKind).toBe("other");
    expect(out.failureCode).toBe("tsa_response_not_granted");
    expect(out.failureReason).toBe(
      tsaFailureCodeToReason("tsa_response_not_granted"),
    );
  });

  it("empty input → tsa_response_parse_failed", () => {
    const out = parseTsaReply("");
    expect(out.granted).toBe(false);
    expect(out.failureCode).toBe("tsa_response_parse_failed");
  });

  it("does NOT pick up `Status description:` instead of `Status:`", () => {
    // Pathological response: only `Status description:` (no actual Status line).
    const reply = `Status description: Operation Okay\nSerial number: 0x1\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(false);
    expect(out.statusKind).toBe("other");
  });
});

// ============================================================================
// Parser — validation guards
// ============================================================================

describe("parseTsaReply — validation guards", () => {
  it("Granted but missing serial → tsa_missing_serial_or_generation_time", () => {
    const reply = `Status: Granted.\nTime stamp: Jan  1 00:00:00 2026 GMT\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(false);
    expect(out.failureCode).toBe("tsa_missing_serial_or_generation_time");
  });

  it("Granted but missing genTime → tsa_missing_serial_or_generation_time", () => {
    const reply = `Status: Granted.\nSerial number: 0xABC\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(false);
    expect(out.failureCode).toBe("tsa_missing_serial_or_generation_time");
  });

  it("message imprint mismatch → tsa_message_imprint_mismatch (NEVER granted)", () => {
    const wrongExpected =
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const out = parseTsaReply(PROD_REPLY_GRANTED, wrongExpected);
    expect(out.granted).toBe(false);
    expect(out.failureCode).toBe("tsa_message_imprint_mismatch");
    // The imprint in the TSR was still extracted (for forensic display).
    expect(out.messageImprintHex).toBe(PROD_DIGEST);
    expect(out.imprintMatchesRequest).toBe(false);
  });

  it("no `expectedDigestHex` supplied → imprintMatchesRequest is null (and doesn't fail)", () => {
    const out = parseTsaReply(PROD_REPLY_GRANTED);
    expect(out.imprintMatchesRequest).toBeNull();
    expect(out.granted).toBe(true);
  });
});

// ============================================================================
// Service refactor — invariants preserved
// ============================================================================

describe("Phase IA-TSA-falseFailed — timestamp.service.ts refactor invariants", () => {
  const SERVICE = readSource("../src/services/timestamp.service.ts");

  it("imports parseTsaReply from the dedicated parser module", () => {
    expect(SERVICE).toMatch(
      /import\s*\{\s*parseTsaReply[\s\S]{0,200}from\s*["']\.\/timestamp\/parse-tsa-reply\.js["']/,
    );
  });

  it("TimestampResult carries the bounded failureCode field", () => {
    expect(SERVICE).toMatch(
      /failureCode:\s*TsaReplyFailureCode\s*\|\s*TsaProviderFailureCode\s*\|\s*null/,
    );
  });

  it("preserves token bytes on parser-side failures (never overwrites with empty string in that branch)", () => {
    // The success-or-parser-failed branch reads tokenBuffer and uses
    // it in BOTH the granted return AND the parser-side FAILED return.
    expect(SERVICE).toMatch(
      /const tokenBuffer\s*=\s*await fs\.readFile\(responseFile\);[\s\S]{0,200}const tokenBase64\s*=\s*tokenBuffer\.toString\("base64"\);/,
    );
    // The parser-side FAILED branch persists tokenBase64 (NOT "").
    const idx = SERVICE.indexOf("Parser-side failure paths");
    expect(idx).toBeGreaterThan(-1);
    const block = SERVICE.slice(idx, idx + 1500);
    expect(block).toMatch(/tokenBase64,/);
    expect(block).toMatch(/status:\s*"FAILED"/);
    expect(block).toMatch(/failureCode:\s*parsed\.failureCode/);
  });

  it("subprocess-failure branch (network/timeout/HTTP) writes tokenBase64: \"\" + bounded provider code", () => {
    expect(SERVICE).toMatch(/classifyTsaSubprocessError/);
    const idx = SERVICE.indexOf("Subprocess / network");
    expect(idx).toBeGreaterThan(-1);
    const block = SERVICE.slice(idx, idx + 800);
    expect(block).toMatch(/tokenBase64:\s*""/);
    expect(block).toMatch(/failureCode:\s*classified\.code/);
  });

  it("classifyTsaSubprocessError covers the seven bounded provider codes", () => {
    for (const code of [
      "tsa_provider_quota_exceeded",
      "tsa_provider_access_restricted",
      "tsa_provider_auth_failed",
      "tsa_provider_timeout",
      "tsa_provider_unreachable",
      "tsa_provider_http_error",
      "tsa_unknown_error",
    ]) {
      expect(SERVICE).toMatch(new RegExp(`"${code}"`));
    }
  });
});

// ============================================================================
// Repair script — source-contract safety
// ============================================================================

describe("Phase IA-TSA-falseFailed — repair-tsa-failed-with-token safety contract", () => {
  const SCRIPT = readSource(
    "../src/scripts/repair-tsa-failed-with-token.ts",
  );

  it("defaults to dry-run (apply: false) and only writes when --apply", () => {
    expect(SCRIPT).toMatch(/apply:\s*false/);
    expect(SCRIPT).toMatch(/--apply/);
    expect(SCRIPT).toMatch(/if \(!args\.apply\)/);
  });

  it("uses the SAME parser the runtime service uses", () => {
    expect(SCRIPT).toMatch(
      /import\s*\{\s*parseTsaReply\s*\}\s*from\s*["']\.\.\/services\/timestamp\/parse-tsa-reply\.js["']/,
    );
  });

  it("re-parses the persisted token offline via `openssl ts -reply` (NEVER re-contacts the provider)", () => {
    expect(SCRIPT).toMatch(/"openssl"[\s\S]{0,200}"ts",[\s\S]{0,100}"-reply"/);
    // Repair MUST NOT shell out to curl — that would mean re-contacting
    // the provider.
    expect(SCRIPT).not.toMatch(/"curl"/);
  });

  it("requires GRANTED + serial + genTime + imprint match before any write", () => {
    expect(SCRIPT).toMatch(/if \(!parsed\.granted\)/);
    expect(SCRIPT).toMatch(/parsed\.serialNumber/);
    expect(SCRIPT).toMatch(/parsed\.genTimeUtc/);
    expect(SCRIPT).toMatch(/parsed\.imprintMatchesRequest/);
  });

  it("the update + custody event happen in a single Prisma transaction", () => {
    expect(SCRIPT).toMatch(
      /prisma\.\$transaction\(async \(tx\) => \{[\s\S]{0,800}tx\.evidence\.update[\s\S]{0,800}appendCustodyEventTx/,
    );
  });

  it("custody event payload includes the repair_source forensic marker", () => {
    expect(SCRIPT).toMatch(/repair_source:\s*"tsa_replay_from_token"/);
  });

  it("enqueues report regen with reason `tsa_repaired` AFTER the transaction commits", () => {
    expect(SCRIPT).toMatch(
      /enqueueGenerateReportJob\([\s\S]{0,200}regenerateReason:\s*"tsa_repaired"/,
    );
  });

  it("does NOT call prisma update / delete outside the transaction", () => {
    const sites = SCRIPT.match(/prisma\.evidence\.(update|delete|upsert)/g) ?? [];
    expect(sites).toEqual([]);
    // No raw SQL execute calls.
    expect(SCRIPT).not.toMatch(/prisma\.\$executeRaw/);
  });

  it("bounds --limit to 1..1000 (no whole-DB replay)", () => {
    expect(SCRIPT).toMatch(/n\s*<=\s*0\s*\|\|\s*n\s*>\s*1000/);
  });

  it("scopes the query to the false-FAILED shape exactly", () => {
    expect(SCRIPT).toMatch(/tsaStatus:\s*"FAILED"/);
    expect(SCRIPT).toMatch(/tsaTokenBase64:\s*\{\s*not:\s*null\s*\}/);
    expect(SCRIPT).toMatch(/tsaMessageImprint:\s*\{\s*not:\s*null\s*\}/);
    expect(SCRIPT).toMatch(
      /OR:\s*\[\s*\{\s*tsaSerialNumber:\s*null\s*\},\s*\{\s*tsaGenTimeUtc:\s*null\s*\}\s*\]/,
    );
  });

  it("disconnects Prisma on both success and fatal paths", () => {
    expect(SCRIPT).toMatch(/prisma\.\$disconnect\(\)/);
    expect(SCRIPT).toMatch(
      /main\(\)\.catch\(async \(err\) => \{[\s\S]{0,400}\$disconnect/,
    );
  });
});
