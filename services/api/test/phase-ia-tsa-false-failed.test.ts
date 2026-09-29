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
import { betweenMarkers } from "../../../scripts/source-contract/index.mjs";

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

/** The imprint dump every granted reply must carry (ET-TSA-02). */
const MSG = `Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
`;

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
    const reply = `Status: Granted\n${MSG}Serial number: 0x1\nTime stamp: Jan  1 00:00:00 2026 GMT\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(true);
    expect(out.statusKind).toBe("granted");
  });

  it("`Status: GrantedWithMods.` → granted_with_mods", () => {
    const reply = `Status: GrantedWithMods.\n${MSG}Serial number: 0x1\nTime stamp: Jan  1 00:00:00 2026 GMT\n`;
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
  it("Granted but missing serial → STAMPED + tsa_serial_number_unparsed warning (Phase IA-digest-policy-hard-invariant)", () => {
    // Previously this produced a FAILED row with failureCode
    // `tsa_missing_serial_or_generation_time`. Under the new hard
    // invariant a Granted token whose imprint matches the request
    // MUST NOT be FAILED just because an optional column failed to
    // parse — the token bytes are authoritative.
    const reply = `Status: Granted.\n${MSG}Time stamp: Jan  1 00:00:00 2026 GMT\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(true);
    expect(out.failureCode).toBeNull();
    expect(out.serialNumber).toBeNull();
    expect(out.warnings).toContain("tsa_serial_number_unparsed");
  });

  it("Granted but missing genTime → STAMPED + tsa_generation_time_unparsed warning", () => {
    const reply = `Status: Granted.\n${MSG}Serial number: 0xABC\n`;
    const out = parseTsaReply(reply);
    expect(out.granted).toBe(true);
    expect(out.failureCode).toBeNull();
    expect(out.genTimeUtc).toBeNull();
    expect(out.warnings).toContain("tsa_generation_time_unparsed");
  });

  it("ET-TSA-02: a granted reply with NO readable imprint is NOT granted (parse failure), never STAMPED", () => {
    const out = parseTsaReply(`Status: Granted.\nSerial number: 0x1\nTime stamp: Jan  1 00:00:00 2026 GMT\n`, PROD_DIGEST);
    expect(out.granted).toBe(false);
    expect(out.failureCode).toBe("tsa_response_parse_failed");
    expect(out.warnings).toContain("tsa_message_imprint_not_present_in_reply");
  });

  it("extracts the policy OID the token was issued under", () => {
    expect(parseTsaReply(PROD_REPLY_GRANTED, PROD_DIGEST).policyOid).toBe("1.2.40.0.36.1.1.8.1");
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

  it("TimestampResult carries the bounded failureCode field (parser | provider | validation | token missing)", () => {
    expect(SERVICE).toMatch(/failureCode:\s*TimestampFailureCode\s*\|\s*null/);
    expect(SERVICE).toMatch(
      /export type TimestampFailureCode =\s*\|\s*TsaReplyFailureCode\s*\|\s*TsaProviderFailureCode\s*\|\s*TsaValidationFailureCode\s*\|\s*"tsa_token_missing";/,
    );
  });

  it("ET-TSA-01: STAMPED is returned only after validateTsaToken accepts the token", () => {
    const block = betweenMarkers(SERVICE, "3. Validate the token", "} finally {");
    expect(block).toMatch(/const validation = await validateTsaToken\(/);
    expect(block).toMatch(/if \(!validation\.ok\) return failed\(validation\.code, validation\.reason, fromReply\);[\s\S]*status: "STAMPED"/);
    expect((SERVICE.match(/status: "STAMPED",/g) ?? []).length).toBe(1);
  });

  it("preserves token bytes on every failure after the reply arrived (parser, token-missing, validation)", () => {
    expect(SERVICE).toMatch(/const tokenBase64 = \(await fs\.readFile\(responseFile\)\)\.toString\("base64"\);/);
    const block = betweenMarkers(SERVICE, "The reply bytes are KEPT", "} finally {");
    expect(block).toMatch(/failed\("tsa_token_missing",[\s\S]{0,200}\{ tokenBase64 \}\)/);
    expect(block).toMatch(/const fromReply = \{\s*tokenBase64,/);
    expect(block).toMatch(/parsed\.failureCode \?\? "tsa_response_parse_failed",[\s\S]{0,200}fromReply,/);
  });

  it("transport-failure branch (network/timeout/HTTP) writes no token + a bounded provider code", () => {
    expect(SERVICE).toMatch(/classifyTsaSubprocessError/);
    const block = betweenMarkers(SERVICE, "1. Transport.", "The reply bytes are KEPT");
    expect(block).toMatch(/return failed\(classified\.code, classified\.reason\);/);
    // failed() defaults the token to "" unless the caller supplies the reply.
    expect(SERVICE).toMatch(/tokenBase64: "",\s*messageImprint: null,/);
  });

  it("ET-TSA-07: credentials travel in a curl config file, never in argv", () => {
    expect(SERVICE).toMatch(/writeCurlCredentialConfig\(curlConfig, tsaUsername, tsaPassword\)/);
    expect(SERVICE).toMatch(/"-K",\s*curlConfig,/);
    expect(SERVICE).not.toMatch(/"-u"/);
    expect(SERVICE).not.toContain("${tsaUsername}:${tsaPassword}");
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

  const KEPT = readSource("../src/services/timestamp/kept-token-validation.ts");

  it("ET-TSA-09: uses the SAME parser AND the SAME validator as issuance", () => {
    expect(SCRIPT).toMatch(
      /import\s*\{\s*evaluateKeptTsaToken\s*\}\s*from\s*["']\.\.\/services\/timestamp\/kept-token-validation\.js["']/,
    );
    expect(KEPT).toContain('import { parseTsaReply } from "./parse-tsa-reply.js";');
    expect(KEPT).toContain('import { validateTsaToken } from "./validate-tsa-token.js";');
  });

  it("re-parses the kept token offline via `openssl ts -reply` (NEVER re-contacts the provider)", () => {
    expect(KEPT).toContain('"openssl", ["ts", "-reply", "-in", responseFile, "-text"]');
    // Neither may shell out to curl — that would mean re-contacting the provider.
    expect(SCRIPT).not.toMatch(/"curl"/);
    expect(KEPT).not.toMatch(/"curl"/);
  });

  it("ET-TSA-09: requires GRANTED + serial + genTime + imprint + a validated token before any write", () => {
    expect(KEPT).toContain("if (!parsed.granted)");
    expect(KEPT).toContain("if (!parsed.serialNumber || !parsed.genTimeUtc || !parsed.messageImprintHex)");
    expect(KEPT).toContain("const validation = await validateTsaToken(");
    expect(KEPT).toContain("if (!validation.ok) return refuse(");
    expect(SCRIPT).toContain("if (!decision.ok) {");
  });

  it("the update + custody event happen in a single Prisma transaction", () => {
    expect(SCRIPT).toMatch(
      // WINDOW WIDENED — Attention Architecture closure pass (2026-08-22).
      // The transaction is unchanged and still asserted in full; the update
      // simply grew a field. `integrityCorrelationId` records the identity of
      // this deliberate multi-record execution so genuinely correlated
      // failures can form a parent, and the extra lines pushed
      // `appendCustodyEventTx` past the old 800-char window.
      /prisma\.\$transaction\(async \(tx\) => \{[\s\S]{0,1600}tx\.evidence\.update[\s\S]{0,1600}appendCustodyEventTx/,
    );
  });

  it("custody event payload includes the repair_source forensic marker", () => {
    expect(SCRIPT).toMatch(/repair_source:\s*"tsa_kept_token_validated"/);
  });

  it("re-issues NO report — the repair is a custody fact, not a new version (Decision C, 2026-09-29)", () => {
    // SUPERSEDED: this used to pin a forced regeneration request with reason
    // `tsa_repaired`. Issued reports keep what they said when issued; the
    // corrected timestamp reading is recorded in custody and shown by Verify,
    // and an updated report is an explicit, reasoned user action.
    expect(SCRIPT).not.toMatch(/requestReportGeneration\(|forceRegenerate|tsa_repaired/);
    expect(SCRIPT).toMatch(/NO REPORT IS RE-ISSUED/);
  });

  it("the correction is compare-and-set on the evaluated, still-unvalidated state", () => {
    expect(SCRIPT).toContain("where: { id: row.id, tsaStatus: row.tsaStatus, tsaValidatedAtUtc: null }");
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

  it("scopes the query to kept tokens on FAILED rows and unvalidated STAMPED rows exactly", () => {
    expect(SCRIPT).toMatch(/tsaTokenBase64:\s*\{\s*not:\s*null\s*\}/);
    expect(SCRIPT).toContain('OR: [{ tsaStatus: "FAILED" }, { tsaStatus: "STAMPED", tsaValidatedAtUtc: null }]');
  });

  it("disconnects Prisma on both success and fatal paths", () => {
    expect(SCRIPT).toMatch(/prisma\.\$disconnect\(\)/);
    expect(SCRIPT).toMatch(
      /main\(\)\.catch\(async \(err\) => \{[\s\S]{0,400}\$disconnect/,
    );
  });
});
