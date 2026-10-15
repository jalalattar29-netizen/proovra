/**
 * THE VERIFICATION MATRIX (2026-10-08).
 *
 * PROOVRA reports independently verifiable facts, one signal at a time. It
 * never states an overall legal or forensic conclusion and never a numeric
 * confidence: there is no score, no weighted point, no "strongly verified".
 * Every customer-facing surface — the PDF report, both verification-package
 * profiles, Public Verify, the web app and the native app — states the record
 * through this matrix:
 *
 *   - one row per signal, each in exactly one VerificationStatus
 *     (VERIFIED | FAILED | NOT_CHECKED | NOT_APPLICABLE | UNAVAILABLE),
 *     projected from the canonical TrustSignalState;
 *   - one bounded summary that names what passed and what was not checked;
 *   - one fixed limitation: the record does not by itself establish
 *     authorship, factual truth, pre-PROOVRA history or legal admissibility.
 *
 * The rows come from facts that already have an authority — the trust signals
 * (buildEvidenceTrustDecision), the capture-time identity snapshot
 * (acquisition-identity), the acquisition channel (evidence-acquisition), the
 * package row (verification-package-artifacts) and the record's publication —
 * so the matrix can never disagree with them. Full Forensic and External
 * Disclosure packages build it from the same inputs and differ only in what
 * they disclose, never in a status.
 */
import {
  OTS_VERIFICATION_WORDS,
  otsAnchoringCopy,
  otsVerificationKeyOfState,
  parseOtsState,
  parseOtsVerificationKey,
  type OtsState,
  type OtsVerificationKey,
} from "./ots-anchoring.js";
import {
  acquisitionAccountLabel,
  acquisitionActorLabel,
  type AcquisitionIdentitySnapshot,
} from "./acquisition-identity.js";
import { resolveEvidenceAcquisition } from "./evidence-acquisition.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
  OTS_TRUST_BY_VERIFICATION,
  otsVerificationOfSignalState,
  resolveSnapshotSignalState,
  toVerificationStatus,
  type TrustSignalState,
  type VerificationStatus,
} from "./trust-signal-state.js";

export const VERIFICATION_MATRIX_SCHEMA = "PROOVRA_VERIFICATION_MATRIX_V1" as const;

export const VERIFICATION_MATRIX_KEYS = [
  "file_integrity",
  "record_signature",
  "custody_chain",
  "package_signature",
  "package_completeness",
  "tsa_token",
  "ots_anchoring",
  "storage_protection",
  "account_identity",
  "organization_verification",
  "capture_method",
  "pre_proovra_provenance",
  "public_verify_publication",
] as const;
export type VerificationMatrixKey = (typeof VERIFICATION_MATRIX_KEYS)[number];

export const VERIFICATION_MATRIX_LABELS: Readonly<Record<VerificationMatrixKey, string>> = {
  file_integrity: "File integrity",
  record_signature: "Record signature",
  custody_chain: "PROOVRA custody chain",
  package_signature: "Package signature",
  package_completeness: "Package completeness",
  tsa_token: "Trusted timestamp (RFC 3161)",
  ots_anchoring: "OpenTimestamps",
  storage_protection: "Storage protection",
  account_identity: "Account identity",
  organization_verification: "Organization verification",
  capture_method: "Capture method",
  pre_proovra_provenance: "Pre-PROOVRA provenance",
  public_verify_publication: "Public Verify publication",
};

export type VerificationMatrixRow = {
  key: VerificationMatrixKey;
  label: string;
  status: VerificationStatus;
  /** One factual sentence: what was checked, or why it was not. */
  statement: string;
  measuredAtUtc: string | null;
  /**
   * The word a reader sees when it differs from the generic status word:
   * OpenTimestamps says the verification word (ots-anchoring
   * OTS_VERIFICATION_WORDS): "Attestation recorded" for a proof that only
   * names a block, "Independently verified" only for a chain-verified one.
   * Absent for every other row.
   */
  statusLabel?: string;
  /** The canonical OpenTimestamps state, on the ots_anchoring row only. */
  otsState?: OtsState;
  /** The canonical OpenTimestamps verification key, on the ots_anchoring row only. */
  otsVerification?: OtsVerificationKey;
};

export type VerificationMatrix = {
  schema: typeof VERIFICATION_MATRIX_SCHEMA;
  rows: VerificationMatrixRow[];
  /** The bounded summary, derived from the rows. */
  summary: string;
  /** The fixed limitation, stated on every surface. */
  limitation: string;
};

