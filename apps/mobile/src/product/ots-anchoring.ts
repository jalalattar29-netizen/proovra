/**
 * BITCOIN ANCHORING (OpenTimestamps) — the native reader of the ONE state
 * authority (packages/shared/src/ots-anchoring.ts).
 *
 * The API decides the lifecycle state (NOT_REQUESTED | PENDING | ANCHORED |
 * FAILED | UNAVAILABLE) from the stored proof's own bytes, and qualifies an
 * ANCHORED proof with the independent Bitcoin main-chain check bound to it —
 * the derived `verification` key. Mobile renders the VERIFICATION, never the
 * bare state: ANCHORED only means "Bitcoin attestation recorded, not
 * independently checked". CHAIN_VERIFIED is the one and only green / ✓ /
 * "Independently verified against the Bitcoin main chain".
 *
 * Mobile never re-derives either from a txid, a block height, a timestamp or
 * a status string: it reads the view with `readOtsAnchoringView` (anything
 * missing or unknown reads as UNAVAILABLE; a chain claim the chain fact does
 * not back reads as an unchecked attestation) and prints the words of the
 * active locale from `otsAnchoringCopy` (en / de / ar; any other locale reads
 * English). PURE.
 */
import {
  OTS_VERIFICATION_TONES,
  otsAnchoringCopy,
  otsBoundaryFor,
  otsVerificationOfSignalState,
  otsVerificationSentence,
  parseOtsState,
  parseOtsVerificationKey,
  presentOtsAnchoring,
  readOtsAnchoringView,
  type OtsAnchoring,
  type OtsAnchoringView,
  type OtsState,
  type OtsStateTone,
  type OtsVerificationKey,
} from "@proovra/shared";

export type { OtsAnchoringView, OtsState, OtsStateTone, OtsVerificationKey };

export type OtsBadgeTone = "verified" | "risk" | "neutral";

/** The `ots` object a server sent, read through the shared contract reader. */
export function readOts(value: unknown, locale?: string | null): OtsAnchoringView {
  return readOtsAnchoringView(value, locale ?? "en");
}

/** The native badge tone for a verification key: CHAIN_VERIFIED alone is green; FAILED / CHAIN_FAILED are risk. */
export function otsBadgeTone(verification: OtsVerificationKey): OtsBadgeTone {
  const tone = OTS_VERIFICATION_TONES[verification] ?? "neutral";
  return tone === "success" ? "verified" : tone === "danger" ? "risk" : "neutral";
}

/** The lifecycle state a verification key belongs to. */
export const OTS_STATE_OF_VERIFICATION: Readonly<Record<OtsVerificationKey, OtsState>> = {
  NOT_REQUESTED: "NOT_REQUESTED",
  PENDING: "PENDING",
  ATTESTATION_RECORDED: "ANCHORED",
  CHAIN_CONFIRMATIONS_PENDING: "ANCHORED",
  CHAIN_UNAVAILABLE: "ANCHORED",
  CHAIN_FAILED: "ANCHORED",
  CHAIN_VERIFIED: "ANCHORED",
  FAILED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
};

export interface OtsFact {
  key:
    | "digest"
    | "proofSha256"
    | "attestationType"
    | "blockHeight"
    | "txid"
    | "submittedAt"
    | "anchoredAt"
    | "validator"
    | "blockHash"
    | "confirmations"
    | "checkedAt"
    | "verifiedAt";
  label: string;
  value: string;
  mono: boolean;
}

export interface OtsCardView {
  /** The lifecycle state (ANCHORED is NOT a verification). */
  state: OtsState;
  /** The derived presentation key — the one this card is drawn from. */
  verification: OtsVerificationKey;
  /** "Bitcoin anchoring" in the active locale. */
  title: string;
  /** The short status word: "Attestation recorded", "Independently verified", "Pending", … */
  status: string;
  /** The standalone label: "Bitcoin attestation recorded", "Independently verified against the Bitcoin main chain", … */
  label: string;
  /** The one sentence, with its facts when present. */
  sentence: string;
  /** "Not independently checked against Bitcoin" for an unchecked attestation, else null. */
  secondaryStatus: string | null;
  tone: OtsStateTone;
  badgeTone: OtsBadgeTone;
  /** Only CHAIN_VERIFIED shows a check mark. */
  check: boolean;
  /** Bounded failure / unavailability explanation, in the locale's words (otsAnchoringCopy.failureLabels). */
  failureLabel: string | null;
  /** Stated once, in technical material, when a boundary applies. */
  boundary: string | null;
  /** Only the facts that are present. The txid only when the proof path derived it. */
  facts: OtsFact[];
}

