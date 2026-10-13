/**
 * BITCOIN ANCHORING (OpenTimestamps) — the native reader of the ONE state
 * authority (packages/shared/src/ots-anchoring.ts, 2026-10-13).
 *
 * The API decides the state (NOT_REQUESTED | PENDING | ANCHORED | FAILED |
 * UNAVAILABLE) from the stored proof's own bytes and sends it as an
 * `OtsAnchoringView` wherever a response carries an `ots` object. Mobile never
 * re-derives it from a txid, a block height, a timestamp or a status string:
 * it reads the state with `readOtsAnchoringView` (anything missing or unknown
 * reads as UNAVAILABLE) and prints the words of the active locale from
 * `otsAnchoringCopy` (en / de / ar; any other locale reads English). PURE.
 */
import {
  OTS_STATE_TONES,
  otsAnchoringCopy,
  parseOtsState,
  readOtsAnchoringView,
  type OtsAnchoringView,
  type OtsState,
  type OtsStateTone,
} from "@proovra/shared";

export type { OtsAnchoringView, OtsState, OtsStateTone };

/** The `ots` object a server sent, read through the shared contract reader. */
export function readOts(value: unknown): OtsAnchoringView {
  return readOtsAnchoringView(value);
}

/** The native badge tone for a state: ANCHORED is green, FAILED is risk, the rest neutral. */
export function otsBadgeTone(state: OtsState): "verified" | "risk" | "neutral" {
  const tone = OTS_STATE_TONES[parseOtsState(state)];
  return tone === "success" ? "verified" : tone === "danger" ? "risk" : "neutral";
}

export interface OtsFact {
  key: "digest" | "proofSha256" | "attestationType" | "blockHeight" | "txid" | "submittedAt" | "anchoredAt" | "validator";
  label: string;
  value: string;
  mono: boolean;
}

export interface OtsCardView {
  state: OtsState;
  /** "Bitcoin anchoring" in the active locale. */
  title: string;
  /** The status word: "Anchored", "Pending", … */
  status: string;
  /** The standalone label: "Bitcoin anchored", "Bitcoin anchoring pending", … */
  label: string;
  /** The one sentence. */
  sentence: string;
  tone: OtsStateTone;
  badgeTone: "verified" | "risk" | "neutral";
  /** ANCHORED shows a check mark beside its word. */
  check: boolean;
  /** Bounded failure / unavailability explanation, in the locale's words (otsAnchoringCopy.failureLabels). */
  failureLabel: string | null;
  /** Stated once, in technical material, for ANCHORED. */
  boundary: string | null;
  /** Only the facts that are present. The txid only when the proof path derived it. */
  facts: OtsFact[];
}

/**
 * The card for one `ots` object. `fmt` formats a UTC instant; the anchoring
 * time is PROOVRA's recording time, never a Bitcoin block time.
 */
export function otsCard(
  value: unknown,
  locale: string | null | undefined,
  fmt: (iso: string) => string = (iso) => iso,
): OtsCardView {
  // Re-reading a view is idempotent, so a parsed view and a raw payload both work.
  const view = readOtsAnchoringView(value);
  const copy = otsAnchoringCopy(locale);
  const state = view.state;
  const facts: OtsFact[] = [];
  const push = (key: OtsFact["key"], v: string | null, mono = false) => {
    if (v) facts.push({ key, label: copy.facts[key], value: v, mono });
  };
  push("digest", view.committedDigestHex, true);
  push("proofSha256", view.proofSha256, true);
  push("attestationType", view.attestationType ? copy.attestationTypes[view.attestationType] : null);
  push("blockHeight", view.bitcoinBlockHeight !== null ? String(view.bitcoinBlockHeight) : null);
  push("txid", view.bitcoinTxid, true);
  push("submittedAt", view.submittedAtUtc ? fmt(view.submittedAtUtc) : null);
  push("anchoredAt", view.anchoredAtUtc ? fmt(view.anchoredAtUtc) : null);
  push("validator", view.validator, true);
  const badgeTone = otsBadgeTone(state);
  return {
    state,
    title: copy.title,
    status: copy.words[state],
    label: copy.labels[state],
    sentence: copy.sentences[state],
    tone: OTS_STATE_TONES[state],
    badgeTone,
    check: state === "ANCHORED",
    failureLabel: view.failureCode ? (copy.failureLabels[view.failureCode] ?? copy.failureLabels.OTS_PROCESSING_FAILED ?? null) : null,
    boundary: state === "ANCHORED" ? copy.boundary : null,
    facts,
  };
}

/** The status word with its check mark for ANCHORED ("Anchored ✓"). */
export function otsBadgeLabel(card: Pick<OtsCardView, "status" | "check">): string {
  return card.check ? `${card.status} ✓` : card.status;
}

/** The localized word for a state. */
export function otsStateWord(state: unknown, locale: string | null | undefined): string {
  return otsAnchoringCopy(locale).words[parseOtsState(state)];
}

/** The localized title ("Bitcoin anchoring"). */
export function otsTitle(locale: string | null | undefined): string {
  return otsAnchoringCopy(locale).title;
}

/**
 * The `bitcoin_anchoring` trust signal carries the canonical OTS state as a
 * trust state (shared verification-matrix `otsStateFromTrustState`): read
 * back, never re-derived. Anything else — a legacy or unknown state — reads
 * as UNAVAILABLE.
 */
export function otsStateFromTrustSignal(state: unknown): OtsState {
  switch (state) {
    case "PASSED":
      return "ANCHORED";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "NOT_APPLICABLE":
      return "NOT_REQUESTED";
    default:
      return "UNAVAILABLE";
  }
}

/** The trust decision's `anchoringState` bucket is the canonical OTS state, lower-cased. */
export function otsStateFromAnchoringBucket(bucket: unknown): OtsState {
  return parseOtsState(typeof bucket === "string" ? bucket.toUpperCase() : bucket);
}
