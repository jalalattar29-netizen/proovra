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
  const { upgrade, verify, existingTxid, commandErrored, mergedErrorText } =
    input;

  // Resolve the txid: prefer freshly-parsed, fall back to existing.
  const recoveredTxid = upgrade.txid;
  const persistedTxid = normalizeTxid(existingTxid);
  const txid = recoveredTxid ?? persistedTxid;

  // 1. FULLY_ANCHORED — `ots verify` is the authoritative signal. The
  //    legacy heuristic is the fallback so callers that skip verify
  //    keep the prior behavior.
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
  // Back-compat: when verify wasn't run AND the legacy heuristic was
  // already conclusive, honor it. We deliberately require the legacy
  // heuristic AND a non-incomplete verify (when verify exists but is
  // ambiguous) to avoid false-positive promotion.
  if (
    verify === undefined &&
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
        "ots upgrade reported anchored completion (verify skipped — legacy heuristic).",
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