type ChainLike = OtsAnchoringView["chain"];

function cardOf(
  input: {
    state: OtsState;
    verification: OtsVerificationKey;
    bitcoinBlockHeight?: number | null;
    chain?: ChainLike;
    failureCode?: string | null;
    view?: OtsAnchoringView | null;
  },
  locale: string | null | undefined,
  fmt: ((iso: string) => string) | undefined,
): OtsCardView {
  const copy = otsAnchoringCopy(locale);
  const chain = input.chain ?? null;
  const p = presentOtsAnchoring(
    {
      state: input.state,
      verification: input.verification,
      bitcoinBlockHeight: input.bitcoinBlockHeight ?? null,
      chain: chain as OtsAnchoring["chain"],
    },
    locale,
  );
  const verification = p.verification;
  const sentence = fmt
    ? otsVerificationSentence({ verification, bitcoinBlockHeight: input.bitcoinBlockHeight ?? null, chain: chain as OtsAnchoring["chain"] }, locale, fmt)
    : p.sentence;
  const show = fmt ?? ((iso: string) => iso);
  const facts: OtsFact[] = [];
  const push = (key: OtsFact["key"], v: string | null | undefined, mono = false) => {
    if (v) facts.push({ key, label: copy.facts[key], value: v, mono });
  };
  const view = input.view ?? null;
  if (view) {
    push("digest", view.committedDigestHex, true);
    push("proofSha256", view.proofSha256, true);
    push("attestationType", view.attestationType ? copy.attestationTypes[view.attestationType] : null);
  }
  push("blockHeight", input.bitcoinBlockHeight != null ? String(input.bitcoinBlockHeight) : null);
  if (view) {
    push("txid", view.bitcoinTxid, true);
    push("submittedAt", view.submittedAtUtc ? show(view.submittedAtUtc) : null);
    push("anchoredAt", view.anchoredAtUtc ? show(view.anchoredAtUtc) : null);
    push("validator", view.validator, true);
  }
  if (chain && verification.startsWith("CHAIN_")) {
    push("blockHash", chain.blockHash, true);
    push("confirmations", chain.confirmations != null ? String(chain.confirmations) : null);
    push("checkedAt", chain.checkedAtUtc ? show(chain.checkedAtUtc) : null);
    if (verification === "CHAIN_VERIFIED") push("verifiedAt", chain.verifiedAtUtc ? show(chain.verifiedAtUtc) : null);
  }
  const failureCode = input.failureCode ?? null;
  return {
    state: p.state,
    verification,
    title: copy.title,
    status: p.status,
    label: p.label,
    sentence,
    secondaryStatus: p.secondaryStatus,
    tone: p.tone,
    badgeTone: otsBadgeTone(verification),
    check: verification === "CHAIN_VERIFIED",
    failureLabel: failureCode ? (copy.failureLabels[failureCode] ?? copy.failureLabels.OTS_PROCESSING_FAILED ?? null) : null,
    boundary: otsBoundaryFor({ verification }, locale),
    facts,
  };
}

/**
 * The card for one `ots` / `otsAnchoring` object a server sent. `fmt` formats
 * a UTC instant; the anchoring time is PROOVRA's recording time, never a
 * Bitcoin block time.
 */
export function otsCard(value: unknown, locale: string | null | undefined, fmt?: (iso: string) => string): OtsCardView {
  const view = readOtsAnchoringView(value, locale);
  return cardOf(
    {
      state: view.state,
      verification: view.verification,
      bitcoinBlockHeight: view.bitcoinBlockHeight,
      chain: view.chain,
      failureCode: view.failureCode,
      view,
    },
    locale,
    fmt,
  );
}

