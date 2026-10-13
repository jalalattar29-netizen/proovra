/**
 * THE OPENTIMESTAMPS ANCHORING STATE — the ONE authority (2026-10-13).
 *
 * PROOVRA's evidentiary trust rests on SHA-256 integrity, signatures, RFC 3161
 * timestamps, the custody hash chain, immutable storage and the verification
 * package. OpenTimestamps adds a public Bitcoin anchor on top of that, and its
 * state is decided here — from the stored proof's own bytes, executed against
 * the record's canonical evidence digest (ots-proof.ts) — and nowhere else.
 * Worker, API, report, verification package, Public Verify, web and mobile all
 * carry the state this resolves; none re-derives it from a txid, a block
 * height, a timestamp or a status string.
 *
 *   NOT_REQUESTED  anchoring was not requested (or is disabled) for the record
 *   PENDING        the digest is at one or more calendars; the stored proof
 *                  carries no valid Bitcoin block attestation yet
 *   ANCHORED       the stored proof parses, commits from the record's digest
 *                  through its executed operations to a valid Bitcoin
 *                  block-header attestation — "Bitcoin anchoring — Anchored"
 *   FAILED         a genuine terminal defect (malformed proof, digest
 *                  mismatch, unsupported operation, invalid attestation,
 *                  exhausted upgrade attempts), with a bounded code
 *   UNAVAILABLE    the record references proof material that cannot currently
 *                  be read (missing bytes, no digest to bind them to)
 *
 * ANCHORED makes no claim that PROOVRA operates a Bitcoin node or selected the
 * canonical chain; the package tells a reviewer how to check the proof against
 * a node of their own (OTS_ANCHORED_BOUNDARY).
 */
import { boundedOtsFailureCode, normalizeOtsStatusValue } from "./ots.js";
import { checkOtsDigestBinding, otsProofSha256Hex, OTS_PROOF_VALIDATOR } from "./ots-proof.js";

export const OTS_STATES = ["NOT_REQUESTED", "PENDING", "ANCHORED", "FAILED", "UNAVAILABLE"] as const;
export type OtsState = (typeof OTS_STATES)[number];

/** A state a server sent. Anything else — including a future value — reads as UNAVAILABLE, never anchored. */
export function parseOtsState(value: unknown): OtsState {
  return typeof value === "string" && (OTS_STATES as readonly string[]).includes(value) ? (value as OtsState) : "UNAVAILABLE";
}

/** Proof-integrity failures: no report or package is published from such a proof. */
export const OTS_PROOF_INTEGRITY_FAILURES = [
  "MALFORMED_PROOF",
  "PROOF_HASH_MISMATCH",
  "UNSUPPORTED_PROOF_OPERATION",
  "INVALID_ATTESTATION",
] as const;
export type OtsProofIntegrityFailure = (typeof OTS_PROOF_INTEGRITY_FAILURES)[number];

/** Why proof material is unavailable. */
export const OTS_UNAVAILABLE_CODES = ["PROOF_MATERIAL_MISSING", "FINGERPRINT_MISSING"] as const;
export type OtsUnavailableCode = (typeof OTS_UNAVAILABLE_CODES)[number];

export type OtsAnchoringInput = {
  /** evidence.ots_status as stored (PENDING | ANCHORED | FAILED | DISABLED | null). */
  status: string | null | undefined;
  /** evidence.ots_proof_base64 — the stored proof bytes, or null. */
  proofBase64: string | null | undefined;
  /** evidence.fingerprint_hash — the canonical digest the proof must commit to. */
  fingerprintHash: string | null | undefined;
  /** evidence.ots_hash — the digest the record says was stamped. */
  otsHash?: string | null;
  /** evidence.ots_failure_reason (bounded on read). */
  failureReason?: string | null;
  calendar?: string | null;
  /** When the digest was submitted (the first OTS custody event), when known. */
  submittedAtUtc?: Date | string | null;
  /** When PROOVRA recorded the anchor (evidence.ots_anchored_at_utc). */
  anchoredAtUtc?: Date | string | null;
  /** When PROOVRA last upgraded the proof (evidence.ots_upgraded_at_utc). */
  upgradedAtUtc?: Date | string | null;
};