/** The fixed limitation. No surface may state more than this record shows. */
export const VERIFICATION_LIMITATION =
  "This record does not by itself establish authorship, factual truth, pre-PROOVRA history or legal admissibility.";

/**
 * The package a surface can speak for:
 *   SELF       the surface IS the report or the package (a document cannot
 *              attest to its own seal; the reader checks it)
 *   PUBLISHED  a package row PROOVRA published: its seal verified against the
 *              registered PACKAGE_SEAL key and its manifest covered every file
 *              before publication
 *   LEGACY     a package issued before seals were bound to a published key
 *   NONE       no package has been issued
 */
export type PackageSealFact =
  | { kind: "SELF" }
  | { kind: "PUBLISHED"; sealKeyId: string; sealKeyVersion: number }
  | { kind: "LEGACY" }
  | { kind: "NONE" };

/**
 * The record's Public Verify publication, as the surface knows it:
 *   THIS_PAGE   the surface is the published Public Verify page
 *   PUBLISHED / NOT_PUBLISHED   read from the record now (signed-in surfaces)
 *   DOCUMENT    a generated document: publication can change after it
 */
export type PublicationFact =
  | { kind: "THIS_PAGE" }
  | { kind: "PUBLISHED" }
  | { kind: "NOT_PUBLISHED" }
  | { kind: "DOCUMENT" };

/** A trust signal as built now or as read from a stored snapshot. */
export type VerificationSignalInput = {
  key: string;
  state?: TrustSignalState | string | null;
  status?: string | null;
  summary?: string | null;
  measuredAtUtc?: string | null;
  /** bitcoin_anchoring only: the canonical OTS verification key. */
  otsVerification?: string | null;
  /** bitcoin_anchoring only: the one sentence with its facts. */
  detail?: string | null;
};

export type VerificationIdentityInput = Pick<
  AcquisitionIdentitySnapshot,
  | "basis"
  | "actorKind"
  | "contributorEmailProvided"
  | "authProvider"
  | "emailVerified"
  | "identityLevel"
  | "workspaceKind"
  | "organizationVerified"
  | "recordedAtUtc"
>;

export type BuildVerificationMatrixInput = {
  signals: ReadonlyArray<VerificationSignalInput>;
  /** The capture-time identity snapshot; null when none is available. */
  identity: VerificationIdentityInput | null;
  acquisitionMode: string | null;
  acquisitionModeSource?: string | null;
  packageSeal: PackageSealFact;
  publication: PublicationFact;
};

function row(
  key: VerificationMatrixKey,
  status: VerificationStatus,
  statement: string,
  measuredAtUtc: string | null = null,
): VerificationMatrixRow {
  return { key, label: VERIFICATION_MATRIX_LABELS[key], status, statement, measuredAtUtc };
}

function signalRow(
  key: VerificationMatrixKey,
  signal: VerificationSignalInput | undefined,
  statementFor?: (status: VerificationStatus, summary: string, state: TrustSignalState) => string,
): VerificationMatrixRow {
  if (!signal) return row(key, "UNAVAILABLE", "Not recorded for this record.");
  const state = resolveSnapshotSignalState(signal);
  const status = toVerificationStatus(state);
  const summary = (signal.summary ?? "").trim() || "Not recorded for this record.";
  return row(key, status, statementFor ? statementFor(status, summary, state) : summary, signal.measuredAtUtc ?? null);
}

/**
 * THE OTS ROW: the canonical anchoring verification (ots-anchoring.ts), read
 * back from the anchoring signal — its state and its verification marker,
 * never from its words. VERIFIED only for CHAIN_VERIFIED.
 *
 *   PASSED                              CHAIN_VERIFIED               VERIFIED
 *   PRESENT_NOT_INDEPENDENTLY_VERIFIED  ATTESTATION_RECORDED         NOT_CHECKED
 *   PENDING                             PENDING / CONFIRMATIONS      NOT_CHECKED
 *   FAILED                              FAILED / CHAIN_FAILED        FAILED
 *   NOT_APPLICABLE                      NOT_REQUESTED                NOT_APPLICABLE
 *   anything else                       UNAVAILABLE / CHAIN_UNAVAIL. UNAVAILABLE
 */
