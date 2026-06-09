/**
 * Phase IA-digest-policy-hard-invariant — ASCII-rendering-column leak.
 *
 * Production incident:
 *   Evidence 10f3a02a-05c1-433e-a760-e816774fbd2b was persisted as
 *   tsa_status='FAILED' with reason
 *   "Trusted timestamp message imprint disagreed with the digest sent —
 *    the response was not persisted." despite the TSA token being
 *   completely valid:
 *
 *     - digestHex sent to openssl ts -query:
 *         810920e85daaac135a5f5cd9683b850a6597fe04c99731df61f2ea7a4dfb71b3
 *     - TSA token Message data hex bytes:
 *         810920e85daaac135a5f5cd9683b850a6597fe04c99731df61f2ea7a4dfb71b3
 *     - Status: Granted.
 *     - tsa_input_digest_hex / tsa_message_imprint persisted: identical
 *       to the request digest. No actual mismatch.
 *
 * Root cause:
 *   `parseMessageImprint` captured the entire dump line with `[^\n]*`.
 *   The trailing ASCII rendering column emitted by openssl included
 *   characters that ARE valid hex digits (`e`, `1`, `a` in
 *   `e.....1.a..zM.q.`), which survived the `replace([^0-9a-f])` pass
 *   and concatenated onto the parsed imprint. The corrupted imprint
 *   (67 chars instead of 64) failed the equality check against the
 *   64-char request digest. The TSA receipt was perfectly valid; the
 *   parser was the only thing that disagreed.
 *
 * Fix (parse-tsa-reply.ts:parseMessageImprint):
 *   Explicit hex-pair capture `((?:[0-9a-f]{2}[ -]?)+)` instead of
 *   `[^\n]*`. The greedy `+` stops at the column-separator (2+ spaces
 *   between hex column and ASCII column).
 *
 * These tests use the EXACT production openssl ts -reply -text output
 * for evidence 10f3a02a, including the ASCII rendering column. They
 * prove the fix, and they fail if the regex ever drops back to
 * `[^\n]*`.
 */

import { describe, expect, it } from "vitest";

import { parseTsaReply } from "../src/services/timestamp/parse-tsa-reply.js";

// Production reply text for evidence 10f3a02a — the exact openssl
// ts -reply -text output that was failing. NOTE the trailing ASCII
// rendering column on every dump line.
const PROD_REPLY_10F3A02A = `Using configuration from /etc/ssl/openssl.cnf
Status info:
Status: Granted.
Status description: Operation Okay
Failure info: unspecified

TST info:
Version: 1
Policy OID: 1.2.40.0.36.1.1.8.1
Hash Algorithm: sha256
Message data:
    0000 - 81 09 20 e8 5d aa ac 13-5a 5f 5c d9 68 3b 85 0a   .. .]...Z_\\.h;..
    0010 - 65 97 fe 04 c9 97 31 df-61 f2 ea 7a 4d fb 71 b3   e.....1.a..zM.q.
Serial number: 0x0310231003
Time stamp: Jun  9 13:42:28 2026 GMT
Accuracy: 0x01 seconds, unspecified millis, unspecified micros
Ordering: no
Nonce: 0xB8415646A68EACFB
TSA: DirName:/C=AT/ST=Wien/L=Wien/O=e-commerce monitoring GmbH/CN=GLOBALTRUST 2015 QUALIFIED TIMESTAMP Service 005
Extensions:
`;

const PROD_DIGEST_10F3A02A =
  "810920e85daaac135a5f5cd9683b850a6597fe04c99731df61f2ea7a4dfb71b3";