export type OtsAnchoring = {
  state: OtsState;
  /** Bounded failure or unavailability code; null otherwise. */
  failureCode: string | null;
  /** The digest the proof commits to (the record's fingerprint digest when bound). */
  committedDigestHex: string | null;
  /** SHA-256 of the stored proof bytes — the proof's identity. */
  proofSha256: string | null;
  attestationType: "BITCOIN_BLOCK_HEADER" | "PENDING_CALENDAR" | null;
  /** The lowest block height among the valid Bitcoin attestations (from the proof). */
  bitcoinBlockHeight: number | null;
  /** Only when the executed proof path derives it. */
  bitcoinTxid: string | null;
  /** The merkle root the proof path produces for that attestation. */
  merkleRootHex: string | null;
  pendingCalendars: string[];
  calendar: string | null;
  submittedAtUtc: string | null;
  /** When PROOVRA recorded ANCHORED — a recording time, not a Bitcoin block time. */
  anchoredAtUtc: string | null;
  /** The executor that decided this state. */
  validator: string;
};

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

/** THE resolver. Pure, deterministic, and the same in every runtime. */
export function resolveOtsAnchoring(input: OtsAnchoringInput): OtsAnchoring {
  const status = normalizeOtsStatusValue(input.status);
  const proof = typeof input.proofBase64 === "string" ? input.proofBase64.trim() : "";
  const base: OtsAnchoring = {
    state: "NOT_REQUESTED",
    failureCode: null,
    committedDigestHex: null,
    proofSha256: null,
    attestationType: null,
    bitcoinBlockHeight: null,
    bitcoinTxid: null,
    merkleRootHex: null,
    pendingCalendars: [],
    calendar: input.calendar?.trim() || null,
    submittedAtUtc: iso(input.submittedAtUtc),
    anchoredAtUtc: null,
    validator: OTS_PROOF_VALIDATOR,
  };

  if (status === "DISABLED") return base;

  if (!proof) {
    if (status === "PENDING" || status === "ANCHORED") {
      return { ...base, state: "UNAVAILABLE", failureCode: "PROOF_MATERIAL_MISSING" };
    }
    if (status === "FAILED") {
      return { ...base, state: "FAILED", failureCode: boundedOtsFailureCode(input.failureReason) ?? "OTS_PROCESSING_FAILED" };
    }
    return base;
  }

  let proofSha256: string | null = null;
  try {
    proofSha256 = otsProofSha256Hex(proof);
  } catch {
    return { ...base, state: "FAILED", failureCode: "MALFORMED_PROOF" };
  }
  const withProof = { ...base, proofSha256 };
  const binding = checkOtsDigestBinding({
    proofBase64: proof,
    fingerprintHash: input.fingerprintHash,
    otsHash: input.otsHash ?? null,
  });
  if (binding.kind === "UNREADABLE") {
    return binding.code === "NO_FINGERPRINT"
      ? { ...withProof, state: "UNAVAILABLE", failureCode: "FINGERPRINT_MISSING" }
      : { ...withProof, state: "FAILED", failureCode: "MALFORMED_PROOF" };
  }
  if (binding.kind === "MISMATCH") {
    return { ...withProof, state: "FAILED", failureCode: "PROOF_HASH_MISMATCH", committedDigestHex: binding.committedDigestHex };
  }
  if (binding.kind !== "MATCH") return base;
  const bound = { ...withProof, committedDigestHex: binding.committedDigestHex, pendingCalendars: binding.pendingCalendars };

  const anchor = [...binding.bitcoinAttestations].sort((a, b) => a.blockHeight - b.blockHeight)[0];
  if (anchor) {
    return {
      ...bound,
      state: "ANCHORED",
      attestationType: "BITCOIN_BLOCK_HEADER",
      bitcoinBlockHeight: anchor.blockHeight,
      // The txid of THIS attestation's path only — never one from another branch.
      bitcoinTxid: anchor.bitcoinTxid ?? null,
      merkleRootHex: anchor.merkleRootHex,
      anchoredAtUtc: iso(input.anchoredAtUtc) ?? iso(input.upgradedAtUtc),
    };
  }
  if (binding.invalidBitcoinAttestations > 0) return { ...bound, state: "FAILED", failureCode: "INVALID_ATTESTATION" };
  if (binding.unexecutedBitcoinAttestations > 0) return { ...bound, state: "FAILED", failureCode: "UNSUPPORTED_PROOF_OPERATION" };
  if (status === "FAILED") {
    return { ...bound, state: "FAILED", failureCode: boundedOtsFailureCode(input.failureReason) ?? "OTS_PROCESSING_FAILED" };
  }
  return { ...bound, state: "PENDING", attestationType: binding.pendingCalendars.length ? "PENDING_CALENDAR" : null };
}