/**
 * The card for a verification key a trust signal / matrix row / decision
 * bucket already resolved (shared trust-signal-state.ts). No facts.
 */
export function otsCardForVerification(verification: unknown, locale: string | null | undefined): OtsCardView {
  const key = parseOtsVerificationKey(verification) ?? "UNAVAILABLE";
  return cardOf({ state: OTS_STATE_OF_VERIFICATION[key], verification: key }, locale, undefined);
}

/**
 * The badge text: the short status word ("Attestation recorded", "Pending",
 * …), with a check mark for CHAIN_VERIFIED only ("Independently verified ✓").
 */
export function otsBadgeLabel(card: Pick<OtsCardView, "status" | "check">): string {
  return card.check ? `${card.status} ✓` : card.status;
}

/**
 * One line of status text where there is no badge: the standalone label
 * ("Bitcoin attestation recorded", "Independently verified against the
 * Bitcoin main chain ✓", …) and the "Not independently checked against
 * Bitcoin" qualifier when it applies.
 */
export function otsStatusLine(card: Pick<OtsCardView, "label" | "check" | "secondaryStatus">): string {
  const head = card.check ? `${card.label} ✓` : card.label;
  return card.secondaryStatus ? `${head} — ${card.secondaryStatus}` : head;
}

/** The detail beside a badge: the qualifier (when it applies) and the one sentence. */
export function otsDetail(card: Pick<OtsCardView, "sentence" | "secondaryStatus">): string {
  return card.secondaryStatus ? `${card.secondaryStatus}. ${card.sentence}` : card.sentence;
}

/** The localized status word for a lifecycle state, read conservatively (ANCHORED → "Attestation recorded"). */
export function otsStateWord(state: unknown, locale: string | null | undefined): string {
  return otsCard({ state: parseOtsState(state) }, locale).status;
}

/** The localized title ("Bitcoin anchoring"). */
export function otsTitle(locale: string | null | undefined): string {
  return otsAnchoringCopy(locale).title;
}

/**
 * The `bitcoin_anchoring` trust signal's verification key: its own marker when
 * coherent with its state, else the conservative reading of the state
 * (shared `otsVerificationOfSignalState`). Never re-derived from its words.
 */
export function otsVerificationFromTrustSignal(state: unknown, marker?: unknown): OtsVerificationKey {
  return otsVerificationOfSignalState(state as Parameters<typeof otsVerificationOfSignalState>[0], marker);
}

/** The trust decision's `anchoringState` bucket as a verification key. Unknown → UNAVAILABLE. */
export function otsVerificationFromAnchoringBucket(bucket: unknown): OtsVerificationKey {
  switch (typeof bucket === "string" ? bucket.toLowerCase() : "") {
    case "verified":
      return "CHAIN_VERIFIED";
    case "recorded":
    case "anchored":
      return "ATTESTATION_RECORDED";
    case "pending":
      return "PENDING";
    case "failed":
      return "FAILED";
    case "not_requested":
      return "NOT_REQUESTED";
    default:
      return "UNAVAILABLE";
  }
}

/** The facts a summary row shows: the named block, the txid, PROOVRA's recording time and the chain check's own facts. */
const SUMMARY_FACT_KEYS: ReadonlySet<OtsFact["key"]> = new Set(["blockHeight", "txid", "anchoredAt", "confirmations", "checkedAt"]);
export function isOtsSummaryFact(f: Pick<OtsFact, "key">): boolean {
  return SUMMARY_FACT_KEYS.has(f.key);
}

/**
 * The verification key of a (state, claimed verification) pair a projection
 * sent WITHOUT chain facts (e.g. the provenance chain's `time.ots`): believed
 * only when coherent with the lifecycle state — the shared
 * `presentOtsAnchoring` rule. ANCHORED without a key is an unchecked attestation.
 */
export function otsVerificationOf(state: unknown, claimed: unknown): OtsVerificationKey {
  return presentOtsAnchoring({ state: parseOtsState(state), verification: parseOtsVerificationKey(claimed) ?? undefined }).verification;
}
