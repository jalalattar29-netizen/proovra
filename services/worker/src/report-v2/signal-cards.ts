/**
 * THE REPORT'S EIGHT EVIDENCE SIGNALS (2026-10-13).
 *
 * Trust Signal Analysis states the evidence record's own verification layers —
 * core integrity, digital signature, trusted timestamp, Bitcoin anchoring,
 * immutable storage, custody chain, account authentication and verification
 * package — one compact card each. Every status comes from the canonical
 * trust-decision state of that signal (and, for anchoring, from the canonical
 * OpenTimestamps state, ots-anchoring.ts; for account authentication, from
 * the canonical verification matrix's account row, built from the
 * submission-time identity snapshot); this module only chooses the words.
 * "Verified" is printed for a PASSED / VERIFIED state and nothing else;
 * Bitcoin anchoring says "Anchored" for a proof that resolves to ANCHORED.
 *
 * ONE VISUAL VOCABULARY (2026-10-14): the mark follows the tone, never the
 * other way round —
 *   success  ✓  positively verified
 *   neutral  i  recorded, not applicable or limited (never a failure look)
 *   warning  !  degraded, incomplete or needing attention
 *   danger   ×  failed verification
 */
import {
  isAccountAuthenticationVerified,
  presentOtsAnchoring,
  type TrustSignal,
  type TrustSignalKey,
  type VerificationMatrixRow,
} from "@proovra/shared";

import type { ReportViewModel } from "./types.js";

export type SignalCardTone = "success" | "danger" | "warning" | "neutral";

export const SIGNAL_CARD_MARK: Readonly<Record<SignalCardTone, "✓" | "i" | "!" | "×">> = {
  success: "✓",
  neutral: "i",
  warning: "!",
  danger: "×",
};

export type SignalCard = {
  key: TrustSignalKey;
  label: string;
  /** The status word beside the label (Verified, Recorded, Pending, …). */
  status: string;
  mark: (typeof SIGNAL_CARD_MARK)[SignalCardTone];
  tone: SignalCardTone;
  /** The card's headline. */
  title: string;
  /** One concise supporting sentence. */
  sentence: string;
};

function toned(tone: SignalCardTone): Pick<SignalCard, "tone" | "mark"> {
  return { tone, mark: SIGNAL_CARD_MARK[tone] };
}

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
  identity: "Account authentication",
  verification_package: "Verification package",
};

function verified(key: TrustSignalKey, title: string, sentence: string): SignalCard {
  return { key, label: LABELS[key], status: "Verified", ...toned("success"), title, sentence };
}