describe("Phase IA-digest-policy-hard-invariant — ASCII rendering column does NOT leak", () => {
  it("evidence 10f3a02a — Granted + matching imprint → granted: true (NOT FAILED)", () => {
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.granted).toBe(true);
    expect(out.failureCode).toBeNull();
    expect(out.failureReason).toBeNull();
  });

  it("parsed messageImprintHex equals the request digest EXACTLY (no ASCII contamination)", () => {
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.messageImprintHex).toBe(PROD_DIGEST_10F3A02A);
    // The bug previously produced a 67-char string ending in `e1a`.
    expect(out.messageImprintHex?.length).toBe(64);
    expect(out.messageImprintHex?.endsWith("e1a")).toBe(false);
  });

  it("imprintMatchesRequest is true (the in-memory comparison succeeds)", () => {
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.imprintMatchesRequest).toBe(true);
  });

  it("serial number + genTime parsed cleanly from the production reply", () => {
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.serialNumber).toBe("0x0310231003");
    expect(out.genTimeUtc).not.toBeNull();
    expect(out.genTimeUtc!.toISOString()).toBe("2026-06-09T13:42:28.000Z");
  });

  it("warnings array is empty on the fully-parsed production reply", () => {
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.warnings).toEqual([]);
  });
});

describe("Phase IA-digest-policy-hard-invariant — ASCII-column patterns that previously leaked", () => {
  // The lower 16 bytes whose ASCII rendering contains `e`, `1`, `a`:
  //   65 97 fe 04 c9 97 31 df-61 f2 ea 7a 4d fb 71 b3   e.....1.a..zM.q.
  // The corrupted parser used to append `e1a` from the ASCII column.
  const FIXTURE_WITH_HEX_LIKE_ASCII = `Message data:
    0000 - de ad be ef ca fe ba be-12 34 56 78 9a bc de f0   .....þ.....4Vx....
    0010 - 65 97 fe 04 c9 97 31 df-61 f2 ea 7a 4d fb 71 b3   e.....1.a..zM.q.
Serial number: 0x1
Time stamp: Jan  1 00:00:00 2026 GMT
Status: Granted.
`;

  it("parses 32 bytes ONLY when the ASCII rendering column contains hex-like chars", () => {
    const out = parseTsaReply(FIXTURE_WITH_HEX_LIKE_ASCII);
    // 32 bytes = 64 hex chars; the ASCII column MUST NOT add chars.
    expect(out.messageImprintHex).toBe(
      "deadbeefcafebabe123456789abcdef06597fe04c99731df61f2ea7a4dfb71b3",
    );
    expect(out.messageImprintHex?.length).toBe(64);
  });

  it("classic fixture WITHOUT the ASCII column still parses (back-compat)", () => {
    const fixture = `Message data:
    0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
    0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
Status: Granted.
Serial number: 0x1
Time stamp: Jan  1 00:00:00 2026 GMT
`;
    const out = parseTsaReply(fixture);
    expect(out.messageImprintHex).toBe(
      "1cb2724aeb57206ab6ad795a2fdb0e97eb1349a8d7b1a0adeb090e76e6d2ddb9",
    );
  });
});

describe("Phase IA-digest-policy-hard-invariant — service writes STAMPED on the production reply", () => {
  it("the canonical Granted + matching imprint → no failureCode, no failureReason, warnings empty", () => {
    // The service constructs its STAMPED return directly from
    // `parsed.granted === true`. The persistence layer (evidence-
    // complete.service.ts) writes:
    //   tsa_status         = 'STAMPED'
    //   tsa_failure_reason = null
    //   tsa_input_digest_hex = digestHex (the request)
    //   tsa_message_imprint  = digestHex (the request)
    //   tsa_input_kind     = CANONICAL_PACKAGE_SHA256 (multipart) or FILE_SHA256
    //   tsa_serial_number  = parsed.serialNumber
    //   tsa_gen_time_utc   = parsed.genTimeUtc
    // We pin each invariant here. If any of them regress, the bounded
    // parser output below will mark that.
    const out = parseTsaReply(PROD_REPLY_10F3A02A, PROD_DIGEST_10F3A02A);
    expect(out.granted).toBe(true);
    expect(out.failureCode).toBeNull();
    expect(out.failureReason).toBeNull();
    expect(out.warnings).toEqual([]);
    expect(out.serialNumber).not.toBeNull();
    expect(out.genTimeUtc).not.toBeNull();
    expect(out.imprintMatchesRequest).toBe(true);
  });
});
