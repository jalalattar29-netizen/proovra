/**
 * Phase IA-digest-policy-hard-invariant — the contract:
 *
 *   "If OpenSSL says Status: Granted
 *    and parsed messageImprint equals the digest used to create the
 *    TSA query, then persist STAMPED — not FAILED."
 *
 * Plus, ALWAYS persist:
 *   - tsa_input_digest_hex = digestHex used for openssl ts -query
 *   - tsa_input_kind       = FILE_SHA256 | CANONICAL_PACKAGE_SHA256
 *   - tsa_message_imprint  = parsed imprint
 *   - tsa_serial_number    = parsed serial (may be null on parser miss)
 *   - tsa_gen_time_utc     = parsed time (may be null on parser miss)
 *   - tsa_failure_reason   = null on STAMPED
 *
 * These tests fail if a future refactor re-introduces the old failure
 * mode where a Granted token with a matching imprint was downgraded to
 * FAILED because some optional field (serial, genTime, "Message data"
 * dump) failed to parse.
 *
 * The hard invariant is enforced at THREE layers:
 *   1. The parser (`parseTsaReply`) — returns `granted: true` when
 *      Status: Granted + imprint matches, regardless of other fields.
 *   2. The service (`createEvidenceTimestamp`) — STAMPED branch carries
 *      whatever the parser provided (including nulls for serial / genTime).
 *   3. The persistence (`evidence-complete.service.ts`) — writes
 *      tsa_input_digest_hex + tsa_input_kind ALWAYS, derived from what
 *      we sent to openssl ts -query (NOT gated on STAMPED).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseTsaReply } from "../src/services/timestamp/parse-tsa-reply.js";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const REQUEST_DIGEST =
  "1cb2724aeb57206ab6ad795a2fdb0e97eb1349a8d7b1a0adeb090e76e6d2ddb9";

const TSR_GRANTED_FULL = `Status info:
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

const TSR_GRANTED_NO_SERIAL = `Status info:
Status: Granted.

TST info:
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Time stamp: Jun  9 09:50:34 2026 GMT
`;

const TSR_GRANTED_NO_GEN_TIME = `Status info:
Status: Granted.

TST info:
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Serial number: 0x0310230FEA
`;

const TSR_GRANTED_NO_SERIAL_NO_GEN_TIME = `Status info:
Status: Granted.

TST info:
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
`;

const TSR_REJECTED = `Status info:
Status: Rejected
Failure info: badPolicy
`;

const TSR_GRANTED_IMPRINT_MISMATCH = `Status info:
Status: Granted.

TST info:
Hash Algorithm: sha256
Message data:
    0000 - ff ff ff ff ff ff ff ff-ff ff ff ff ff ff ff ff
    0010 - ff ff ff ff ff ff ff ff-ff ff ff ff ff ff ff ff
Serial number: 0x0310230FEA
Time stamp: Jun  9 09:50:34 2026 GMT
`;

// ============================================================================
// THE HARD INVARIANT — top of the file because it's the contract.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — Granted + imprint match MUST NOT FAIL", () => {
  it("fully-parsed Granted + matching imprint → granted: true (baseline sanity)", () => {
    const r = parseTsaReply(TSR_GRANTED_FULL, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("Granted + matching imprint with MISSING SERIAL → granted: true + warning (never FAILED)", () => {
    const r = parseTsaReply(TSR_GRANTED_NO_SERIAL, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.serialNumber).toBeNull();
    expect(r.warnings).toContain("tsa_serial_number_unparsed");
  });

  it("Status: Granted. with trailing descriptive text still counts as granted", () => {
    const reply = `Status info:
Status: Granted. This token was accepted.

TST info:
Version: 1
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Serial number: 0x0310230FEA
Time stamp: Jun  9 09:50:34 2026 GMT
`;
    const r = parseTsaReply(reply, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.serialNumber).toBe("0x0310230FEA");
  });

  it("Status: GrantedWithMods. with trailing descriptive text still counts as granted_with_mods", () => {
    const reply = `Status info:
Status: GrantedWithMods. Additional details.

TST info:
Version: 1
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Serial number: 0x0310230FEA
Time stamp: Jun  9 09:50:34 2026 GMT
`;
    const r = parseTsaReply(reply, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.statusKind).toBe("granted_with_mods");
  });

  it("Granted + matching imprint with MISSING GEN TIME → granted: true + warning (never FAILED)", () => {
    const r = parseTsaReply(TSR_GRANTED_NO_GEN_TIME, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.genTimeUtc).toBeNull();
    expect(r.warnings).toContain("tsa_generation_time_unparsed");
  });

  it("Granted + matching imprint with MISSING BOTH serial AND genTime → granted: true + 2 warnings", () => {
    const r = parseTsaReply(TSR_GRANTED_NO_SERIAL_NO_GEN_TIME, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.failureReason).toBeNull();
    expect(r.warnings).toContain("tsa_serial_number_unparsed");
    expect(r.warnings).toContain("tsa_generation_time_unparsed");
  });
});

// ============================================================================
// Counter-cases — failures that legitimately remain failures.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — legitimate FAILED paths still fail", () => {
  it("Status: Rejected → granted: false + tsa_response_not_granted", () => {
    const r = parseTsaReply(TSR_REJECTED, REQUEST_DIGEST);
    expect(r.granted).toBe(false);
    expect(r.failureCode).toBe("tsa_response_not_granted");
  });

  it("Granted but imprint disagrees with request digest → granted: false + tsa_message_imprint_mismatch", () => {
    const r = parseTsaReply(TSR_GRANTED_IMPRINT_MISMATCH, REQUEST_DIGEST);
    expect(r.granted).toBe(false);
    expect(r.failureCode).toBe("tsa_message_imprint_mismatch");
  });

  it("empty input → granted: false + tsa_response_parse_failed", () => {
    const r = parseTsaReply("", REQUEST_DIGEST);
    expect(r.granted).toBe(false);
    expect(r.failureCode).toBe("tsa_response_parse_failed");
  });
});

// ============================================================================
// The bounded code surface — invariant: the FAILED-code enum NO LONGER
// includes the soft "missing serial/genTime" code.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — failure-code surface", () => {
  const PARSER = readSource("../src/services/timestamp/parse-tsa-reply.ts");

  it("TsaReplyFailureCode no longer includes tsa_missing_serial_or_generation_time", () => {
    // The code became a WARNING (TsaReplyWarningCode), not a failure.
    // A future refactor that re-adds it as a failure would re-introduce
    // the original incident.
    expect(PARSER).not.toMatch(
      /TsaReplyFailureCode[\s\S]{0,400}"tsa_missing_serial_or_generation_time"/,
    );
  });

  it("TsaReplyWarningCode enumerates the bounded soft issues", () => {
    expect(PARSER).toMatch(
      /export type TsaReplyWarningCode\s*=\s*[\s\S]{0,500}"tsa_serial_number_unparsed"[\s\S]{0,500}"tsa_generation_time_unparsed"[\s\S]{0,500}"tsa_message_imprint_not_present_in_reply"/,
    );
  });
});

// ============================================================================
// Service layer — STAMPED branch carries the parsed (possibly null) fields
// + warnings.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — service STAMPED branch contract", () => {
  const SERVICE = readSource("../src/services/timestamp.service.ts");

  it("TimestampResult exposes the bounded warnings field", () => {
    expect(SERVICE).toMatch(/warnings:\s*TsaReplyWarningCode\[\]/);
  });

  it("STAMPED return propagates parsed.warnings", () => {
    expect(SERVICE).toMatch(
      /if \(parsed\.granted\)\s*\{[\s\S]{0,1000}status:\s*"STAMPED"[\s\S]{0,400}warnings:\s*parsed\.warnings/,
    );
  });

  it("STAMPED return writes whatever serial/genTime the parser produced (may be null)", () => {
    expect(SERVICE).toMatch(
      /if \(parsed\.granted\)\s*\{[\s\S]{0,1000}serialNumber:\s*parsed\.serialNumber[\s\S]{0,200}genTimeUtc:\s*parsed\.genTimeUtc/,
    );
  });

  it("STAMPED return sets failureReason: null and failureCode: null", () => {
    expect(SERVICE).toMatch(
      /if \(parsed\.granted\)\s*\{[\s\S]{0,1000}status:\s*"STAMPED"[\s\S]{0,200}failureReason:\s*null[\s\S]{0,100}failureCode:\s*null/,
    );
  });
});

// ============================================================================
// Persistence layer — tsa_input_digest_hex + tsa_input_kind ALWAYS written
// from the request shape, regardless of STAMPED/FAILED.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — persistence ALWAYS records request digest + kind", () => {
  const EVIDENCE_COMPLETE = readSource(
    "../src/services/evidence-complete.service.ts",
  );

  it("tsa_input_digest_hex is sourced from tsaResult.messageImprint (= request digest), NOT gated on STAMPED", () => {
    // The new persistence writes the column whenever a TSA request was
    // made (tsaResult is non-null) — STAMPED or FAILED. The previous
    // gate `tsaResult?.status === "STAMPED"` made FAILED rows lose the
    // request-digest context, which complicated triage.
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaInputDigestHex:\s*tsaResult\s*\?\s*tsaResult\.messageImprint\s*:\s*null/,
    );
    // The OLD gated pattern MUST NOT be present in the finalize block.
    expect(EVIDENCE_COMPLETE).not.toMatch(
      /tsaInputDigestHex:[\s\S]{0,100}tsaResult\?\.status\s*===\s*"STAMPED"\s*\?\s*tsaResult\.messageImprint/,
    );
  });

  it("tsa_input_kind is written whenever a TSA request was made (NOT gated on STAMPED)", () => {
    expect(EVIDENCE_COMPLETE).toMatch(
      /tsaInputKind:\s*tsaResult\s*\?\s*tsaInputKind\s*:\s*null/,
    );
    // The OLD gated pattern MUST NOT be present.
    expect(EVIDENCE_COMPLETE).not.toMatch(
      /tsaInputKind:\s*tsaResult\?\.status\s*===\s*"STAMPED"\s*\?\s*tsaInputKind\s*:\s*null/,
    );
  });

  it("SIGNATURE_APPLIED custody event mirrors the same always-record contract", () => {
    // The signature event's TSA fields are the same shape as the finalize
    // data — both need to use the un-gated assignment.
    const sigIdx = EVIDENCE_COMPLETE.indexOf("SIGNATURE_APPLIED");
    expect(sigIdx).toBeGreaterThan(-1);
    const block = EVIDENCE_COMPLETE.slice(sigIdx, sigIdx + 2000);
    expect(block).toMatch(
      /tsaInputDigestHex:\s*tsaResult\s*\?\s*tsaResult\.messageImprint\s*:\s*null/,
    );
    expect(block).toMatch(/tsaInputKind:\s*tsaResult\s*\?\s*tsaInputKind\s*:\s*null/);
  });

  it("TIMESTAMP_APPLIED / TIMESTAMP_FAILED custody event includes tsaParseWarnings", () => {
    expect(EVIDENCE_COMPLETE).toMatch(/tsaParseWarnings:\s*tsaResult\.warnings/);
  });
});

// ============================================================================
// Production-fixture sanity — the exact incident that motivated this phase.
// ============================================================================

describe("Phase IA-digest-policy-hard-invariant — production incident replay", () => {
  it("evidence 77406c16 — Status: Granted. + Jun  9 + multi-line imprint stays STAMPED", () => {
    // This is the exact TSR text that the legacy parser collapsed into
    // a FAILED row with no recovery path. Under the new contract it
    // MUST end up as STAMPED with full receipt material.
    const r = parseTsaReply(TSR_GRANTED_FULL, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.serialNumber).toBe("0x0310230FEA");
    expect(r.genTimeUtc).not.toBeNull();
    expect(r.genTimeUtc!.toISOString().startsWith("2026-06-09T09:50:34")).toBe(true);
    expect(r.imprintMatchesRequest).toBe(true);
    expect(r.failureCode).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it("a malformed Time stamp line in a Granted TSR stays STAMPED with a warning", () => {
    // Hypothetical regression: provider emits a date format our parser
    // doesn't know. Pre-fix this collapsed to FAILED. Now: STAMPED.
    const tsr = `Status info:
Status: Granted.

TST info:
Hash Algorithm: sha256
Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Serial number: 0x0310230FEA
Time stamp: ???-unparseable-format-???
`;
    const r = parseTsaReply(tsr, REQUEST_DIGEST);
    expect(r.granted).toBe(true);
    expect(r.serialNumber).toBe("0x0310230FEA");
    expect(r.genTimeUtc).toBeNull();
    expect(r.warnings).toContain("tsa_generation_time_unparsed");
  });
});
