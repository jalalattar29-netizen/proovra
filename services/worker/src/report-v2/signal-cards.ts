/**
 * THE REPORT'S EIGHT EVIDENCE SIGNALS (2026-10-13).
 *
 * Trust Signal Analysis states the evidence record's own verification layers —
 * core integrity, digital signature, trusted timestamp, Bitcoin anchoring,
 * immutable storage, custody chain, workspace identity and verification
 * package — one compact card each. Every status comes from the canonical
 * trust-decision state of that signal (and, for anchoring, from the OTS truth
 * model); this module only chooses the words. "Verified" is printed for a
 * PASSED state and nothing else.
 */
import {
  OTS_TRUTH_SENTENCES,
  presentOtsTruth,
  type TrustSignal,
  type TrustSignalKey,
} from "@proovra/shared";

import type { ReportViewModel } from "./types.js";

export type SignalCardTone = "success" | "danger" | "warning" | "neutral";

export type SignalCard = {
  key: TrustSignalKey;
  label: string;
  /** The status word beside the label (Verified, Recorded, Pending, …). */
  status: string;
  mark: "✓" | "!" | "i";
  tone: SignalCardTone;
  /** The card's headline. */
  title: string;
  /** One concise supporting sentence. */
  sentence: string;
};

/** The original eight, in their original order. */
export const SIGNAL_CARD_ORDER: readonly TrustSignalKey[] = [
  "core_integrity",
  "signature",
  "trusted_timestamp",
  "bitcoin_anchoring",
  "immutable_storage",
  "custody_chain",
  "identity",
  "verification_package",
];

const LABELS: Readonly<Record<TrustSignalKey, string>> = {
  core_integrity: "Core integrity",
  signature: "Digital signature",
  trusted_timestamp: "Trusted timestamp",
  bitcoin_anchoring: "Bitcoin anchoring",
  immutable_storage: "Immutable storage",
  custody_chain: "Custody chain",
  identity: "Workspace identity",
  verification_package: "Verification package",
};

function verified(key: TrustSignalKey, title: string, sentence: string): SignalCard {
  return { key, label: LABELS[key], status: "Verified", mark: "✓", tone: "success", title, sentence };
}

/** A state that is not a pass: never green, never a check mark. */
function notPassed(signal: TrustSignal, status: string, title = signal.summary, sentence = firstSentence(signal.detail)): SignalCard {
  const failed = signal.state === "FAILED";
  return {
    key: signal.key,
    label: LABELS[signal.key],
    status,
    mark: failed ? "!" : "i",
    tone: failed ? "danger" : signal.state === "PENDING" || signal.state === "STALE" ? "warning" : "neutral",
    title,
    sentence,
  };
}

function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

const STATE_WORD: Readonly<Record<TrustSignal["state"], string>> = {
  PASSED: "Verified",
  FAILED: "Failed",
  PRESENT_NOT_INDEPENDENTLY_VERIFIED: "Recorded",
  NOT_CHECKED: "Recorded",
  PENDING: "Pending",
  STALE: "Unavailable",
  UNAVAILABLE: "Unavailable",
  NOT_APPLICABLE: "Not applicable",
};

function findRow(rows: ReadonlyArray<{ label: string; value: string }>, label: string): string {
  return rows.find((row) => row.label === label)?.value?.trim() ?? "";
}

function card(signal: TrustSignal, vm: ReportViewModel): SignalCard {
  const word = STATE_WORD[signal.state];
  switch (signal.key) {
    case "core_integrity":
      return signal.state === "PASSED"
        ? verified(signal.key, "Core integrity verified", "The recorded digests, canonical fingerprint and signed references agree for the preserved files.")
        : notPassed(signal, word);
    case "signature":
      return signal.state === "PASSED"
        ? verified(signal.key, "Record signature verified", "The Ed25519 signature verifies against the canonical fingerprint with the registered public key.")
        : notPassed(signal, word);
    case "trusted_timestamp":
      return signal.state === "PASSED"
        ? verified(signal.key, "RFC 3161 timestamp verified", "The token, its message imprint and its certificate chain were validated.")
        : notPassed(signal, word);
    case "bitcoin_anchoring": {
      // The OpenTimestamps card: the truth model's public word and sentence.
      const ots = vm.canonicalMaterials.otsState;
      const presentation = presentOtsTruth({
        state: ots.truthState,
        proofRecordedAtUtc: ots.proofRecordedAtUtc ?? null,
        chain: ots.chainVerification ?? null,
      });
      if (presentation.status === "Verified" && signal.state === "PASSED") {
        return verified(signal.key, "OpenTimestamps Bitcoin anchoring verified", OTS_TRUTH_SENTENCES.CHAIN_VERIFIED);
      }
      // "Verified" needs both the truth model and the signal; anything less is
      // never printed as verified.
      const status = presentation.status === "Verified" ? "Attestation recorded" : presentation.status;
      return {
        key: signal.key,
        label: LABELS[signal.key],
        status,
        mark: "i",
        tone: status === "Pending" ? "warning" : "neutral",
        title: `OpenTimestamps ${status.toLowerCase()}`,
        sentence: presentation.status === "Verified" ? OTS_TRUTH_SENTENCES.ATTESTATION_PRESENT_NOT_VERIFIED : presentation.sentence,
      };
    }
    case "immutable_storage":
      return signal.state === "PASSED"
        ? verified(signal.key, "Immutable retention verified", "The stored object is held under Object Lock COMPLIANCE retention with a recorded retain-until date.")
        : notPassed(signal, word);
    case "custody_chain":
      return signal.state === "PASSED"
        ? verified(signal.key, signal.summary, "Every custody event hash was recomputed and matched in chain order.")
        : notPassed(signal, word);
    case "identity": {
      // The recorded account context only — never an organization, OAuth or
      // verified-person claim the record does not hold.
      const level = findRow(vm.reviewReadinessRows, "Identity Level");
      const workspace = findRow(vm.reviewReadinessRows, "Workspace Type").toLowerCase();
      if (signal.state === "UNAVAILABLE") return notPassed(signal, "Unavailable");
      const title = level && !/^not recorded$/i.test(level) ? `${level} recorded` : signal.summary;
      return {
        key: signal.key,
        label: LABELS[signal.key],
        status: signal.state === "PASSED" ? "Verified" : "Recorded",
        mark: signal.state === "PASSED" ? "✓" : "i",
        tone: "neutral",
        title,
        sentence: `Recorded at submission${workspace ? ` in a ${workspace}` : ""}; the person's real-world identity was not established.`,
      };
    }
    case "verification_package":
      // The paired package is sealed after this report is rendered, so the
      // report never claims a package check — only the pairing.
      return {
        key: signal.key,
        label: LABELS[signal.key],
        status: "Paired",
        mark: "i",
        tone: "neutral",
        title: `Verification package v${vm.version} paired with this report`,
        sentence: "It carries the complete custody chain, proofs and hashes; check its seal with the commands in its README.",
      };
    default:
      return notPassed(signal, word);
  }
}

/** The eight evidence signal cards, in the original order. */
export function buildSignalCards(vm: ReportViewModel): SignalCard[] {
  const byKey = new Map(vm.trustDecision.signals.map((s) => [s.key, s]));
  return SIGNAL_CARD_ORDER.flatMap((key) => {
    const signal = byKey.get(key);
    return signal ? [card(signal, vm)] : [];
  });
}