/** The columns `resolveRecordOtsAnchoring` reads from an evidence row. */
export const OTS_ANCHORING_RECORD_SELECT = {
  otsStatus: true,
  otsProofBase64: true,
  otsHash: true,
  fingerprintHash: true,
  otsFailureReason: true,
  otsCalendar: true,
  otsAnchoredAtUtc: true,
  otsUpgradedAtUtc: true,
} as const;

export type OtsAnchoringRecord = {
  otsStatus?: string | null;
  otsProofBase64?: string | null;
  otsHash?: string | null;
  fingerprintHash?: string | null;
  otsFailureReason?: string | null;
  otsCalendar?: string | null;
  otsAnchoredAtUtc?: Date | string | null;
  otsUpgradedAtUtc?: Date | string | null;
};

/** The same resolver over an evidence row's stored OTS columns. */
export function resolveRecordOtsAnchoring(row: OtsAnchoringRecord, opts: { submittedAtUtc?: Date | string | null } = {}): OtsAnchoring {
  return resolveOtsAnchoring({
    status: row.otsStatus ?? null,
    proofBase64: row.otsProofBase64 ?? null,
    fingerprintHash: row.fingerprintHash ?? null,
    otsHash: row.otsHash ?? null,
    failureReason: row.otsFailureReason ?? null,
    calendar: row.otsCalendar ?? null,
    anchoredAtUtc: row.otsAnchoredAtUtc ?? null,
    upgradedAtUtc: row.otsUpgradedAtUtc ?? null,
    submittedAtUtc: opts.submittedAtUtc ?? null,
  });
}

/** A proof-integrity failure refuses publication; pending, unavailable or an exhausted budget do not. */
export function otsBlocksPublication(a: Pick<OtsAnchoring, "state" | "failureCode">): boolean {
  return a.state === "FAILED" && (OTS_PROOF_INTEGRITY_FAILURES as readonly string[]).includes(String(a.failureCode));
}

// ---------------------------------------------------------------------------
// THE WORDS — every surface prints these (English; i18n carries de/ar).
// ---------------------------------------------------------------------------

/** The status word beside "Bitcoin anchoring". */
export const OTS_STATE_WORDS: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Pending",
  ANCHORED: "Anchored",
  FAILED: "Failed",
  UNAVAILABLE: "Unavailable",
};

/** The standalone label (badges, lists, Public Verify). */
export const OTS_STATE_LABELS: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "Not requested",
  PENDING: "Bitcoin anchoring pending",
  ANCHORED: "Bitcoin anchored",
  FAILED: "Bitcoin anchoring failed",
  UNAVAILABLE: "Bitcoin anchoring unavailable",
};

/** The one concise sentence. */
export const OTS_STATE_SENTENCES: Readonly<Record<OtsState, string>> = {
  NOT_REQUESTED: "No OpenTimestamps anchoring was requested for this record.",
  PENDING: "OpenTimestamps proof is awaiting Bitcoin anchoring.",
  ANCHORED: "OpenTimestamps proof anchored in Bitcoin.",
  FAILED: "Bitcoin anchoring did not complete for this record.",
  UNAVAILABLE: "The OpenTimestamps proof material cannot currently be read.",
};

export type OtsStateTone = "success" | "neutral" | "danger";
export const OTS_STATE_TONES: Readonly<Record<OtsState, OtsStateTone>> = {
  NOT_REQUESTED: "neutral",
  PENDING: "neutral",
  ANCHORED: "success",
  FAILED: "danger",
  UNAVAILABLE: "neutral",
};

/** Stated once, in technical material, for ANCHORED. */
export const OTS_ANCHORED_BOUNDARY =
  "The stored OpenTimestamps proof cryptographically commits the recorded evidence digest to a Bitcoin block attestation. PROOVRA does not claim independent canonical-chain verification through a PROOVRA-operated Bitcoin node.";

