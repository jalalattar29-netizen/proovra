function normalizeOutput(stdout?: string, stderr?: string): string {
  return `${stdout ?? ""}\n${stderr ?? ""}`.trim();
}

function normalizeTxid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

function hasBitcoinContext(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("bitcoin") ||
    lower.includes("blockchain") ||
    lower.includes("block explorer") ||
    lower.includes("blockstream") ||
    lower.includes("mempool") ||
    lower.includes("txid") ||
    lower.includes("transaction id") ||
    lower.includes("transaction:")
  );
}

function parseTxid(text: string): string | null {
  const contextualPatterns = [
    /bitcoin transaction(?: id)?[^a-f0-9]*([a-f0-9]{64})/i,
    /\btxid[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\btransaction id[^a-f0-9]*([a-f0-9]{64})\b/i,
    /\btransaction[^a-f0-9]+([a-f0-9]{64})\b/i,
    /https?:\/\/[^\s]*\/tx\/([a-f0-9]{64})(?:\b|[/?#])/i,
    /https?:\/\/[^\s]*\/([a-f0-9]{64})(?:\b|[/?#])/i,
  ];

  for (const pattern of contextualPatterns) {
    const match = text.match(pattern);
    const candidate = normalizeTxid(match?.[1] ?? match?.[0] ?? null);
    if (candidate) return candidate;
  }

  if (hasBitcoinContext(text)) {
    const genericMatch = text.match(/\b([a-f0-9]{64})\b/i);
    const candidate = normalizeTxid(genericMatch?.[1] ?? null);
    if (candidate) return candidate;
  }

  return null;
}

function isAnchoredOutput(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("success! timestamp complete") ||
    lower.includes("timestamp complete") ||
    lower.includes("bitcoin transaction")
  );
}

function isPendingOutput(text: string): boolean {
  const lower = text.toLowerCase();

  return (
    lower.includes("pending confirmation in bitcoin blockchain") ||
    lower.includes("pending confirmations") ||
    lower.includes("still waiting") ||
    lower.includes("waiting for 6 confirmations") ||
    lower.includes("timestamp not complete") ||
    lower.includes("not yet anchored") ||
    lower.includes("cannot be greater than available calendar") ||
    lower.includes("available calendar")
  );
}

export type OtsUpgradeOutput = {
  raw: string;
  txid: string | null;
  anchoredOutput: boolean;
  pendingOutput: boolean;
};

export function parseOtsUpgradeOutput(
  stdout?: string,
  stderr?: string
): OtsUpgradeOutput {
  const raw = normalizeOutput(stdout, stderr);
  return {
    raw,
    txid: parseTxid(raw),
    anchoredOutput: isAnchoredOutput(raw),
    pendingOutput: isPendingOutput(raw),
  };
}

export function shouldTreatOtsAsAnchored(result: OtsUpgradeOutput): boolean {
  return result.anchoredOutput && !result.pendingOutput;
}

// ===========================================================================
// Phase IA-OTS-hybrid — definitive verify-output parsing + deterministic
// state classifier.
//
// The upgrade-output parser above is a heuristic and (correctly) cannot
// distinguish a fully-anchored proof from a partially-attested one when
// `ots upgrade` emits BOTH a Bitcoin transaction reference AND a
// "pending confirmations" line — the txid was registered with a calendar
// but the proof still needs more block confirmations.
//
// `ots verify` is the canonical "is this proof actually anchored?"
// answer. Its output is much more structured: on success it emits a
// `"Success! Bitcoin block N attests existence as of <ISO date>"` line;
// on partial attestation it emits "Calendar ... pending" / "not fully
// confirmed" markers; on hard failure it errors.
//
// The classifier below combines BOTH signals and returns one of four
// deterministic kinds. The legacy `shouldTreatOtsAsAnchored` is kept
// untouched for back-compat with existing tests + call sites; new
// processor logic should consume `classifyOtsResult` instead.
// ===========================================================================

export type OtsVerifyOutput = {
  raw: string;
  /** True only when `ots verify` produces a Success/Bitcoin-block line. */
  verified: boolean;
  /** True when verify output explicitly says pending / incomplete. */
  incompleteOutput: boolean;
  /** Bitcoin block height parsed from the success line, when present. */
  blockHeight: number | null;
  /**
   * Anchoring timestamp parsed from `ots verify` output (`existence as of
   * <ISO date>`). Returned as an ISO string; the caller may need to
   * canonicalize timezones.
   */
  anchoredAtUtc: string | null;
};

function parseBlockHeight(text: string): number | null {
  // Matches: "Bitcoin block 850000 attests existence as of"
  //          "Success! Bitcoin block 850000 ..."
  const match = text.match(/bitcoin\s+block\s+(\d+)/i);
  if (!match) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseAnchoredAtUtc(text: string): string | null {
  // Matches: "existence as of 2026-06-08 13:30:00 UTC"
  //          "existence as of 2026-06-08T13:30:00Z"
  const isoMatch = text.match(
    /existence\s+as\s+of\s+(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:utc|z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (!isoMatch) return null;
  const raw = isoMatch[1]!
    .trim()
    .replace(/\s+utc$/i, "Z")
    .replace(/\s+(?=\d)/, "T"); // "2026-06-08 13:30" → "2026-06-08T13:30"
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isVerifySuccess(text: string): boolean {
  const lower = text.toLowerCase();
  // The OpenTimestamps client emits "Success! ..." on full verify. We
  // accept either the exact "success!" marker OR an explicit
  // "Bitcoin block N attests" line that names a concrete block height.
  if (lower.includes("success!")) {
    return true;
  }
  // Defensive: some forks of the CLI print "verified" + block-height
  // line without the exclamation.
  if (/bitcoin\s+block\s+\d+\s+attests/i.test(text)) {
    return true;
  }
  return false;
}

function isVerifyIncomplete(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("calendar attestation incomplete") ||
    lower.includes("pending confirmation") ||
    lower.includes("pending confirmations") ||
    lower.includes("not yet anchored") ||
    lower.includes("not fully confirmed") ||
    // The CLI sometimes emits "no attestations" when the proof was just
    // submitted to a calendar but no Bitcoin attestation is bundled.
    lower.includes("no attestations") ||
    // "Got 0 attestation(s)" is the deterministic shape on partial.
    /got\s+0\s+attestation/i.test(text)
  );
}

export function parseOtsVerifyOutput(
  stdout?: string,
  stderr?: string,
): OtsVerifyOutput {
  const raw = normalizeOutput(stdout, stderr);
  const verified = isVerifySuccess(raw);
  return {
    raw,
    verified,
    incompleteOutput: !verified && isVerifyIncomplete(raw),
    blockHeight: verified ? parseBlockHeight(raw) : null,
    anchoredAtUtc: verified ? parseAnchoredAtUtc(raw) : null,
  };
}

// ===========================================================================
// Phase IA-OTS-info-fallback — `ots info` output parser.
//
// `ots info <proof.ots>` dumps the proof structure WITHOUT contacting a
// Bitcoin node. It is the deterministic local-only signal that tells us
// whether the proof has already been bound to a Bitcoin block. Output
// shape (from the OpenTimestamps client):
//
//   File sha256 hash: 21d709d333031b30f2f080769ec0c9e09947b0e2e5d4e386a1a0e03b866aca6f
//   Timestamp:
//   prepend ...
//   sha256
//   ...
//   -> PendingAttestation('https://a.pool.opentimestamps.org')
//   -> BitcoinBlockHeaderAttestation(953006)
//
// Some clients ALSO emit a "Transaction id 5d1156f9..." line (or
// "Bitcoin transaction: 5d1156f9..."). We accept both shapes.
//
// The parser is read-only and pure — it operates on the captured
// stdout/stderr text. NEVER calls out to the network. NEVER fabricates.
//
// HARD INVARIANTS (consumed by the classifier downstream):
//   * `fileHash` is set ONLY when an explicit "File sha256 hash: <64hex>"
//     line is present. We never invent it.
//   * `bitcoinBlockHeights` is empty when the proof has no
//     BitcoinBlockHeaderAttestation. A proof that only has
//     PendingAttestation lines is NOT anchored.
//   * `txid` is set ONLY when an explicit "Transaction id" /
//     "Bitcoin transaction:" line is present. Heuristic byte-level
//     scanning is out of scope here.
// ===========================================================================

export type OtsInfoOutput = {
  raw: string;
  /**
   * The file-sha256-hash line value, lowercased for direct comparison
   * with `evidence.otsHash`. Null when absent from the output.
   */
  fileHash: string | null;
  /** Bitcoin transaction id parsed from "Transaction id" or
   * "Bitcoin transaction:" line; null when absent. */
  txid: string | null;
  /**
   * Every `BitcoinBlockHeaderAttestation(<n>)` block height that
   * appears in the output, in the order they appear. Empty array if
   * none. Multiple entries are valid (a proof can be anchored more
   * than once).
   */
  bitcoinBlockHeights: number[];
  /**
   * Every `PendingAttestation('<url>')` calendar URL that appears in
   * the output, in the order they appear. Empty when none.
   */
  pendingCalendars: string[];
};

function parseFileHash(text: string): string | null {
  // The OTS client uses "File sha256 hash:" with a colon; older
  // builds occasionally drop the colon. Accept both, case-insensitive.
  const match = text.match(/file\s+sha256\s+hash[:\s]+([a-f0-9]{64})/i);
  if (!match) return null;
  const candidate = match[1]!.toLowerCase();
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : null;
}

function parseInfoTxid(text: string): string | null {
  // Accept the explicit "Transaction id <hex>" shape (the user-cited
  // form) AND the "Bitcoin transaction: <hex>" shape that some clients
  // emit. Both are line-anchored to avoid grabbing a random 64-hex run
  // out of the merkle ops.
  const patterns = [
    /transaction\s+id[^a-f0-9]*([a-f0-9]{64})/i,
    /bitcoin\s+transaction(?:\s+id)?[^a-f0-9]*([a-f0-9]{64})/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const t = m[1]!.toLowerCase();
      if (/^[a-f0-9]{64}$/.test(t)) return t;
    }
  }
  return null;
}

function parseBitcoinBlockHeights(text: string): number[] {
  const heights: number[] = [];
  // Capture every BitcoinBlockHeaderAttestation(<digits>) occurrence.
  const re = /BitcoinBlockHeaderAttestation\(\s*(\d+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const n = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(n) && n >= 0) heights.push(n);
  }
  return heights;
}

function parsePendingCalendars(text: string): string[] {
  const calendars: string[] = [];
  const re = /PendingAttestation\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    calendars.push(match[1]!);
  }
  return calendars;
}

export function parseOtsInfoOutput(
  stdout?: string,
  stderr?: string,
): OtsInfoOutput {
  const raw = normalizeOutput(stdout, stderr);
  return {
    raw,
    fileHash: parseFileHash(raw),
    txid: parseInfoTxid(raw),
    bitcoinBlockHeights: parseBitcoinBlockHeights(raw),
    pendingCalendars: parsePendingCalendars(raw),
  };
}

/**
 * Deterministic OTS classification kind. Each kind maps to ONE
 * processor branch — there are no overlapping states.
 *
 *   FULLY_ANCHORED — the proof is verifiably anchored to Bitcoin. The
 *                    canonical signal is `ots verify` success; the
 *                    legacy `shouldTreatOtsAsAnchored` heuristic is
 *                    accepted as a fallback so back-compat is preserved
 *                    if the verify pass was skipped (e.g. the hash is
 *                    missing).
 *   ANCHOR_MATERIAL_RECOVERED — `ots upgrade` recovered a Bitcoin txid
 *                    but the proof is NOT yet fully anchored. This is
 *                    the legitimate hybrid state: status stays PENDING,
 *                    the txid is persisted, a custody event with phase
 *                    `txid_detected_pending_confirmation` is emitted,
 *                    and a follow-up upgrade is re-enqueued. Reports
 *                    are NOT regenerated as anchored.
 *   STILL_PENDING — no txid recovered yet, no anchored signal.
 *                    Re-enqueue follow-up.
 *   FAILED        — hard command error (not pending-like). The caller
 *                    decides whether to mark FAILED or rethrow.
 */
export type OtsClassificationKind =
  | "FULLY_ANCHORED"
  | "ANCHOR_MATERIAL_RECOVERED"
  | "STILL_PENDING"
  | "FAILED";

export type OtsClassification = {
  kind: OtsClassificationKind;
  /** Bitcoin txid resolved from upgrade output OR existing DB value. */
  txid: string | null;
  /** Anchoring timestamp resolved from verify output, when known. */
  anchoredAtUtc: string | null;
  /** Block height from verify output, when known. */
  blockHeight: number | null;
  /** Operator-readable phase string for the custody event payload. */
  phase: string;
  /** Operator-readable explanation suitable for a log line / event note. */
  reason: string;
};

export type ClassifyOtsResultInput = {
  upgrade: OtsUpgradeOutput;
  /** Optional — only present when the worker ran `ots verify`. */
  verify?: OtsVerifyOutput | null;
  /**
   * Optional — `ots info` output for the same proof. When verify is
   * unavailable (e.g., the container has no local Bitcoin RPC) but
   * the proof bytes themselves carry a `BitcoinBlockHeaderAttestation`
   * + a Bitcoin txid AND the embedded `File sha256 hash` matches the
   * expected file hash, the classifier promotes to FULLY_ANCHORED via
   * the info-confirms branch. See `classifyOtsResult` for the exact
   * preconditions and invariants.
   */
  info?: OtsInfoOutput | null;
  /**
   * Canonical SHA-256 hex (lowercase) of the evidence's `otsHash`
   * column. REQUIRED for the info-confirms branch — without it we
   * cannot prove the proof we just inspected matches THIS evidence.
   */
  expectedFileHashHex?: string | null;
  /** Existing txid on the Evidence row, if any. */
  existingTxid?: string | null;
  /** True when the upgrade subprocess threw a hard error. */
  commandErrored?: boolean;
  /**
   * The merged stderr/stdout text from the upgrade subprocess error
   * branch. Used to distinguish "pending-like" errors (timeout) from
   * hard failures.
   */
  mergedErrorText?: string | null;
};

function looksLikePendingError(text: string | null | undefined): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("connection refused") ||
    lower.includes("temporarily unavailable") ||
    // Calendar-side "no new attestations yet" — proof was re-submitted
    // but no block has confirmed yet.
    lower.includes("no new attestations") ||
    lower.includes("not yet anchored")
  );
}

export function classifyOtsResult(
  input: ClassifyOtsResultInput,
): OtsClassification {
  const {
    upgrade,
    verify,
    info,
    expectedFileHashHex,
    existingTxid,
    commandErrored,
    mergedErrorText,
  } = input;

  // Resolve the txid: prefer freshly-parsed (upgrade or info), fall
  // back to the existing persisted value.
  const recoveredTxid = upgrade.txid ?? info?.txid ?? null;
  const persistedTxid = normalizeTxid(existingTxid);
  const txid = recoveredTxid ?? persistedTxid;

  // 1. FULLY_ANCHORED — `ots verify` is the authoritative signal when
  //    a Bitcoin RPC is available to the container. The classifier
  //    accepts verify success as the canonical signal.
  if (verify?.verified === true) {
    return {
      kind: "FULLY_ANCHORED",
      txid,
      anchoredAtUtc: verify.anchoredAtUtc,
      blockHeight: verify.blockHeight,
      phase: "anchored",
      reason:
        verify.blockHeight !== null
          ? `ots verify confirmed Bitcoin block ${verify.blockHeight}.`
          : "ots verify confirmed Bitcoin anchoring.",
    };
  }

  // 1b. FULLY_ANCHORED via `ots info` — when verify is unavailable
  //     (typical container deployment: no local Bitcoin node, so
  //     `Could not connect to Bitcoin node: /home/app/.bitcoin/.cookie
  //     missing` makes verify exit non-zero), the proof bytes
  //     themselves still carry the deterministic anchoring evidence.
  //     `ots info` dumps the proof structure without network access.
  //
  //     STRICT preconditions — ALL must hold:
  //       a) info parsed a `File sha256 hash` line.
  //       b) That hash matches the expected `evidence.otsHash`
  //          (case-insensitive). This pins the proof to THIS evidence
  //          — without it, an attacker could swap a different proof.
  //       c) info parsed at least one BitcoinBlockHeaderAttestation.
  //          A proof with only PendingAttestation entries is NOT
  //          anchored, no matter what a txid line says.
  //       d) A Bitcoin txid is known (recovered fresh, parsed from
  //          info, or persisted on the row). Required by the strict
  //          rule "do NOT anchor from txid alone" — we require BOTH
  //          a txid AND the block-header attestation.
  //
  //     If verify is non-null AND `verify.verified === false`, that
  //     means verify ran and explicitly disagreed. We still accept
  //     info as the authoritative LOCAL signal because verify's
  //     "false" in this scenario is "couldn't reach the Bitcoin
  //     node", not "the proof is unanchored." `ots info`'s answer is
  //     deterministic and offline.
  if (info != null) {
    const expected = normalizeHex(expectedFileHashHex);
    const hashMatches =
      info.fileHash != null &&
      expected != null &&
      info.fileHash === expected;
    const hasBlockAttestation = info.bitcoinBlockHeights.length > 0;
    if (hashMatches && hasBlockAttestation && txid != null) {
      const blockHeight = info.bitcoinBlockHeights[0]!;
      return {
        kind: "FULLY_ANCHORED",
        txid,
        // anchoredAtUtc is left null — the processor falls back to
        // `upgradedAt` per the requirement "block time if available,
        // otherwise upgradedAtUtc/now". We do NOT invent a block
        // time; the offline proof bytes don't carry it.
        anchoredAtUtc: null,
        blockHeight,
        // Phase tag distinguishes this branch in custody metadata so
        // operators can tell the two FULLY_ANCHORED entry paths apart.
        phase: "anchored_via_info",
        reason: `ots info confirmed Bitcoin block ${blockHeight} attestation; file-hash matches evidence.otsHash; ots verify unavailable (likely no local Bitcoin RPC).`,
      };
    }
  }
  // Back-compat: when verify did not produce a usable result (caller
  // never ran it, OR `verifyOtsProof` returned a non-VERIFIED /
  // non-INCOMPLETE status — ERROR / BINARY_MISSING / DISABLED — and
  // the processor passed `null` to communicate that), AND the legacy
  // heuristic is unambiguous, honor it. This is the forward-path
  // defense against a permanently-broken verify call stranding
  // otherwise-anchored evidence in ANCHOR_MATERIAL_RECOVERED forever.
  //
  // CRITICAL safety: the legacy heuristic requires BOTH
  // `upgrade.anchoredOutput === true` AND `upgrade.pendingOutput ===
  // false`. The runtime evidence whose upgrade output contains both
  // "Bitcoin transaction" AND "Pending confirmation" sets BOTH flags;
  // we never false-positive promote that to FULLY_ANCHORED.
  //
  // Phase IA-OTS-hybrid-fix — broadened from `verify === undefined`
  // to `verify == null` so the ERROR / BINARY_MISSING / DISABLED
  // verify outcomes also fall back to the legacy heuristic. Without
  // this, a verify call that errored (e.g., OTS_BIN does not accept
  // `-d <hash>`) would keep promotable evidence stuck in
  // ANCHOR_MATERIAL_RECOVERED indefinitely.
  if (
    verify == null &&
    upgrade.anchoredOutput &&
    !upgrade.pendingOutput
  ) {
    return {
      kind: "FULLY_ANCHORED",
      txid,
      anchoredAtUtc: null,
      blockHeight: null,
      phase: "anchored",
      reason:
        "ots upgrade reported anchored completion (verify unavailable — legacy heuristic).",
    };
  }

  // 2. FAILED — only when the command errored AND the error doesn't
  //    look like a transient pending-like condition AND verify didn't
  //    succeed.
  if (commandErrored && !looksLikePendingError(mergedErrorText)) {
    return {
      kind: "FAILED",
      txid,
      anchoredAtUtc: null,
      blockHeight: null,
      phase: "upgrade_failed",
      reason:
        (clean(mergedErrorText) ??
          "OTS upgrade command failed with no structured reason.")
          .slice(0, 380),
    };
  }

  // 3. ANCHOR_MATERIAL_RECOVERED — a fresh txid was parsed (or one
  //    persists in DB) AND the proof is not anchored. This is the
  //    legitimate hybrid intermediate state.
  if (txid !== null) {
    return {
      kind: "ANCHOR_MATERIAL_RECOVERED",
      txid,
      anchoredAtUtc: null,
      blockHeight: null,
      phase: recoveredTxid
        ? "txid_detected_pending_confirmation"
        : "txid_persisted_pending_confirmation",
      reason: recoveredTxid
        ? "ots upgrade recovered a Bitcoin transaction id; the proof is awaiting block confirmations before it is fully anchored."
        : "A Bitcoin transaction id is already persisted on the evidence row; the proof is still awaiting block confirmations.",
    };
  }

  // 4. STILL_PENDING — default. No txid, no anchored signal.
  return {
    kind: "STILL_PENDING",
    txid: null,
    anchoredAtUtc: null,
    blockHeight: null,
    phase: upgrade.anchoredOutput && !upgrade.pendingOutput
      ? "awaiting_txid"
      : upgrade.pendingOutput
        ? "pending_confirmation"
        : "proof_refreshed_pending",
    reason:
      "OTS upgrade is still pending — no Bitcoin transaction has been bound to the proof yet.",
  };
}

// Small local helper used by the classifier. The same predicate is
// available in `ots-state.ts` via the shared `isValidOtsBitcoinTxid`;
// duplicating it here keeps this file free of cross-package import
// drift.
function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Phase IA-OTS-info-fallback — normalize an arbitrary hex string to
// lowercase + strip surrounding whitespace; return null if it isn't a
// 64-hex SHA-256 hash. Used by the info-confirms branch to compare
// `info.fileHash` with `evidence.otsHash`.
function normalizeHex(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(trimmed) ? trimmed : null;
}
