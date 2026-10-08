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
  acquisitionAccountLabel,
  acquisitionActorLabel,
  type AcquisitionIdentitySnapshot,
} from "./acquisition-identity.js";
import { resolveEvidenceAcquisition } from "./evidence-acquisition.js";
import {
  TSA_VALIDATED_QUALIFICATION_STATEMENT,
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
  ots_anchoring: "OpenTimestamps / Bitcoin anchoring",
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
  statementFor?: (status: VerificationStatus, summary: string) => string,
): VerificationMatrixRow {
  if (!signal) return row(key, "UNAVAILABLE", "Not recorded for this record.");
  const state = resolveSnapshotSignalState(signal);
  const status = toVerificationStatus(state);
  const summary = (signal.summary ?? "").trim() || "Not recorded for this record.";
  return row(key, status, statementFor ? statementFor(status, summary) : summary, signal.measuredAtUtc ?? null);
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
      const emailVerified =
        provider === "EMAIL" && identity.emailVerified !== false && identity.identityLevel !== "BASIC_ACCOUNT";
      if (emailVerified) {
        account = row(
          "account_identity",
          "VERIFIED",
          `${label}: the account's email address was verified when the record was created${tail}. This identifies the account, not the person.`,
          at,
        );
      } else if (provider === "GOOGLE" || provider === "APPLE") {
        account = row(
          "account_identity",
          "VERIFIED",
          `${label}: signed in through ${provider === "GOOGLE" ? "Google" : "Apple"} when the record was created${tail}. This identifies the account, not the person.`,
          at,
        );
      } else if (provider === "EMAIL") {
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
        : // An upload or submission is not a capture by PROOVRA.
          row("capture_method", "NOT_APPLICABLE", `${acquisition.label}, not captured by PROOVRA. ${acquisition.statement}`);
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
 * THE bounded summary. It names the integrity and custody result exactly,
 * says that NOT_CHECKED means not independently verified, and always ends with
 * the fixed limitation. Nothing in it may say more than the rows.
 */
export function verificationMatrixSummary(rows: ReadonlyArray<Pick<VerificationMatrixRow, "key" | "label" | "status">>): string {
  const of = (key: VerificationMatrixKey) => rows.find((r) => r.key === key)?.status ?? "UNAVAILABLE";
  const failed = rows.filter((r) => r.status === "FAILED").map((r) => r.label);
  const parts: string[] = [];
  if (failed.length > 0) {
    parts.push(
      `${failed.join(", ")} FAILED. Do not rely on the preserved bytes until ${failed.length === 1 ? "this check is" : "these checks are"} reviewed.`,
    );
  } else if (of("file_integrity") === "VERIFIED" && of("custody_chain") === "VERIFIED") {
    parts.push("Cryptographic integrity and PROOVRA custody checks passed for the preserved bytes.");
  } else if (of("file_integrity") === "VERIFIED") {
    parts.push(`Cryptographic integrity checks passed for the preserved bytes; the PROOVRA custody chain is ${of("custody_chain")}.`);
  } else {
    parts.push(`Cryptographic integrity of the preserved bytes is ${of("file_integrity")}.`);
  }
  if (rows.some((r) => r.status === "NOT_CHECKED")) {
    parts.push("Any signal marked NOT_CHECKED was not independently verified.");
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
    signalRow("ots_anchoring", signal("bitcoin_anchoring"), (status, summary) =>
      status === "NOT_CHECKED"
        ? `${summary}. PROOVRA has not checked the proof against the Bitcoin chain; no trusted Bitcoin verifier result is recorded.`.replace("..", ".")
        : summary,
    ),
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
    rows.push({
      key: o.key as VerificationMatrixKey,
      label: typeof o.label === "string" ? o.label : VERIFICATION_MATRIX_LABELS[o.key as VerificationMatrixKey],
      status: status as VerificationStatus,
      statement: typeof o.statement === "string" ? o.statement : "",
      measuredAtUtc: typeof o.measuredAtUtc === "string" ? o.measuredAtUtc : null,
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