/** Bounded failure/unavailability codes in words. */
export const OTS_FAILURE_LABELS: Readonly<Record<string, string>> = {
  MALFORMED_PROOF: "The OpenTimestamps proof could not be read.",
  PROOF_HASH_MISMATCH: "The OpenTimestamps proof does not commit to this record's evidence digest.",
  UNSUPPORTED_PROOF_OPERATION: "The OpenTimestamps proof uses an operation PROOVRA does not execute.",
  INVALID_ATTESTATION: "The OpenTimestamps proof carries a malformed Bitcoin attestation.",
  OTS_GLOBAL_BUDGET_EXHAUSTED: "The proof did not anchor in Bitcoin within the upgrade budget.",
  OTS_PROCESSING_FAILED: "OpenTimestamps processing did not complete for this record.",
  PROOF_MATERIAL_MISSING: "The stored OpenTimestamps proof is missing.",
  FINGERPRINT_MISSING: "The record has no evidence digest to bind the proof to.",
};

/** The presentation a surface renders: label, status word, sentence and tone. */
export function presentOtsAnchoring(a: Pick<OtsAnchoring, "state">): {
  state: OtsState;
  title: "Bitcoin anchoring";
  status: string;
  label: string;
  sentence: string;
  tone: OtsStateTone;
} {
  const state = parseOtsState(a.state);
  return {
    state,
    title: "Bitcoin anchoring",
    status: OTS_STATE_WORDS[state],
    label: OTS_STATE_LABELS[state],
    sentence: OTS_STATE_SENTENCES[state],
    tone: OTS_STATE_TONES[state],
  };
}

// ---------------------------------------------------------------------------
// THE WIRE CONTRACT — what the API sends and every client reads.
// ---------------------------------------------------------------------------

/**
 * `otsAnchoring` on every API response that states OpenTimestamps. Clients
 * render `state` through the words below (or `readOtsAnchoringView`); they
 * never re-derive it from the other fields. No storage key, URL or credential.
 */
export type OtsAnchoringView = {
  state: OtsState;
  title: "Bitcoin anchoring";
  status: string;
  label: string;
  sentence: string;
  tone: OtsStateTone;
  failureCode: string | null;
  failureLabel: string | null;
  committedDigestHex: string | null;
  proofSha256: string | null;
  attestationType: "BITCOIN_BLOCK_HEADER" | "PENDING_CALENDAR" | null;
  bitcoinBlockHeight: number | null;
  bitcoinTxid: string | null;
  submittedAtUtc: string | null;
  anchoredAtUtc: string | null;
  validator: string | null;
};