/** A state that is not a pass: never green, never a check mark. */
function notPassed(signal: TrustSignal, status: string, title = signal.summary, sentence = firstSentence(signal.detail)): SignalCard {
  const tone: SignalCardTone =
    signal.state === "FAILED" ? "danger" : signal.state === "PENDING" || signal.state === "STALE" ? "warning" : "neutral";
  return { key: signal.key, label: LABELS[signal.key], status, ...toned(tone), title, sentence };
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

function matrixRow(vm: ReportViewModel, key: VerificationMatrixRow["key"]): VerificationMatrixRow | undefined {
  return vm.verificationMatrix.rows.find((row) => row.key === key);
}

const PROVIDER_ACCOUNT: Readonly<Record<string, string>> = {
  EMAIL: "email account",
  GOOGLE: "Google account",
  APPLE: "Apple account",
};

/**
 * ACCOUNT AUTHENTICATION (2026-10-14). The status is the canonical matrix's
 * account row, built from the submission-time identity snapshot (custody
 * IDENTITY_SNAPSHOT_RECORDED), never from the account's current profile:
 * VERIFIED — green, "Verified" — only when that snapshot ties the submission
 * to an authenticated account whose verification it recorded and that is
 * internally consistent (verification-matrix identityRows). Anything else is
 * a neutral "Recorded" / "Not recorded" fact. The words describe the account
 * context only: never a real-world, government, organization or OAuth claim
 * the snapshot does not hold.
 */
function identityCard(vm: ReportViewModel): SignalCard {
  const base = { key: "identity" as const, label: LABELS.identity };
  const row = matrixRow(vm, "account_identity");
  const s = vm.acquisitionIdentity;
  const provider = (s?.authProvider ?? "").toUpperCase();
  const account = PROVIDER_ACCOUNT[provider] ?? "account";
  if (isAccountAuthenticationVerified(s)) {
    const organization = matrixRow(vm, "organization_verification")?.status === "VERIFIED";
    return {
      ...base,
      status: "Verified",
      ...toned("success"),
      title: `Authenticated ${account} recorded at submission`,
      sentence: organization
        ? "Organization verification was also recorded at submission; this verifies the account and organization context, not the person's real-world identity."
        : "This verifies the account context, not the person's real-world identity.",
    };
  }
  if (!row || row.status === "UNAVAILABLE" || !s || s.basis === "UNAVAILABLE") {
    return {
      ...base,
      status: "Not recorded",
      ...toned("neutral"),
      title: "Account context not recorded",
      sentence: "No submission-time account snapshot is available for this record.",
    };
  }
  const recorded = (title: string, sentence: string): SignalCard => ({ ...base, status: "Recorded", ...toned("neutral"), title, sentence });
  if (s.actorKind === "INTAKE_CONTRIBUTOR") {
    return recorded("Submitted through a secure intake link", "The contributor's identity was not verified.");
  }
  if (s.actorKind === "GUEST_SESSION") {
    return recorded("Guest session recorded at submission", "No verified account was used for this submission.");
  }
  if (s.basis !== "OBSERVED_AT_CAPTURE") {
    return recorded(
      `${account.charAt(0).toUpperCase()}${account.slice(1)} recorded on the record`,
      "It is not bound to the submission time, so it is not shown as verified.",
    );
  }
  if (provider === "EMAIL" && (s.emailVerified === false || s.identityLevel === "BASIC_ACCOUNT")) {
    return recorded("Email account recorded at submission", "Its email address was not verified at submission.");
  }
  return recorded(
    `${account.charAt(0).toUpperCase()}${account.slice(1)} recorded at submission`,
    "The recorded account facts do not establish that it was verified at submission.",
  );
}

/**
 * THE PAIRED VERIFICATION PACKAGE (2026-10-14). The package of report vN is
 * built AFTER this PDF is rendered and committed — it embeds these exact
 * bytes and its seal covers them — so the PDF cannot have verified it (doing
 * so would be circular). The card states only the pairing the generator
 * decided before rendering, as a neutral fact: the package for THIS report
 * version (verificationPackageVersion = the report's version), or that none
 * is issued with this version. It never attests to the package's existence,
 * completeness or seal; those are checked from the package itself.
 */
function packageCard(vm: ReportViewModel): SignalCard {
  const base = { key: "verification_package" as const, label: LABELS.verification_package, ...toned("neutral") };
  const pkg = vm.verificationPackageIntegrity.version;
  if (pkg === vm.version) {
    return {
      ...base,
      status: "Paired",
      title: `Verification package v${vm.version} is produced after this report`,
      sentence: "This report cannot verify a package sealed after it; check the package's seal with the commands in its README.",
    };
  }
  return {
    ...base,
    status: "Not included",
    title: `No verification package is issued with report v${vm.version}`,
    sentence:
      pkg != null
        ? "An earlier verification package does not cover this report version."
        : "The integrity materials are assessed individually in this report.",
  };
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
      // "Bitcoin anchoring": the canonical state word and its one sentence.
      const p = presentOtsAnchoring({ state: vm.canonicalMaterials.otsState.state });
      return {
        key: signal.key,
        label: LABELS[signal.key],
        status: p.status,
        ...toned(p.tone === "success" ? "success" : p.tone === "danger" ? "danger" : "neutral"),
        title: p.label,
        sentence: p.sentence,
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
    case "identity":
      return identityCard(vm);
    case "verification_package":
      return packageCard(vm);
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
