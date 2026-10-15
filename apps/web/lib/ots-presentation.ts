/**
 * OpenTimestamps wording for web surfaces that receive a bare status string
 * (admin record lists, filter values, dashboard counts) rather than an
 * `otsAnchoring` view. Every word comes from the shared copy in
 * `@proovra/shared` (ots-anchoring.ts); nothing here invents its own.
 *
 * A bare string can never prove an independent Bitcoin-chain check, with one
 * exception: the canonical verification key CHAIN_VERIFIED sent by a server
 * that computed it. A stored lifecycle status (ANCHORED, or a legacy OK /
 * VERIFIED column value) reads as an attestation recorded, never verified.
 */
import {
  OTS_STATE_WORDS,
  OTS_VERIFICATION_LABELS,
  OTS_VERIFICATION_TONES,
  OTS_VERIFICATION_WORDS,
  otsVerificationKeyOfState,
  parseOtsVerificationKey,
  type OtsState,
  type OtsStateTone,
  type OtsVerificationKey,
} from "@proovra/shared";

/** Stored OTS column values (old and new) folded onto a lifecycle state. */
const STORED_STATUS_STATE: Readonly<Record<string, OtsState>> = {
  NOT_REQUESTED: "NOT_REQUESTED",
  DISABLED: "NOT_REQUESTED",
  PENDING: "PENDING",
  QUEUED: "PENDING",
  UPGRADING: "PENDING",
  SUBMITTED: "PENDING",
  ANCHORED: "ANCHORED",
  // Legacy column values that once read as success: a stored status never
  // proves a chain check, so they are an attestation recorded at most.
  OK: "ANCHORED",
  VERIFIED: "ANCHORED",
  FAILED: "FAILED",
  ERRORED: "FAILED",
  ERROR: "FAILED",
  ABANDONED: "FAILED",
  UNAVAILABLE: "UNAVAILABLE",
};

/**
 * The verification key a bare string stands for. A canonical verification key
 * is taken as sent; a stored lifecycle status maps through its state; anything
 * else reads as UNAVAILABLE (never a success).
 */
export function otsVerificationKeyOfRaw(raw: string | null | undefined): OtsVerificationKey {
  const value = String(raw ?? "").trim().toUpperCase();
  const key = parseOtsVerificationKey(value);
  if (key) return key;
  const state = STORED_STATUS_STATE[value];
  return state ? otsVerificationKeyOfState(state) : "UNAVAILABLE";
}

/** The label and tone a bare OTS status is shown with (admin badges). */
export function otsRawStatusPresentation(raw: string | null | undefined): {
  verification: OtsVerificationKey;
  word: string;
  label: string;
  tone: OtsStateTone;
} {
  const verification = otsVerificationKeyOfRaw(raw);
  return {
    verification,
    word: OTS_VERIFICATION_WORDS[verification],
    label: OTS_VERIFICATION_LABELS[verification],
    tone: OTS_VERIFICATION_TONES[verification],
  };
}

/**
 * The human words for an OTS filter value (single or comma-separated stored
 * statuses, e.g. "PENDING,UPGRADING,QUEUED"). Values that fold onto the same
 * state are said once; a raw code is never shown.
 */
export function otsFilterValueLabel(raw: string): string {
  const words: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    const upper = value.toUpperCase();
    const key = parseOtsVerificationKey(upper);
    const state = STORED_STATUS_STATE[upper];
    const word = key
      ? OTS_VERIFICATION_WORDS[key]
      : state
        ? OTS_STATE_WORDS[state]
        : humaniseCode(upper);
    if (!words.includes(word)) words.push(word);
  }
  return words.join(" / ");
}

/** An unrecognised code in words ("SOME_CODE" → "Some code"). */
export function humaniseCode(raw: string): string {
  return raw
    .trim()
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}