export function toOtsAnchoringView(a: OtsAnchoring): OtsAnchoringView {
  const anchored = a.state === "ANCHORED";
  return {
    ...presentOtsAnchoring(a),
    failureCode: a.failureCode,
    failureLabel: a.failureCode ? (OTS_FAILURE_LABELS[a.failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED!) : null,
    committedDigestHex: a.committedDigestHex,
    proofSha256: a.proofSha256,
    attestationType: a.attestationType,
    bitcoinBlockHeight: anchored ? a.bitcoinBlockHeight : null,
    bitcoinTxid: anchored ? a.bitcoinTxid : null,
    submittedAtUtc: a.submittedAtUtc,
    anchoredAtUtc: anchored ? a.anchoredAtUtc : null,
    validator: a.validator,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Read an `otsAnchoring` a server sent. A missing object, or a state this
 * client does not know, reads as UNAVAILABLE; the words always come from this
 * client's own table for the state, never from the payload.
 */
export function readOtsAnchoringView(value: unknown): OtsAnchoringView {
  const o = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const state = parseOtsState(o.state);
  const anchored = state === "ANCHORED";
  const failureCode = state === "FAILED" || state === "UNAVAILABLE" ? str(o.failureCode) : null;
  const attestation = o.attestationType === "BITCOIN_BLOCK_HEADER" || o.attestationType === "PENDING_CALENDAR" ? o.attestationType : null;
  return {
    ...presentOtsAnchoring({ state }),
    failureCode,
    failureLabel: failureCode ? (OTS_FAILURE_LABELS[failureCode] ?? OTS_FAILURE_LABELS.OTS_PROCESSING_FAILED!) : null,
    committedDigestHex: str(o.committedDigestHex),
    proofSha256: str(o.proofSha256),
    attestationType: attestation,
    bitcoinBlockHeight: anchored ? num(o.bitcoinBlockHeight) : null,
    bitcoinTxid: anchored ? str(o.bitcoinTxid) : null,
    submittedAtUtc: str(o.submittedAtUtc),
    anchoredAtUtc: anchored ? str(o.anchoredAtUtc) : null,
    validator: str(o.validator),
  };
}

// ---------------------------------------------------------------------------
// LOCALIZED COPY (en / de / ar) — the same concepts on every surface.
// ---------------------------------------------------------------------------

export type OtsCopyLocale = "en" | "de" | "ar";

export type OtsAnchoringCopy = {
  title: string;
  words: Readonly<Record<OtsState, string>>;
  labels: Readonly<Record<OtsState, string>>;
  sentences: Readonly<Record<OtsState, string>>;
  boundary: string;
  facts: {
    digest: string;
    proofSha256: string;
    attestationType: string;
    blockHeight: string;
    txid: string;
    submittedAt: string;
    anchoredAt: string;
    validator: string;
  };
  attestationTypes: { BITCOIN_BLOCK_HEADER: string; PENDING_CALENDAR: string };
  /** Bounded failure / unavailability codes in words (OTS_FAILURE_LABELS keys). */
  failureLabels: Readonly<Record<string, string>>;
};

export const OTS_ANCHORING_COPY: Readonly<Record<OtsCopyLocale, OtsAnchoringCopy>> = {
  en: {
    title: "Bitcoin anchoring",
    words: OTS_STATE_WORDS,
    labels: OTS_STATE_LABELS,
    sentences: OTS_STATE_SENTENCES,
    boundary: OTS_ANCHORED_BOUNDARY,
    facts: {
      digest: "Evidence digest (SHA-256)",
      proofSha256: "Proof SHA-256",
      attestationType: "Attestation type",
      blockHeight: "Bitcoin block height",
      txid: "Bitcoin transaction",
      submittedAt: "Submitted (UTC)",
      anchoredAt: "Anchoring recorded by PROOVRA (UTC)",
      validator: "Proof validator",
    },
    attestationTypes: { BITCOIN_BLOCK_HEADER: "Bitcoin block header", PENDING_CALENDAR: "Pending calendar" },
    failureLabels: OTS_FAILURE_LABELS,
  },
  de: {
    title: "Bitcoin-Verankerung",
    words: {
      NOT_REQUESTED: "Nicht angefordert",
      PENDING: "Ausstehend",
      ANCHORED: "Verankert",
      FAILED: "Fehlgeschlagen",
      UNAVAILABLE: "Nicht verfügbar",
    },
    labels: {
      NOT_REQUESTED: "Nicht angefordert",
      PENDING: "Bitcoin-Verankerung ausstehend",
      ANCHORED: "In Bitcoin verankert",
      FAILED: "Bitcoin-Verankerung fehlgeschlagen",
      UNAVAILABLE: "Bitcoin-Verankerung nicht verfügbar",
    },
    sentences: {
      NOT_REQUESTED: "Für diesen Datensatz wurde keine OpenTimestamps-Verankerung angefordert.",
      PENDING: "Der OpenTimestamps-Nachweis wartet auf die Bitcoin-Verankerung.",
      ANCHORED: "OpenTimestamps-Nachweis in Bitcoin verankert.",
      FAILED: "Die Bitcoin-Verankerung wurde für diesen Datensatz nicht abgeschlossen.",
      UNAVAILABLE: "Das OpenTimestamps-Nachweismaterial kann derzeit nicht gelesen werden.",
    },
    boundary:
      "Der gespeicherte OpenTimestamps-Nachweis bindet den erfassten Beweis-Digest kryptografisch an eine Bitcoin-Blockattestierung. PROOVRA beansprucht keine unabhängige Prüfung der kanonischen Kette über einen von PROOVRA betriebenen Bitcoin-Knoten.",
    facts: {
      digest: "Beweis-Digest (SHA-256)",
      proofSha256: "Nachweis-SHA-256",
      attestationType: "Attestierungstyp",
      blockHeight: "Bitcoin-Blockhöhe",
      txid: "Bitcoin-Transaktion",
      submittedAt: "Eingereicht (UTC)",
      anchoredAt: "Verankerung von PROOVRA erfasst (UTC)",
      validator: "Nachweis-Validator",
    },
    attestationTypes: { BITCOIN_BLOCK_HEADER: "Bitcoin-Blockheader", PENDING_CALENDAR: "Ausstehender Kalender" },
    failureLabels: {
      MALFORMED_PROOF: "Der OpenTimestamps-Nachweis konnte nicht gelesen werden.",
      PROOF_HASH_MISMATCH: "Der OpenTimestamps-Nachweis bindet nicht den Beweis-Digest dieses Datensatzes.",
      UNSUPPORTED_PROOF_OPERATION: "Der OpenTimestamps-Nachweis verwendet eine Operation, die PROOVRA nicht ausführt.",
      INVALID_ATTESTATION: "Der OpenTimestamps-Nachweis enthält eine fehlerhafte Bitcoin-Attestierung.",
      OTS_GLOBAL_BUDGET_EXHAUSTED: "Der Nachweis wurde innerhalb des Aktualisierungsbudgets nicht in Bitcoin verankert.",
      OTS_PROCESSING_FAILED: "Die OpenTimestamps-Verarbeitung wurde für diesen Datensatz nicht abgeschlossen.",
      PROOF_MATERIAL_MISSING: "Der gespeicherte OpenTimestamps-Nachweis fehlt.",
      FINGERPRINT_MISSING: "Der Datensatz hat keinen Beweis-Digest, an den der Nachweis gebunden werden kann.",
    },
  },
  ar: {
    title: "الترسيخ في بيتكوين",
    words: {
      NOT_REQUESTED: "غير مطلوب",
      PENDING: "قيد الانتظار",
      ANCHORED: "مُرسَّخ",
      FAILED: "فشل",
      UNAVAILABLE: "غير متاح",
    },
    labels: {
      NOT_REQUESTED: "غير مطلوب",
      PENDING: "الترسيخ في بيتكوين قيد الانتظار",
      ANCHORED: "مُرسَّخ في بيتكوين",
      FAILED: "فشل الترسيخ في بيتكوين",
      UNAVAILABLE: "الترسيخ في بيتكوين غير متاح",
    },
    sentences: {
      NOT_REQUESTED: "لم يُطلب ترسيخ OpenTimestamps لهذا السجل.",
      PENDING: "إثبات OpenTimestamps بانتظار الترسيخ في بيتكوين.",
      ANCHORED: "إثبات OpenTimestamps مُرسَّخ في بيتكوين.",
      FAILED: "لم يكتمل الترسيخ في بيتكوين لهذا السجل.",
      UNAVAILABLE: "تتعذر قراءة مادة إثبات OpenTimestamps حاليًا.",
    },
    boundary:
      "يربط إثبات OpenTimestamps المخزَّن بصمة الدليل المسجَّلة تشفيريًا بشهادة كتلة في بيتكوين. لا تدّعي PROOVRA تحققًا مستقلًا من السلسلة المعتمدة عبر عقدة بيتكوين تشغّلها PROOVRA.",
    facts: {
      digest: "بصمة الدليل (SHA-256)",
      proofSha256: "SHA-256 للإثبات",
      attestationType: "نوع الشهادة",
      blockHeight: "ارتفاع كتلة بيتكوين",
      txid: "معاملة بيتكوين",
      submittedAt: "وقت الإرسال (UTC)",
      anchoredAt: "سجّلت PROOVRA الترسيخ (UTC)",
      validator: "مدقق الإثبات",
    },
    attestationTypes: { BITCOIN_BLOCK_HEADER: "ترويسة كتلة بيتكوين", PENDING_CALENDAR: "تقويم قيد الانتظار" },
    failureLabels: {
      MALFORMED_PROOF: "تعذرت قراءة إثبات OpenTimestamps.",
      PROOF_HASH_MISMATCH: "إثبات OpenTimestamps لا يرتبط ببصمة الدليل الخاصة بهذا السجل.",
      UNSUPPORTED_PROOF_OPERATION: "يستخدم إثبات OpenTimestamps عملية لا تنفذها PROOVRA.",
      INVALID_ATTESTATION: "يحتوي إثبات OpenTimestamps على شهادة بيتكوين غير صالحة الصيغة.",
      OTS_GLOBAL_BUDGET_EXHAUSTED: "لم يُرسَّخ الإثبات في بيتكوين ضمن ميزانية التحديث.",
      OTS_PROCESSING_FAILED: "لم تكتمل معالجة OpenTimestamps لهذا السجل.",
      PROOF_MATERIAL_MISSING: "إثبات OpenTimestamps المخزَّن مفقود.",
      FINGERPRINT_MISSING: "لا يملك السجل بصمة دليل يمكن ربط الإثبات بها.",
    },
  },
};

/** The copy for a locale; any other locale reads English. */
export function otsAnchoringCopy(locale: string | null | undefined): OtsAnchoringCopy {
  const l = String(locale ?? "en").slice(0, 2).toLowerCase();
  return l === "de" || l === "ar" ? OTS_ANCHORING_COPY[l] : OTS_ANCHORING_COPY.en;
}
