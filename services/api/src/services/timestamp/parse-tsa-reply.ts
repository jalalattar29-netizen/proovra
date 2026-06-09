/**
 * Phase IA-TSA-falseFailed — TSA RFC 3161 reply parser.
 *
 * Production incident:
 *   Manual replay of digest 1cb2724a…b9 against GLOBALTRUST returned
 *   HTTP 200 + Status: Granted. + Serial number: 0x0310230FEA + Time
 *   stamp: Jun  9 09:50:34 2026 GMT — but the DB row had
 *   tsa_status='FAILED' and tsa_serial_number=null. The inline parser
 *   in timestamp.service.ts was a single regex match against
 *   /Status:\s*(Granted|GrantedWithMods)/i + a free-form failure reason
 *   normalizer that collapsed every parser-side mishap into a generic
 *   "Trusted timestamp could not be obtained due to a timestamp
 *   provider error." string. That generic reason masks at least four
 *   distinct failure modes:
 *
 *     * the TSA returned a valid Granted token but our parser couldn't
 *       extract the serial / generation time (e.g. double-space day
 *       formatting Jun  9 breaking new Date())
 *     * the TSR returned Status: Rejected (or anything other than
 *       Granted / GrantedWithMods)
 *     * the message imprint in the TSR disagrees with the digest we
 *       sent (provider mistake or tampering)
 *     * the upstream openssl/curl subprocess threw a hard error
 *
 * This module makes those failure modes EXPLICIT. The parser returns a
 * structured `TsaReplyParseResult` whose `failureCode` is one of a
 * bounded enum — `tsa_response_parse_failed`, `tsa_response_not_granted`,
 * `tsa_message_imprint_mismatch`, `tsa_missing_serial_or_generation_time`.
 * The timestamp service then maps each code to an operator-readable
 * `tsaFailureReason` AND preserves the token bytes when the response IS
 * well-formed (so the repair tool can re-parse it offline without
 * calling the provider again).
 *
 * NEVER throws. The contract is: feed me the openssl ts -reply text and
 * (optionally) the digest we sent; I return a parsed result.
 */

export type TsaParseStatusKind = "granted" | "granted_with_mods" | "other";

export type TsaReplyFailureCode =
  | "tsa_response_parse_failed"
  | "tsa_response_not_granted"
  | "tsa_message_imprint_mismatch"
  | "tsa_missing_serial_or_generation_time";

export type TsaReplyParseResult = {
  /** True iff Granted/GrantedWithMods AND no validation issue surfaced. */
  granted: boolean;
  /** Categorized status. `other` covers Rejected, Waiting, unknown, etc. */
  statusKind: TsaParseStatusKind;
  /** Raw status line text — first 80 chars, trimmed. Forensic context only. */
  statusText: string | null;
  /** Stringified serial number (e.g. "0x0310230FEA"). */
  serialNumber: string | null;
  /** Generation time as Date in UTC, or null when not parseable. */
  genTimeUtc: Date | null;
  /**
   * Hex digest extracted from the multi-line "Message data" dump in the
   * TSR. Lowercased. Null if the dump wasn't present or didn't parse.
   */
  messageImprintHex: string | null;
  /**
   * `imprintMatchesRequest` is true when both `messageImprintHex` and the
   * supplied `expectedDigestHex` parsed and matched. False when they
   * parsed and disagreed. `null` when no expected was supplied OR the
   * TSR didn't include a "Message data" block.
   */
  imprintMatchesRequest: boolean | null;
  /**
   * Bounded failure code when parsing succeeded but the response should
   * not be persisted as granted. Null on success.
   */
  failureCode: TsaReplyFailureCode | null;
  /** Operator-readable summary for logs + the persisted failure reason. */
  failureReason: string | null;
};