export function otsStateFromTrustState(state: TrustSignalState): OtsState {
  switch (state) {
    case "PASSED":
    case "PRESENT_NOT_INDEPENDENTLY_VERIFIED":
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

const OTS_LIFECYCLE_OF_VERIFICATION: Readonly<Record<OtsVerificationKey, OtsState>> = {
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

/** The OTS row's machine status for a verification key: VERIFIED only for CHAIN_VERIFIED. */
export function otsMatrixStatusOf(verification: OtsVerificationKey): VerificationStatus {
  return toVerificationStatus(OTS_TRUST_BY_VERIFICATION[verification]);
}

/** The OTS row's machine status for a trust state. */
export function otsVerificationStatus(state: TrustSignalState): VerificationStatus {
  return toVerificationStatus(state);
}

function otsRowOf(verification: OtsVerificationKey, statement: string | null, measuredAtUtc: string | null): VerificationMatrixRow {
  return {
    ...row("ots_anchoring", otsMatrixStatusOf(verification), statement || otsAnchoringCopy("en").verificationSentencesPlain[verification], measuredAtUtc),
    statusLabel: OTS_VERIFICATION_WORDS[verification],
    otsState: OTS_LIFECYCLE_OF_VERIFICATION[verification],
    otsVerification: verification,
  };
}

function otsRow(signal: VerificationSignalInput | undefined): VerificationMatrixRow {
  const state = signal ? resolveSnapshotSignalState(signal) : "UNAVAILABLE";
  const verification = otsVerificationOfSignalState(state, signal?.otsVerification);
  const detail = typeof signal?.detail === "string" && signal.detail.trim() ? signal.detail.trim() : null;
  return otsRowOf(verification, detail, signal?.measuredAtUtc ?? null);
}

/**
 * (2026-10-14) Whether the submission-time snapshot positively verifies the
 * submitting account — the one condition a surface may print "Account
 * authentication — Verified" on: the matrix's account row is VERIFIED, read
 * from the creation-time snapshot, for an account user (never an intake
 * contributor or a guest).
 */
export function isAccountAuthenticationVerified(identity: VerificationIdentityInput | null): boolean {
  return (
    identity != null &&
    identity.basis === "OBSERVED_AT_CAPTURE" &&
    identity.actorKind === "ACCOUNT_USER" &&
    identityRows(identity)[0]!.status === "VERIFIED"
  );
}

function identityRows(identity: VerificationIdentityInput | null): VerificationMatrixRow[] {
  if (!identity || identity.basis === "UNAVAILABLE") {
    return [
      row("account_identity", "UNAVAILABLE", "Historical identity snapshot unavailable."),
      row("organization_verification", "UNAVAILABLE", "Not recorded."),
    ];
  }
  const bound = identity.basis === "OBSERVED_AT_CAPTURE";
  const tail = bound ? "" : " (not bound to the capture time)";
  const at = bound ? identity.recordedAtUtc : null;

  let account: VerificationMatrixRow;
  switch (identity.actorKind) {
    case "INTAKE_CONTRIBUTOR":
      account = row(
        "account_identity",
        "NOT_CHECKED",
        `${acquisitionActorLabel(identity)}. The contributor's identity was not verified${tail}.`,
        at,
      );
      break;
    case "GUEST_SESSION":
      account = row("account_identity", "NOT_CHECKED", `Guest session; no verified account${tail}.`, at);
      break;
    default: {
      const provider = (identity.authProvider ?? "").toUpperCase();
      const label = acquisitionAccountLabel(identity);
      const level = identity.identityLevel;
      // (2026-10-14) VERIFIED only on the submission-time snapshot, and only
      // when it states the verification itself: an email account whose
      // snapshot recorded emailVerified true (or, for a snapshot that predates
      // that field, the VERIFIED_EMAIL level computed from the same moment),
      // and a sign-in provider the recorded level does not contradict. A
      // legacy record's own columns (not bound to the capture time), an
      // unknown verification state or an inconsistent snapshot stays NOT_CHECKED.
      const emailVerified =
        bound &&
        provider === "EMAIL" &&
        level !== "BASIC_ACCOUNT" &&
        level !== "OAUTH_BACKED_IDENTITY" &&
        (identity.emailVerified === true || (identity.emailVerified === null && level === "VERIFIED_EMAIL"));
      const oauthVerified =
        bound &&
        (provider === "GOOGLE" || provider === "APPLE") &&
        identity.emailVerified !== false &&
        level !== "VERIFIED_EMAIL" &&
        level !== "BASIC_ACCOUNT";
      if (emailVerified) {
        account = row(
          "account_identity",
          "VERIFIED",
          `${label}: the account's email address was verified when the record was created${tail}. This identifies the account, not the person.`,
          at,
        );
      } else if (oauthVerified) {
        account = row(
          "account_identity",
          "VERIFIED",
          `${label}: signed in through ${provider === "GOOGLE" ? "Google" : "Apple"} when the record was created${tail}. This identifies the account, not the person.`,
          at,
        );
      } else if (provider === "EMAIL" || provider === "GOOGLE" || provider === "APPLE") {
        account = row("account_identity", "NOT_CHECKED", `${label}${tail}.`, at);
      } else {
        account = row("account_identity", "UNAVAILABLE", `Account type not recorded${tail}.`, at);
      }
    }
  }

  const organization =
    identity.organizationVerified === true
      ? row("organization_verification", "VERIFIED", `Established when the record was created${tail}.`, at)
      : identity.workspaceKind === "PERSONAL"
        ? row("organization_verification", "NOT_APPLICABLE", "Not established. The record was created in a personal workspace.", at)
        : row("organization_verification", "NOT_CHECKED", "Not established.", at);

  return [account, organization];
}

function acquisitionRows(mode: string | null, source: string | null | undefined): VerificationMatrixRow[] {
  const acquisition = resolveEvidenceAcquisition({ acquisitionMode: mode, acquisitionModeSource: source ?? null });
  if (!acquisition.recorded) {
    return [
      row("capture_method", "UNAVAILABLE", "How this record entered PROOVRA was not recorded."),
      row("pre_proovra_provenance", "UNAVAILABLE", "Not recorded."),
    ];
  }
  const method =
    acquisition.provenanceTier === "SERVER_OBSERVED_CAPTURE"
      ? row("capture_method", "VERIFIED", `${acquisition.label}. ${acquisition.statement}`)
      : acquisition.provenanceTier === "CLIENT_ATTESTED_CAPTURE"
        ? row(
            "capture_method",
            "NOT_CHECKED",
            `${acquisition.label}. ${acquisition.statement} The capture is reported by PROOVRA software; PROOVRA's server did not observe it.`,
          )
        : // An upload or submission is not a capture by PROOVRA. The acquisition
          // statement itself is the provenance panel's, stated once there.
          row("capture_method", "NOT_APPLICABLE", `${acquisition.label}, not captured by PROOVRA.`);
  const before = acquisition.beforeProovraVisibility.replace(/\.$/, "");
  const provenance = row(
    "pre_proovra_provenance",
    "NOT_CHECKED",
    acquisition.provenanceTier === "IMPORTED_EXISTING_MEDIA"
      ? `PROOVRA did not observe creation or editing before submission. Not established: ${before.charAt(0).toLowerCase()}${before.slice(1)}.`
      : `Not established: ${before.charAt(0).toLowerCase()}${before.slice(1)}.`,
  );
  return [method, provenance];
}

function packageRows(seal: PackageSealFact): VerificationMatrixRow[] {
  switch (seal.kind) {
    case "SELF":
      return [
        row(
          "package_signature",
          "NOT_APPLICABLE",
          "A document cannot attest to its own seal. Check the verification package's seal with the commands in its README, or against PROOVRA's public package record.",
        ),
        row(
          "package_completeness",
          "NOT_APPLICABLE",
          "Check the package's files against its sealed manifest with the commands in its README.",
        ),
      ];
    case "PUBLISHED":
      return [
        row(
          "package_signature",
          "VERIFIED",
          `Sealed with PROOVRA package-seal key ${seal.sealKeyId} version ${seal.sealKeyVersion}; PROOVRA verified the seal against that registered key before publishing the package.`,
        ),
        row(
          "package_completeness",
          "VERIFIED",
          "PROOVRA verified that the sealed manifest covers every file in the package before publishing it.",
        ),
      ];
    case "LEGACY":
      return [
        row(
          "package_signature",
          "NOT_CHECKED",
          "Issued before package seals were bound to a published PROOVRA key. Check the seal with the package's README.",
        ),
        row("package_completeness", "NOT_CHECKED", "Check the package's files against its manifest with the package's README."),
      ];
    default:
      return [
        row("package_signature", "NOT_APPLICABLE", "No verification package has been issued for this record."),
        row("package_completeness", "NOT_APPLICABLE", "No verification package has been issued for this record."),
      ];
  }
}

function publicationRow(publication: PublicationFact): VerificationMatrixRow {
  switch (publication.kind) {
    case "THIS_PAGE":
      return row("public_verify_publication", "VERIFIED", "Published: this is the record's PROOVRA Public Verify page.");
    case "PUBLISHED":
      return row("public_verify_publication", "VERIFIED", "Published on PROOVRA Public Verify.");
    case "NOT_PUBLISHED":
      return row("public_verify_publication", "NOT_APPLICABLE", "Not published for public verification (private record).");
    default:
      return row(
        "public_verify_publication",
        "NOT_APPLICABLE",
        "Publication on PROOVRA Public Verify is controlled by the record owner and can change after this document was generated.",
      );
  }
}

/**
 * The words a reader sees for each status. The codes are the machine
 * vocabulary (trust-decision.json, the API); no primary prose prints them.
 */
export const VERIFICATION_STATUS_LABELS: Readonly<Record<VerificationStatus, string>> = {
  VERIFIED: "Verified",
  FAILED: "Failed",
  NOT_CHECKED: "Not checked",
  NOT_APPLICABLE: "Not applicable",
  UNAVAILABLE: "Unavailable",
};

const STATUS_PREDICATE: Readonly<Record<VerificationStatus, string>> = {
  VERIFIED: "was verified",
  FAILED: "failed",
  NOT_CHECKED: "was not checked",
  NOT_APPLICABLE: "does not apply",
  UNAVAILABLE: "could not be determined",
};

/**
 * THE bounded summary. It names the integrity and custody result exactly,
 * says that "Not checked" means not independently verified, and always ends with
 * the fixed limitation. Nothing in it may say more than the rows.
 */
export function verificationMatrixSummary(rows: ReadonlyArray<Pick<VerificationMatrixRow, "key" | "label" | "status">>): string {
  const of = (key: VerificationMatrixKey) => rows.find((r) => r.key === key)?.status ?? "UNAVAILABLE";
  // Anchoring does not decide the integrity of the bytes: an OpenTimestamps
  // failure is stated by its own row, never as "do not rely on the bytes".
  const failed = rows.filter((r) => r.status === "FAILED" && r.key !== "ots_anchoring").map((r) => r.label);
  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(
      `Failed: ${failed.join(", ")}. Do not rely on the preserved bytes until ${failed.length === 1 ? "this check is" : "these checks are"} reviewed.`,
    );
  } else if (of("file_integrity") === "VERIFIED" && of("custody_chain") === "VERIFIED") {
    parts.push("Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes.");
  } else if (of("file_integrity") === "VERIFIED") {
    parts.push(`Cryptographic integrity checks passed for the preserved bytes; the PROOVRA custody chain ${STATUS_PREDICATE[of("custody_chain")]}.`);
  } else {
    parts.push(`Cryptographic integrity of the preserved bytes ${STATUS_PREDICATE[of("file_integrity")]}.`);
  }
  if (rows.some((r) => r.status === "NOT_CHECKED")) {
    parts.push(`Any signal marked “${VERIFICATION_STATUS_LABELS.NOT_CHECKED}” was not independently verified.`);
  }
  parts.push(VERIFICATION_LIMITATION);
  return parts.join(" ");
}

export function buildVerificationMatrix(input: BuildVerificationMatrixInput): VerificationMatrix {
  const signal = (key: string) => input.signals.find((s) => s.key === key);
  const rows: VerificationMatrixRow[] = [
    signalRow("file_integrity", signal("core_integrity")),
    signalRow("record_signature", signal("signature")),
    signalRow("custody_chain", signal("custody_chain")),
    ...packageRows(input.packageSeal),
    // A validated token: what was validated, then the one bounded sentence.
    signalRow("tsa_token", signal("trusted_timestamp"), (status, summary) =>
      status === "VERIFIED" ? `RFC 3161 timestamp validated. ${TSA_VALIDATED_QUALIFICATION_STATEMENT}` : summary,
    ),
    otsRow(signal("bitcoin_anchoring")),
    signalRow("storage_protection", signal("immutable_storage")),
    ...identityRows(input.identity),
    ...acquisitionRows(input.acquisitionMode, input.acquisitionModeSource),
    publicationRow(input.publication),
  ];
  return {
    schema: VERIFICATION_MATRIX_SCHEMA,
    rows,
    summary: verificationMatrixSummary(rows),
    limitation: VERIFICATION_LIMITATION,
  };
}

/**
 * The matrix for a surface that may not describe who submitted the record
 * (the BASIC Public Verify tier): the account and organization rows are
 * withheld — NOT_APPLICABLE, "Not disclosed" — and the summary is derived
 * again. Every other row is unchanged.
 */
export function withholdIdentityRows(matrix: VerificationMatrix): VerificationMatrix {
  const rows = matrix.rows.map((r) =>
    r.key === "account_identity" || r.key === "organization_verification"
      ? { ...r, status: "NOT_APPLICABLE" as const, statement: "Not disclosed on this verification page.", measuredAtUtc: null }
      : r,
  );
  return { ...matrix, rows, summary: verificationMatrixSummary(rows) };
}

/** Parse a matrix read back from a package, API response or snapshot. */
export function parseVerificationMatrix(value: unknown): VerificationMatrix | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== VERIFICATION_MATRIX_SCHEMA || !Array.isArray(v.rows)) return null;
  const rows: VerificationMatrixRow[] = [];
  for (const r of v.rows) {
    if (!r || typeof r !== "object") return null;
    const o = r as Record<string, unknown>;
    if (!(VERIFICATION_MATRIX_KEYS as readonly string[]).includes(String(o.key))) return null;
    const status = String(o.status);
    if (!["VERIFIED", "FAILED", "NOT_CHECKED", "NOT_APPLICABLE", "UNAVAILABLE"].includes(status)) return null;
    if (o.key === "ots_anchoring") {
      // The canonical state and verification travel with the row; a legacy
      // row without them reads conservatively — an ANCHORED row without a
      // chain verification key is an unchecked attestation, whatever its
      // stored status word says — never re-derived from a legacy status.
      const ots = parseOtsState(o.otsState);
      const claimed = parseOtsVerificationKey(o.otsVerification);
      const verification =
        ots === "ANCHORED" && claimed && (claimed === "ATTESTATION_RECORDED" || claimed.startsWith("CHAIN_"))
          ? claimed
          : otsVerificationKeyOfState(ots);
      rows.push({
        ...otsRowOf(verification, typeof o.statement === "string" && verification === claimed ? o.statement : null, typeof o.measuredAtUtc === "string" ? o.measuredAtUtc : null),
        label: VERIFICATION_MATRIX_LABELS.ots_anchoring,
      });
      continue;
    }
    rows.push({
      key: o.key as VerificationMatrixKey,
      label: typeof o.label === "string" ? o.label : VERIFICATION_MATRIX_LABELS[o.key as VerificationMatrixKey],
      status: status as VerificationStatus,
      statement: typeof o.statement === "string" ? o.statement : "",
      measuredAtUtc: typeof o.measuredAtUtc === "string" ? o.measuredAtUtc : null,
      ...(typeof o.statusLabel === "string" ? { statusLabel: o.statusLabel } : {}),
    });
  }
  return {
    schema: VERIFICATION_MATRIX_SCHEMA,
    rows,
    summary: typeof v.summary === "string" ? v.summary : verificationMatrixSummary(rows),
    limitation: typeof v.limitation === "string" ? v.limitation : VERIFICATION_LIMITATION,
  };
}

/**
 * Strings no customer-facing artifact may carry: a numeric trust score, a
 * weighted point, an overall "strongly verified" verdict, or the old signal
 * tallies. Used by the worker's rendered-output gate and by tests.
 */
export const FORBIDDEN_CUSTOMER_CLAIM_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "STRONGLY_VERIFIED", re: /STRONGLY[_ ]VERIFIED/i },
  { name: "score out of 100", re: /\b\d{1,3}\s*\/\s*100\b/ },
  { name: "trust score", re: /\btrust\s+score\b/i },
  { name: "weighted points", re: /\b\d+\s*\/\s*\d+\s*(?:points|pts)\b|\bWeighting:\s*\d+/i },
  { name: "Passed signals", re: /\bPassed signals\b/ },
  { name: "No degraded signals", re: /\bNo degraded signals\b/i },
  { name: "reliance level", re: /\b(?:Reviewer|Reliance)\s+(?:reliance|level)\b/i },
];

export function findForbiddenCustomerClaims(text: string): string[] {
  return FORBIDDEN_CUSTOMER_CLAIM_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}