/** Map a bounded failure code to the operator-readable persisted reason. */
export function tsaFailureCodeToReason(code: TsaReplyFailureCode): string {
  switch (code) {
    case "tsa_response_parse_failed":
      return "Trusted timestamp response was received but could not be parsed by the worker.";
    case "tsa_response_not_granted":
      return "Trusted timestamp provider returned a non-granted status.";
    case "tsa_message_imprint_mismatch":
      return "Trusted timestamp message imprint disagreed with the digest sent — the response was not persisted.";
    case "tsa_missing_serial_or_generation_time":
      return "Trusted timestamp response was granted but did not include a serial number or generation time.";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function findFirstLine(
  text: string,
  re: RegExp,
): { line: string; capture: string | null } | null {
  const m = text.match(re);
  if (!m) return null;
  return { line: m[0]!, capture: m[1] ?? null };
}

/**
 * Match the `Status:` line. The TSR may say `Status: Granted.` (trailing
 * period) or `Status: Granted` (no period), case-insensitive. Some
 * providers emit a `Status description:` line below it; we DO NOT match
 * that one because it isn't authoritative.
 */
function parseStatus(text: string): {
  kind: TsaParseStatusKind;
  raw: string | null;
} {
  // Anchor to start-of-line where possible so we don't accidentally pick
  // up `Status description:` matches further down the response.
  const re = /(?:^|\n)\s*Status:\s*([^\r\n]+)/i;
  const m = text.match(re);
  if (!m) return { kind: "other", raw: null };
  const raw = (m[1] ?? "").trim();
  const cleaned = raw.replace(/[.\s]+$/g, "").toLowerCase();
  if (cleaned === "granted") return { kind: "granted", raw };
  if (cleaned === "grantedwithmods" || cleaned === "granted with mods") {
    return { kind: "granted_with_mods", raw };
  }
  return { kind: "other", raw };
}

function parseSerialNumber(text: string): string | null {
  const m = text.match(/(?:^|\n)\s*Serial number:\s*([^\r\n]+)/i);
  if (!m) return null;
  const v = (m[1] ?? "").trim();
  return v.length > 0 ? v : null;
}

/**
 * Parse `Time stamp: Jun  9 09:50:34 2026 GMT` (double-space day
 * formatting) and similar shapes. Returns a UTC Date, or null when
 * unparseable.
 *
 * `new Date('Jun  9 09:50:34 2026 GMT')` works on modern V8 — but only
 * just. We normalize whitespace first to be defensive against subtle
 * differences across Node versions / system locales (production has
 * already burned us once on this).
 */
function parseGenTime(text: string): Date | null {
  const m = text.match(/(?:^|\n)\s*Time stamp:\s*([^\r\n]+)/i);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  if (!raw) return null;
  // Collapse runs of whitespace so `Jun  9` becomes `Jun 9`.
  const normalized = raw.replace(/\s+/g, " ");
  const parsed = new Date(normalized);
  if (Number.isFinite(parsed.getTime())) return parsed;
  // Defensive secondary attempt — some openssl versions print
  // `YYYY-MM-DD HH:MM:SS UTC` instead of the C-style format. The native
  // parser typically handles both, but if the first attempt failed we
  // try one final normalization pass.
  const alt = new Date(normalized.replace(/\bUTC\b$/i, "Z"));
  return Number.isFinite(alt.getTime()) ? alt : null;
}

/**
 * Extract the hex message imprint from the multi-line "Message data"
 * dump that openssl emits:
 *
 *     Message data:
 *         0000 - 1c b2 72 4a eb 57 20 6a-b6 ad 79 5a 2f db 0e 97
 *         0010 - eb 13 49 a8 d7 b1 a0 ad-eb 09 0e 76 e6 d2 dd b9
 *
 * Stops at the next blank line or any line that doesn't fit the dump
 * shape so we never run past the block.
 */
function parseMessageImprint(text: string): string | null {
  const headerIdx = text.search(/(?:^|\n)\s*Message data:\s*\n/i);
  if (headerIdx < 0) return null;
  const after = text.slice(headerIdx);
  // Match every dump line under the header. Format:
  //   <hex offset> - <space-separated hex pairs, optionally joined by `-`>
  // Use [^\n]* for the capture so we stop at the line boundary —
  // otherwise \s (which matches \n) would let the regex eat the next
  // line's offset prefix, producing concatenated garbage.
  const lineRe = /\n[ \t]*[0-9a-f]{4,}[ \t]*-[ \t]*([^\n]*)/gi;
  let hex = "";
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(after)) !== null) {
    // The capture contains hex bytes plus separators (space, `-`).
    // Drop everything that isn't a hex character to get the line's
    // contribution to the digest.
    const chunk = (m[1] ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    if (chunk.length === 0) break;
    // Defensive sanity: post-strip MUST be hex only.
    if (!/^[0-9a-f]+$/.test(chunk)) break;
    hex += chunk;
    // Hard cap at 256 hex chars (= 128 bytes) — far larger than any
    // sane digest. Prevents runaway concatenation on a malformed reply.
    if (hex.length > 256) break;
  }
  return hex.length > 0 ? hex : null;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function parseTsaReply(
  stdout: string,
  expectedDigestHex?: string | null,
): TsaReplyParseResult {
  // Defensive: defensive against pathological inputs (empty / non-string).
  if (typeof stdout !== "string" || stdout.length === 0) {
    return {
      granted: false,
      statusKind: "other",
      statusText: null,
      serialNumber: null,
      genTimeUtc: null,
      messageImprintHex: null,
      imprintMatchesRequest: null,
      failureCode: "tsa_response_parse_failed",
      failureReason: tsaFailureCodeToReason("tsa_response_parse_failed"),
    };
  }

  const status = parseStatus(stdout);
  const serialNumber = parseSerialNumber(stdout);
  const genTimeUtc = parseGenTime(stdout);
  const messageImprintHex = parseMessageImprint(stdout);

  const expected =
    typeof expectedDigestHex === "string"
      ? expectedDigestHex.trim().toLowerCase()
      : null;
  let imprintMatchesRequest: boolean | null;
  if (!expected || !messageImprintHex) {
    imprintMatchesRequest = null;
  } else {
    imprintMatchesRequest = messageImprintHex === expected;
  }

  // -----------------------------------------------------------------------
  // Outcome classification — bounded codes ONLY.
  // -----------------------------------------------------------------------

  if (status.kind === "other") {
    return {
      granted: false,
      statusKind: status.kind,
      statusText: status.raw,
      serialNumber,
      genTimeUtc,
      messageImprintHex,
      imprintMatchesRequest,
      failureCode: "tsa_response_not_granted",
      failureReason: tsaFailureCodeToReason("tsa_response_not_granted"),
    };
  }

  if (imprintMatchesRequest === false) {
    // Hard fail — the response we received does not certify the digest
    // we asked for. We REFUSE to persist this as granted no matter what
    // the rest of the response says.
    return {
      granted: false,
      statusKind: status.kind,
      statusText: status.raw,
      serialNumber,
      genTimeUtc,
      messageImprintHex,
      imprintMatchesRequest,
      failureCode: "tsa_message_imprint_mismatch",
      failureReason: tsaFailureCodeToReason("tsa_message_imprint_mismatch"),
    };
  }

  if (serialNumber === null || genTimeUtc === null) {
    // Granted but a critical receipt field is missing. This is the
    // failure mode the production incident exposed: the parser found
    // Status: Granted but the time/serial extraction failed and the
    // whole row was downgraded to a generic provider error.
    return {
      granted: false,
      statusKind: status.kind,
      statusText: status.raw,
      serialNumber,
      genTimeUtc,
      messageImprintHex,
      imprintMatchesRequest,
      failureCode: "tsa_missing_serial_or_generation_time",
      failureReason: tsaFailureCodeToReason(
        "tsa_missing_serial_or_generation_time",
      ),
    };
  }

  // Happy path — Granted (or GrantedWithMods), imprint matches (or no
  // expected supplied), serial + genTime parsed.
  return {
    granted: true,
    statusKind: status.kind,
    statusText: status.raw,
    serialNumber,
    genTimeUtc,
    messageImprintHex,
    imprintMatchesRequest,
    failureCode: null,
    failureReason: null,
  };
}
