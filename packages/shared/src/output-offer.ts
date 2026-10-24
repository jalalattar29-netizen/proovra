/**
 * THE UPDATED-REPORT AND RECOVERY CONTRACT — offer revision, reportable-fact
 * freshness, durable progress, typed operation errors.
 *
 * One pure module, consumed by the API (which computes and signs the offer and
 * re-derives it at Confirm), the web/PWA Artifacts & Versions tab and native.
 * Nothing here reads a database, a clock it was not given, or the network.
 *
 * ---------------------------------------------------------------------------
 * RGA-02 — WHY AN OFFER REVISION
 * ---------------------------------------------------------------------------
 * The confirmation a person reads ("Generate report v2 — no credit, about
 * 1.2 MB") is a statement about the record AT THE MOMENT IT WAS READ. Between
 * opening the modal and pressing Confirm the timestamp can be validated, the
 * anchor can land, a colleague can issue v2, a request can start or finish,
 * the person's permission or the plan can change. A client comparing "is the
 * next version still 2?" catches one of those; the rest submitted a request
 * the person never saw described.
 *
 * So the server binds every fact the confirmation depends on into an
 * {@link OutputOfferBinding}, signs it into an opaque revision with an expiry,
 * and at Confirm — immediately before the durable request is created —
 * re-derives the binding from live facts and refuses (`OUTPUT_OFFER_STALE`,
 * with the list of what changed) unless every bound field is equal. The client
 * never decides staleness; it renders what the server says changed.
 */
import type { OtsState, OtsVerificationKey } from "./ots-anchoring.js";

// ===========================================================================
// OFFER BINDING
// ===========================================================================

/** How long a confirmation may stay open before it must be re-read. */
export const OUTPUT_OFFER_TTL_MS = 15 * 60 * 1000;

/** The operation a confirmation would start, or that none would. */
export const OUTPUT_OFFER_OPERATIONS = [
  "GENERATE",
  "RETRY",
  "RECOVER",
  "NEW_VERSION",
  "NONE",
] as const;
export type OutputOfferOperation = (typeof OUTPUT_OFFER_OPERATIONS)[number];

/**
 * Every fact a confirmation depends on. Compared FIELD BY FIELD at Confirm; any
 * difference makes the offer stale. Values are scalars or bounded strings so
 * the canonical form is stable across processes.
 */
export type OutputOfferBinding = {
  /** Subject — a revision for another record, workspace or person is refused. */
  evidenceId: string;
  workspaceId: string | null;
  callerUserId: string;
  /** Latest completed report and the packages beside it. */
  latestReportVersion: number | null;
  pairedPackageVersion: number | null;
  latestPackageVersion: number | null;
  /** Reportable facts — a canonical fingerprint of what a new report would say. */
  reportableFacts: string;
  /** Trusted timestamp: `<status>|<validated>` (validated = a validation time exists). */
  tsa: string;
  /** OpenTimestamps: `<canonical state>|<proof sha-256>` (ots-anchoring.ts). */
  ots: string;
  /** The three decisions, as `<action>:<operation|reason>` (newVersion adds `:v<next>`). */
  reportAction: string;
  packageAction: string;
  newVersionAction: string;
  /** The intended target version of a NEW_VERSION confirmation. */
  targetVersion: number | null;
  /** The newest durable request for the record: `<id>:<state>`, or `none`. */
  activeRequest: string;
  /** Permission (evidence.generate_report through the canonical engine). */
  callerMayGenerate: boolean;
  /** Commercial eligibility: `<report>|<package>`. */
  eligibility: string;
  /** No path in this contract spends an evidence credit. Bound so that changes. */
  creditEffect: "NONE";
  /** Storage effect: `<estimatedBytes|unknown>|<fits: yes|no|unknown>`. */
  storageEffect: string;
  /** A NEW_VERSION confirmation requires a reason; the others do not. */
  reasonRequired: boolean;
};

/** The fields in the order they are canonicalised and compared. */
export const OUTPUT_OFFER_BINDING_FIELDS = [
  "evidenceId",
  "workspaceId",
  "callerUserId",
  "latestReportVersion",
  "pairedPackageVersion",
  "latestPackageVersion",
  "reportableFacts",
  "tsa",
  "ots",
  "reportAction",
  "packageAction",
  "newVersionAction",
  "targetVersion",
  "activeRequest",
  "callerMayGenerate",
  "eligibility",
  "creditEffect",
  "storageEffect",
  "reasonRequired",
] as const satisfies ReadonlyArray<keyof OutputOfferBinding>;

/** Deterministic serialisation (fixed key order) for signing. */
export function canonicalizeOutputOfferBinding(b: OutputOfferBinding): string {
  return JSON.stringify(OUTPUT_OFFER_BINDING_FIELDS.map((k) => [k, b[k] ?? null]));
}

/** Why a confirmation is no longer current. One code per family of change. */
export const OUTPUT_OFFER_CHANGE_CODES = [
  "SUBJECT_MISMATCH",
  "OFFER_EXPIRED",
  "OFFER_INVALID",
  "LATEST_REPORT_CHANGED",
  "PACKAGE_CHANGED",
  "TSA_CHANGED",
  "OTS_CHANGED",
  "REPORTABLE_FACTS_CHANGED",
  "REQUEST_STATE_CHANGED",
  "ACTIONS_CHANGED",
  "PERMISSION_CHANGED",
  "ELIGIBILITY_CHANGED",
  "STORAGE_CHANGED",
  "CREDIT_CHANGED",
] as const;
export type OutputOfferChangeCode = (typeof OUTPUT_OFFER_CHANGE_CODES)[number];

const FIELD_CHANGE: Record<keyof OutputOfferBinding, OutputOfferChangeCode> = {
  evidenceId: "SUBJECT_MISMATCH",
  workspaceId: "SUBJECT_MISMATCH",
  callerUserId: "SUBJECT_MISMATCH",
  latestReportVersion: "LATEST_REPORT_CHANGED",
  targetVersion: "LATEST_REPORT_CHANGED",
  pairedPackageVersion: "PACKAGE_CHANGED",
  latestPackageVersion: "PACKAGE_CHANGED",
  reportableFacts: "REPORTABLE_FACTS_CHANGED",
  tsa: "TSA_CHANGED",
  ots: "OTS_CHANGED",
  reportAction: "ACTIONS_CHANGED",
  packageAction: "ACTIONS_CHANGED",
  newVersionAction: "ACTIONS_CHANGED",
  activeRequest: "REQUEST_STATE_CHANGED",
  callerMayGenerate: "PERMISSION_CHANGED",
  eligibility: "ELIGIBILITY_CHANGED",
  creditEffect: "CREDIT_CHANGED",
  storageEffect: "STORAGE_CHANGED",
  reasonRequired: "ACTIONS_CHANGED",
};

/**
 * What changed between the binding a confirmation was shown and the binding
 * the server derives now. Empty means the confirmation is still current.
 * Deduplicated, in contract order. The TSA/OTS codes take precedence over the
 * generic fingerprint code they imply.
 */
export function diffOutputOfferBindings(
  shown: OutputOfferBinding,
  current: OutputOfferBinding,
): OutputOfferChangeCode[] {
  const out: OutputOfferChangeCode[] = [];
  for (const k of OUTPUT_OFFER_BINDING_FIELDS) {
    if ((shown[k] ?? null) !== (current[k] ?? null)) {
      const code = FIELD_CHANGE[k];
      if (!out.includes(code)) out.push(code);
    }
  }
  // A TSA/OTS change is also a fingerprint change; say the specific thing once.
  if (
    out.includes("REPORTABLE_FACTS_CHANGED") &&
    (out.includes("TSA_CHANGED") || out.includes("OTS_CHANGED"))
  ) {
    return out.filter((c) => c !== "REPORTABLE_FACTS_CHANGED");
  }
  return out;
}

/** One sentence per change, for the modal's "what changed" list. */
export function outputOfferChangeCopy(code: OutputOfferChangeCode): string {
  switch (code) {
    case "SUBJECT_MISMATCH":
      return "This confirmation belongs to a different record, workspace or person.";
    case "OFFER_EXPIRED":
      return "This confirmation was open too long and has expired.";
    case "OFFER_INVALID":
      return "This confirmation could not be verified.";
    case "LATEST_REPORT_CHANGED":
      return "A newer report version was completed.";
    case "PACKAGE_CHANGED":
      return "The record's verification packages changed.";
    case "TSA_CHANGED":
      return "The trusted timestamp's status changed.";
    case "OTS_CHANGED":
      return "The OpenTimestamps anchor's status changed.";
    case "REPORTABLE_FACTS_CHANGED":
      return "The record's verification facts changed.";
    case "REQUEST_STATE_CHANGED":
      return "A report request for this record started or finished.";
    case "ACTIONS_CHANGED":
      return "The actions available for this record changed.";
    case "PERMISSION_CHANGED":
      return "Your permission to generate reports for this record changed.";
    case "ELIGIBILITY_CHANGED":
      return "The workspace plan's report eligibility changed.";
    case "STORAGE_CHANGED":
      return "The storage this report would use, or the workspace allowance, changed.";
    case "CREDIT_CHANGED":
      return "The credit this report would use changed.";
    default:
      return "The record changed.";
  }
}

/** The non-sensitive offer envelope a surface receives beside the decisions. */
export type OutputOfferEnvelope = {
  /** Opaque, signed. Sent back unchanged with the Confirm request. */
  revision: string;
  createdAtUtc: string;
  expiresAtUtc: string;
  operation: OutputOfferOperation;
  targetVersion: number | null;
  reasonRequired: boolean;
  creditEffect: { kind: "NONE" };
  storageEffect: {
    estimatedBytes: string | null;
    fitsStorage: boolean | null;
    storageBytesUsed: string | null;
    storageBytesLimit: string | null;
  };
};

// ===========================================================================
// REPORTABLE-FACT FRESHNESS
// ===========================================================================

/**
 * WHY a custody fact changes what a report would SAY — the reason each
 * reportable custody event type is grouped under. Report/package generation,
 * downloads, views, investigation exports and every internal Review workflow
 * activity (owner decision 2026-10-24: Review is not forensic custody) describe
 * the record's handling, not its evidentiary state, and never make a report
 * outdated. The timestamp/anchor facts have their own, more specific codes.
 */
export const REPORTABLE_CUSTODY_REASONS = [
  "LEGAL_HOLD",
  "CHAIN_TRANSFER",
  "REDACTION",
  "CERTIFICATION",
  "RECORD_LOCK",
  "STORAGE_PROTECTION",
  "RETENTION",
  "INTEGRITY",
  "ARCHIVE",
  "ANCHOR",
] as const;
export type ReportableCustodyReason = (typeof REPORTABLE_CUSTODY_REASONS)[number];

const REPORTABLE_CUSTODY_REASON_BY_TYPE: Readonly<Record<string, ReportableCustodyReason>> = {
  LEGAL_HOLD_PLACED: "LEGAL_HOLD",
  LEGAL_HOLD_RELEASED: "LEGAL_HOLD",
  CASE_LEGAL_HOLD_APPLIED: "LEGAL_HOLD",
  CASE_LEGAL_HOLD_RELEASED: "LEGAL_HOLD",
  CHAIN_TRANSFER_CUSTODY_EXTENDED: "CHAIN_TRANSFER",
  REDACTION_RECORDED: "REDACTION",
  CERTIFICATION_REQUESTED: "CERTIFICATION",
  CERTIFICATION_ATTESTED: "CERTIFICATION",
  CERTIFICATION_REVOKED: "CERTIFICATION",
  EVIDENCE_LOCKED: "RECORD_LOCK",
  EVIDENCE_UNLOCKED: "RECORD_LOCK",
  STORAGE_PROTECTION_UNAVAILABLE: "STORAGE_PROTECTION",
  RETENTION_AUTO_EXTENDED: "RETENTION",
  RETENTION_POLICY_APPLIED: "RETENTION",
  TECHNICAL_VERIFICATION_CHECKED: "INTEGRITY",
  INTEGRITY_REJECTED_HASH_MISMATCH: "INTEGRITY",
  EVIDENCE_ARCHIVED: "ARCHIVE",
  EVIDENCE_RESTORED: "ARCHIVE",
  ARCHIVE_RESTORE_COMPLETED: "ARCHIVE",
  ANCHOR_PUBLISHED: "ANCHOR",
};

/** Custody events that change what a report would SAY (the keys above). */
export const REPORTABLE_CUSTODY_EVENT_TYPES: ReadonlyArray<string> = Object.keys(REPORTABLE_CUSTODY_REASON_BY_TYPE);

/** The reason a custody event type is reportable under; null when it is not reportable. */
export function reportableCustodyReasonOf(eventType: string | null | undefined): ReportableCustodyReason | null {
  return REPORTABLE_CUSTODY_REASON_BY_TYPE[String(eventType ?? "").trim().toUpperCase()] ?? null;
}

/** Singular / plural noun phrase per reason — a fact, never a payload. */
const REPORTABLE_CUSTODY_REASON_NOUNS: Readonly<Record<ReportableCustodyReason, readonly [string, string]>> = {
  LEGAL_HOLD: ["legal-hold change was", "legal-hold changes were"],
  CHAIN_TRANSFER: ["chain-of-custody transfer was", "chain-of-custody transfers were"],
  REDACTION: ["redaction step was", "redaction steps were"],
  CERTIFICATION: ["certification change was", "certification changes were"],
  RECORD_LOCK: ["record-lock change was", "record-lock changes were"],
  STORAGE_PROTECTION: ["storage-protection change was", "storage-protection changes were"],
  RETENTION: ["retention change was", "retention changes were"],
  INTEGRITY: ["integrity result was", "integrity results were"],
  ARCHIVE: ["archive or restore step was", "archive or restore steps were"],
  ANCHOR: ["anchor publication was", "anchor publications were"],
};

/** One reportable reason's custody facts after the report's custody horizon. */
export type ReportableCustodyGroup = {
  reason: ReportableCustodyReason;
  count: number;
  firstAtUtc: string | null;
  latestAtUtc: string | null;
};

export const REPORT_FRESHNESS_CHANGE_CODES = [
  "TSA_VALIDATED_AFTER_REPORT",
  "TSA_STATUS_CHANGED_AFTER_REPORT",
  "OTS_CHAIN_VERIFIED_AFTER_REPORT",
  "CUSTODY_CHANGED_AFTER_REPORT",
  "INTEGRITY_REVERIFIED_AFTER_REPORT",
] as const;
export type ReportFreshnessChangeCode = (typeof REPORT_FRESHNESS_CHANGE_CODES)[number];

export type ReportFreshnessChange = {
  code: ReportFreshnessChangeCode;
  /** When the later fact was recorded, when known (the latest, for a group). */
  atUtc: string | null;
  /** Count, for custody changes. */
  count?: number;
  /** For custody changes: WHY they are reportable (one change per reason). */
  reason?: ReportableCustodyReason | null;
  /** For custody changes: when the first of them was recorded. */
  firstAtUtc?: string | null;
};

export type ReportFreshness = {
  /** The report version the comparison is against (the latest completed one). */
  reportVersion: number | null;
  reportGeneratedAtUtc: string | null;
  hasNewerFacts: boolean;
  changes: ReportFreshnessChange[];
};

export type ReportFreshnessInput = {
  reportVersion: number | null;
  reportGeneratedAtUtc: string | null;
  /** The TSA status the report was rendered with (from its trust snapshot), when recorded. */
  reportTsaStatus?: string | null;
  tsa: { status: string | null; validatedAtUtc: string | null };
  ots: {
    /** The canonical state now (ots-anchoring.ts). */
    state: OtsState;
    /** When PROOVRA recorded ANCHORED. */
    anchoredAtUtc: string | null;
    /** The state the report stated (anchorSnapshot.otsState); null for legacy reports. */
    reportState?: OtsState | null;
    /** The canonical verification now (CHAIN_VERIFIED is the only positive claim). */
    verification?: OtsVerificationKey | null;
    /** The verification the report stated (anchorSnapshot.otsVerification); null for legacy reports. */
    reportVerification?: OtsVerificationKey | null;
    /** When the chain verification was established, when it was. */
    verifiedAtUtc?: string | null;
    /** The verified proof and block NOW, when known (identity of the verification). */
    proofSha256?: string | null;
    blockHash?: string | null;
    /** The proof and block the report stated (anchorSnapshot), when it recorded them. */
    reportProofSha256?: string | null;
    reportBlockHash?: string | null;
  };
  /**
   * Reportable custody events recorded after the report's custody horizon,
   * grouped by reason (`loadReportableCustodyAfterReport`, the one query the
   * API and the worker share). `count` / `latestAtUtc` alone are the
   * ungrouped legacy form.
   */
  custodyAfterReport: { count?: number; latestAtUtc?: string | null; groups?: ReportableCustodyGroup[] };
  integrity: { lastVerifiedAtUtc: string | null; reportLastVerifiedAtUtc: string | null };
};

/**
 * THE ONE OTS RULE for "a newer report is owed" (2026-10-24) — the update card
 * and the worker's automatic OTS-anchored version both read it. Only an
 * independent Bitcoin-chain verification the report did not state is owed. A
 * report that stated CHAIN_VERIFIED owes nothing — unless the verification it
 * stated was of a DIFFERENT proof or block (a re-anchor), which is known only
 * when both the live identity and the stated one are recorded.
 */
export function otsChainVerifiedAfterReport(ots: {
  verification?: OtsVerificationKey | null;
  reportVerification?: OtsVerificationKey | null;
  proofSha256?: string | null;
  blockHash?: string | null;
  reportProofSha256?: string | null;
  reportBlockHash?: string | null;
}): boolean {
  if (ots.verification !== "CHAIN_VERIFIED") return false;
  if (ots.reportVerification !== "CHAIN_VERIFIED") return true;
  if (!ots.proofSha256 || !ots.blockHash) return false;
  const same = (a: string | null | undefined, b: string) => String(a ?? "").toLowerCase() === b.toLowerCase();
  return !(same(ots.reportProofSha256, ots.proofSha256) && same(ots.reportBlockHash, ots.blockHash));
}

const after = (fact: string | null, baseline: string | null): boolean =>
  fact != null && baseline != null && Date.parse(fact) > Date.parse(baseline);

/**
 * Which recorded facts are newer than the latest report. Timestamps are the
 * record's own (the time each fact was recorded), compared with the time the
 * report was generated — never inferred on the client, never invented: a fact
 * with no recorded time is not claimed as newer.
 */
export function deriveReportFreshness(input: ReportFreshnessInput): ReportFreshness {
  const base = input.reportGeneratedAtUtc;
  const changes: ReportFreshnessChange[] = [];
  if (input.reportVersion == null || base == null) {
    return { reportVersion: input.reportVersion, reportGeneratedAtUtc: base, hasNewerFacts: false, changes };
  }
  const tsaStatus = (input.tsa.status ?? "").toUpperCase();
  if (tsaStatus === "STAMPED" && after(input.tsa.validatedAtUtc, base)) {
    changes.push({ code: "TSA_VALIDATED_AFTER_REPORT", atUtc: input.tsa.validatedAtUtc });
  } else if (
    input.reportTsaStatus != null &&
    tsaStatus !== "" &&
    input.reportTsaStatus.toUpperCase() !== tsaStatus
  ) {
    changes.push({ code: "TSA_STATUS_CHANGED_AFTER_REPORT", atUtc: null });
  }
  // Only an INDEPENDENT Bitcoin-chain verification the report could not state
  // is a newer fact worth a new version. An attestation the proof merely names
  // is not: it is not a verification, and offering a version for it would
  // carry the same unchecked claim. A report that already stated
  // CHAIN_VERIFIED needs nothing.
  if (otsChainVerifiedAfterReport(input.ots)) {
    changes.push({ code: "OTS_CHAIN_VERIFIED_AFTER_REPORT", atUtc: input.ots.verifiedAtUtc ?? null });
  }
  const groups = (input.custodyAfterReport.groups ?? []).filter((g) => g.count > 0);
  if (groups.length > 0) {
    for (const g of [...groups].sort((a, b) => REPORTABLE_CUSTODY_REASONS.indexOf(a.reason) - REPORTABLE_CUSTODY_REASONS.indexOf(b.reason))) {
      changes.push({ code: "CUSTODY_CHANGED_AFTER_REPORT", atUtc: g.latestAtUtc, count: g.count, reason: g.reason, firstAtUtc: g.firstAtUtc });
    }
  } else if ((input.custodyAfterReport.count ?? 0) > 0) {
    changes.push({
      code: "CUSTODY_CHANGED_AFTER_REPORT",
      atUtc: input.custodyAfterReport.latestAtUtc ?? null,
      count: input.custodyAfterReport.count,
      reason: null,
      firstAtUtc: null,
    });
  }
  if (
    after(input.integrity.lastVerifiedAtUtc, base) &&
    input.integrity.lastVerifiedAtUtc !== input.integrity.reportLastVerifiedAtUtc
  ) {
    changes.push({ code: "INTEGRITY_REVERIFIED_AFTER_REPORT", atUtc: input.integrity.lastVerifiedAtUtc });
  }
  return { reportVersion: input.reportVersion, reportGeneratedAtUtc: base, hasNewerFacts: changes.length > 0, changes };
}

/** One sentence per freshness change, naming the report version it postdates. */
export function reportFreshnessChangeCopy(
  change: ReportFreshnessChange,
  reportVersion: number | null,
): string {
  const v = reportVersion != null ? `report v${reportVersion}` : "the latest report";
  switch (change.code) {
    case "TSA_VALIDATED_AFTER_REPORT":
      return `Trusted timestamp validation completed after ${v}.`;
    case "TSA_STATUS_CHANGED_AFTER_REPORT":
      return `The trusted timestamp's status changed after ${v}.`;
    case "OTS_CHAIN_VERIFIED_AFTER_REPORT":
      return `Bitcoin verification completed after ${v}: the anchor was independently checked against the Bitcoin main chain.`;
    case "CUSTODY_CHANGED_AFTER_REPORT": {
      const n = change.count ?? 0;
      if (change.reason) {
        const [one, many] = REPORTABLE_CUSTODY_REASON_NOUNS[change.reason];
        return n === 1 ? `A ${one} recorded after ${v}.` : `${n} ${many} recorded after ${v}.`;
      }
      return n === 1
        ? `1 reportable evidence-custody fact was recorded after ${v}.`
        : `${n || "Some"} reportable evidence-custody facts were recorded after ${v}.`;
    }
    case "INTEGRITY_REVERIFIED_AFTER_REPORT":
      return `The record's integrity was re-verified after ${v}.`;
    default:
      return `Verification facts changed after ${v}.`;
  }
}

// ===========================================================================
// DURABLE PROGRESS
// ===========================================================================

/**
 * The fine-grained boundary a running request has reached, persisted by the
 * worker on `report_generation_requests.progress_stage` (fenced by its claim).
 * The coarse `stage` column keeps its own meaning (REPORT_RESERVED /
 * REPORT_COMMITTED / PACKAGE_PUBLISHED) — it fences version reservation and
 * must not be overloaded with display steps.
 */
export const OUTPUT_PROGRESS_STAGES = [
  "RENDERING_REPORT",
  "VERIFYING_REPORT",
  "BUILDING_PACKAGE",
  "VERIFYING_PACKAGE",
] as const;
export type OutputProgressStage = (typeof OUTPUT_PROGRESS_STAGES)[number];

export const OUTPUT_PROGRESS_STEPS = [
  "ACCEPTED",
  "QUEUED",
  "GENERATING_REPORT",
  "VERIFYING_REPORT",
  "BUILDING_PACKAGE",
  "VERIFYING_PACKAGE",
  "COMPLETE",
] as const;
export type OutputProgressStep = (typeof OUTPUT_PROGRESS_STEPS)[number];

export const OUTPUT_PROGRESS_STEP_LABEL: Record<OutputProgressStep, string> = {
  ACCEPTED: "Request accepted",
  QUEUED: "Queued",
  GENERATING_REPORT: "Generating report",
  VERIFYING_REPORT: "Verifying report",
  BUILDING_PACKAGE: "Building verification package",
  VERIFYING_PACKAGE: "Verifying verification package",
  COMPLETE: "Complete",
};

export type OutputProgressStepStatus = "done" | "current" | "pending" | "failed" | "skipped";

export type OutputProgressOutcome = "ACTIVE" | "RETRYING" | "SUCCEEDED" | "FAILED" | "BLOCKED";

export type OutputProgressView = {
  outcome: OutputProgressOutcome;
  currentStep: OutputProgressStep;
  steps: Array<{ key: OutputProgressStep; label: string; status: OutputProgressStepStatus }>;
};

export type OutputProgressInput = {
  /** Persisted request state: QUEUED | PROCESSING | SUCCEEDED | FAILED_* | BLOCKED_*. */
  state: string;
  /** Coarse persisted stage (REPORT_RESERVED / REPORT_COMMITTED / PACKAGE_PUBLISHED). */
  stage: string | null;
  /** Fine persisted progress stage, when the worker recorded one. */
  progressStage: string | null;
  /** REPORT (report + package) or VERIFICATION_PACKAGE (package only). */
  artifactType: string;
};

const STEP_INDEX = (s: OutputProgressStep) => OUTPUT_PROGRESS_STEPS.indexOf(s);

/**
 * Project a durable request onto the seven steps. Derived ONLY from persisted
 * columns, so a reload, a second tab, another workspace member or a reconnect
 * all see the same thing; nothing advances on a client timer.
 */
export function projectOutputProgress(input: OutputProgressInput): OutputProgressView {
  const packageOnly = input.artifactType === "VERIFICATION_PACKAGE";
  const state = (input.state ?? "").toUpperCase();
  const stage = (input.stage ?? "").toUpperCase();
  const progress = (input.progressStage ?? "").toUpperCase();

  // The furthest step the durable columns prove was reached.
  let reached: OutputProgressStep = "QUEUED";
  if (state === "PROCESSING" || state.startsWith("FAILED") || state.startsWith("BLOCKED")) {
    reached = packageOnly ? "BUILDING_PACKAGE" : "GENERATING_REPORT";
  }
  const fromProgress: Record<string, OutputProgressStep> = {
    RENDERING_REPORT: "GENERATING_REPORT",
    VERIFYING_REPORT: "VERIFYING_REPORT",
    BUILDING_PACKAGE: "BUILDING_PACKAGE",
    VERIFYING_PACKAGE: "VERIFYING_PACKAGE",
  };
  const fromStage: Record<string, OutputProgressStep> = {
    REPORT_RESERVED: "GENERATING_REPORT",
    REPORT_COMMITTED: "BUILDING_PACKAGE",
    PACKAGE_PUBLISHED: "VERIFYING_PACKAGE",
  };
  for (const s of [fromProgress[progress], fromStage[stage]]) {
    if (s && STEP_INDEX(s) > STEP_INDEX(reached)) reached = s;
  }
  // A queued request — first attempt or a re-queued retry — is waiting, whatever
  // step an earlier attempt reached.
  if (state === "QUEUED") reached = "QUEUED";

  const outcome: OutputProgressOutcome =
    state === "SUCCEEDED"
      ? "SUCCEEDED"
      : state === "FAILED_RETRYABLE"
        ? "RETRYING"
        : state === "FAILED_TERMINAL"
          ? "FAILED"
          : state.startsWith("BLOCKED")
            ? "BLOCKED"
            : "ACTIVE";

  const current: OutputProgressStep = outcome === "SUCCEEDED" ? "COMPLETE" : reached;
  const steps = OUTPUT_PROGRESS_STEPS.map((key) => {
    let status: OutputProgressStepStatus;
    if (packageOnly && (key === "GENERATING_REPORT" || key === "VERIFYING_REPORT")) {
      status = "skipped";
    } else if (outcome === "SUCCEEDED") {
      status = "done";
    } else if (STEP_INDEX(key) < STEP_INDEX(current)) {
      status = "done";
    } else if (key === current) {
      status = outcome === "FAILED" || outcome === "BLOCKED" ? "failed" : "current";
    } else {
      status = "pending";
    }
    return { key, label: OUTPUT_PROGRESS_STEP_LABEL[key], status };
  });
  return { outcome, currentStep: current, steps };
}

/** The durable request a surface follows: projection plus support reference. */
export type OutputActiveRequestView = {
  requestId: string;
  /** NEW_VERSION | GENERATE | RECOVER | RETRY | OPERATOR_SUPERSEDE | null (legacy). */
  intent: string | null;
  artifactType: string;
  state: string;
  stage: string | null;
  progressStage: string | null;
  targetVersion: number | null;
  terminalReasonCode: string | null;
  attemptCount: number;
  createdAtUtc: string;
  updatedAtUtc: string;
  completedAtUtc: string | null;
};

// ===========================================================================
// RGA-01 — THE ONE TYPED OPERATION-ERROR AUTHORITY
// ===========================================================================

export const OUTPUT_OPERATION_ERROR_KEYS = [
  "OFFER_LOAD_FAILED",
  "OFFER_STALE",
  "REASON_INVALID",
  "REQUEST_ACTIVE",
  "VERSION_CONFLICT",
  "TECHNICAL_TERMINAL_RETRYABLE",
  "RETRY_BUDGET_EXHAUSTED",
  "INTEGRITY_TERMINAL",
  "PERMISSION_REFUSED",
  "MEMBERSHIP_REFUSED",
  "PLAN_REFUSED",
  /** ET-COM-06 — a first report waits for confirmed payment (trial / grace). */
  "PAYMENT_CONFIRMATION_REQUIRED",
  /** The record has no workspace a request can be scoped to. */
  "WORKSPACE_UNRESOLVED",
  "CREDIT_REFUSED",
  "STORAGE_REFUSED",
  "POLICY_REFUSED",
  "LEGAL_HOLD",
  "RATE_LIMITED",
  "QUEUE_UNAVAILABLE",
  "ENQUEUE_FAILED",
  "WORKER_FAILED",
  "REPORT_RENDER_FAILED",
  "REPORT_PUBLICATION_FAILED",
  "REPORT_READBACK_FAILED",
  /** The rendered PDF could not be read back and checked, so it was not issued. */
  "REPORT_VERIFICATION_FAILED",
  "PACKAGE_RENDER_FAILED",
  "PACKAGE_PUBLICATION_FAILED",
  "PACKAGE_READBACK_FAILED",
  "REPORT_OBJECT_MISSING",
  "PACKAGE_OBJECT_MISSING",
  "RECOVERY_REQUIRED",
  "UNKNOWN",
] as const;
export type OutputOperationErrorKey = (typeof OUTPUT_OPERATION_ERROR_KEYS)[number];

export type OutputOperationErrorAction = "RETRY" | "RECOVER" | "REFRESH" | "CONTACT_SUPPORT" | "NONE";

export type OutputOperationError = {
  key: OutputOperationErrorKey;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
  /** The SAME operation may be attempted again unchanged. */
  retryable: boolean;
  action: OutputOperationErrorAction;
  /** A durable support reference (request id) may be shown beside it. */
  showSupportReference: boolean;
};

type Def = Omit<OutputOperationError, "key">;
const def = (
  title: string,
  description: string,
  severity: Def["severity"],
  retryable: boolean,
  action: OutputOperationErrorAction,
  showSupportReference = false,
): Def => ({ title, description, severity, retryable, action, showSupportReference });

/** The catalog. Every user-visible failure on this journey reads from here. */
export const OUTPUT_OPERATION_ERRORS: Record<OutputOperationErrorKey, Def> = {
  OFFER_LOAD_FAILED: def("Couldn't load the current report options", "The record's current state could not be read. Refresh to try again.", "warning", true, "REFRESH"),
  OFFER_STALE: def("This record changed", "Something this confirmation depended on changed while it was open. Review the current details and confirm again.", "warning", false, "REFRESH"),
  REASON_INVALID: def("A valid reason is required", "Say why an updated report is being issued.", "warning", false, "NONE"),
  REQUEST_ACTIVE: def("A report request is already in progress", "Wait for the current request to finish; its progress is shown on this page.", "info", false, "REFRESH"),
  VERSION_CONFLICT: def("A newer version already exists", "Another request completed a newer report version. Review the latest version before issuing another.", "info", false, "REFRESH"),
  TECHNICAL_TERMINAL_RETRYABLE: def("The last attempt failed", "Report generation failed for a technical reason. You can try again.", "warning", true, "RETRY", true),
  RETRY_BUDGET_EXHAUSTED: def("Report generation needs an operator", "This output could not be generated after repeated attempts, and it was reported to your workspace operators. A member who can resolve workspace operations can retry it; otherwise contact support with the reference below.", "error", false, "CONTACT_SUPPORT", true),
  INTEGRITY_TERMINAL: def("This record needs review", "A stored artifact or the record itself failed an integrity check, so nothing is regenerated automatically. Contact support with the reference below.", "error", false, "CONTACT_SUPPORT", true),
  PERMISSION_REFUSED: def("You don't have permission to do that", "You can view this record, but you can't generate or recover its report and verification package.", "warning", false, "NONE"),
  MEMBERSHIP_REFUSED: def("This record isn't available to you", "You may no longer be a member of the workspace that holds it.", "warning", false, "NONE"),
  PLAN_REFUSED: def("Not included for this record", "The plan that covers this record does not include its report and verification package.", "info", false, "NONE"),
  PAYMENT_CONFIRMATION_REQUIRED: def("Waiting for confirmed payment", "This record's first report is issued once the subscription's payment is confirmed. A trial or a payment grace period does not issue it, so nothing was requested.", "info", false, "NONE"),
  WORKSPACE_UNRESOLVED: def("This record needs a workspace association", "A new report or verification package can't be requested until this older record is associated with a workspace. Everything already generated for it stays available.", "info", false, "NONE"),
  CREDIT_REFUSED: def("Not enough evidence credit", "This action needs an evidence credit the workspace does not have.", "info", false, "NONE"),
  STORAGE_REFUSED: def("Workspace storage is full", "A new report and verification package would exceed the workspace storage allowance.", "warning", false, "NONE"),
  POLICY_REFUSED: def("Blocked by workspace policy", "The workspace's policy does not allow this now.", "info", false, "NONE"),
  LEGAL_HOLD: def("The record is under legal hold", "A legal hold preserves the record as it is; a new report version can't be issued while it is in force.", "info", false, "NONE"),
  RATE_LIMITED: def("Too many requests", "Too many report requests were made recently. Try again later.", "info", true, "RETRY"),
  QUEUE_UNAVAILABLE: def("Report generation is temporarily unavailable", "The request could not be queued right now. Try again shortly.", "warning", true, "RETRY"),
  ENQUEUE_FAILED: def("The request was saved but not started", "It will be picked up automatically; if it does not start, try again.", "warning", true, "RETRY", true),
  WORKER_FAILED: def("Report generation failed", "The report could not be generated this time.", "error", true, "RETRY", true),
  REPORT_RENDER_FAILED: def("The report could not be rendered", "Rendering the report PDF failed.", "error", true, "RETRY", true),
  REPORT_PUBLICATION_FAILED: def("The report could not be stored", "The report was rendered but could not be written to storage.", "error", true, "RETRY", true),
  REPORT_VERIFICATION_FAILED: def("The report could not be verified", "The report PDF was rendered but could not be read back and checked against the record, so it was not issued. The evidence record and its integrity data are unaffected.", "error", true, "RETRY", true),
  REPORT_READBACK_FAILED: def("The stored report could not be verified", "The report was stored but reading it back did not match what was written.", "error", true, "RETRY", true),
  PACKAGE_RENDER_FAILED: def("The verification package could not be built", "Building the verification package failed.", "error", true, "RECOVER", true),
  PACKAGE_PUBLICATION_FAILED: def("The verification package could not be stored", "The package was built but could not be written to storage.", "error", true, "RECOVER", true),
  PACKAGE_READBACK_FAILED: def("The stored package could not be verified", "The package was stored but reading it back did not match what was written.", "error", true, "RECOVER", true),
  // An issued version is immutable: a missing stored file is never re-generated
  // in place, so these are support matters, not recovery verbs.
  REPORT_OBJECT_MISSING: def("The report file is missing", "The report record exists, but its stored file is unavailable. Contact support; nothing has been changed.", "warning", false, "CONTACT_SUPPORT", true),
  PACKAGE_OBJECT_MISSING: def("The verification package file is missing", "The package record exists, but its stored file is unavailable. Contact support; nothing has been changed.", "warning", false, "CONTACT_SUPPORT", true),
  RECOVERY_REQUIRED: def("Recovery is required", "Part of this record's report and verification package is missing and can be recovered.", "warning", false, "RECOVER"),
  UNKNOWN: def("Something went wrong", "The request could not be completed. Try again, or contact support with the reference below if it keeps happening.", "error", true, "RETRY", true),
};

export function outputOperationError(key: OutputOperationErrorKey): OutputOperationError {
  return { key, ...OUTPUT_OPERATION_ERRORS[key] };
}

/** A bounded unavailable reason (from the decision) as an operation error. */
export function outputOperationErrorForReason(reason: string | null | undefined): OutputOperationError | null {
  switch ((reason ?? "").toUpperCase()) {
    case "IN_PROGRESS":
      return outputOperationError("REQUEST_ACTIVE");
    case "PERMISSION_DENIED":
      return outputOperationError("PERMISSION_REFUSED");
    case "NOT_INCLUDED":
    case "ENTITLEMENT_UNAVAILABLE":
      return outputOperationError("PLAN_REFUSED");
    case "AWAITING_CONFIRMED_PAYMENT":
      return outputOperationError("PAYMENT_CONFIRMATION_REQUIRED");
    case "WORKSPACE_UNRESOLVED":
      return outputOperationError("WORKSPACE_UNRESOLVED");
    case "STORAGE_LIMIT":
      return outputOperationError("STORAGE_REFUSED");
    case "LEGAL_HOLD_ACTIVE":
      return outputOperationError("LEGAL_HOLD");
    case "BLOCKED_BY_POLICY":
    case "WORKSPACE_SUSPENDED":
    case "WORKSPACE_CLOSED":
      return outputOperationError("POLICY_REFUSED");
    case "ESCALATED_TO_OPERATOR":
      return outputOperationError("RETRY_BUDGET_EXHAUSTED");
    case "INTEGRITY_FAILED":
    case "REPORT_INTEGRITY_REVIEW":
    case "CONSISTENCY_REVIEW_REQUIRED":
      return outputOperationError("INTEGRITY_TERMINAL");
    case "RETRY_AVAILABLE":
      return outputOperationError("TECHNICAL_TERMINAL_RETRYABLE");
    case "PAIR_INCOMPLETE":
      return outputOperationError("RECOVERY_REQUIRED");
    default:
      return null;
  }
}

/**
 * A durable request's terminal reason (bounded worker code) and the step it
 * failed at, as an operation error. INTEGRITY classes never offer a retry.
 */
export function outputOperationErrorForTerminal(input: {
  terminalReasonCode: string | null | undefined;
  failedStep?: OutputProgressStep | null;
  /** The writer's supersession budget is spent (operator escalation). */
  budgetExhausted?: boolean;
}): OutputOperationError {
  const code = (input.terminalReasonCode ?? "").trim().toUpperCase();
  if (
    code === "REPORT_INTEGRITY_MISMATCH" ||
    code === "REPORT_INTEGRITY_UNVERIFIABLE" ||
    code === "EVIDENCE_INTEGRITY_FAILED" ||
    code === "FAILED_HASH_MISMATCH" ||
    code === "REPORT_VERSION_NOT_FOUND" ||
    code === "REPORT_MISSING_FOR_REPORTED_EVIDENCE"
  ) {
    return outputOperationError("INTEGRITY_TERMINAL");
  }
  if (code === "REPORT_OBJECT_MISSING") return outputOperationError("REPORT_OBJECT_MISSING");
  if (code === "REPORT_PDF_VERIFICATION_FAILED") return outputOperationError("REPORT_VERIFICATION_FAILED");
  if (code === "LEGAL_HOLD_ACTIVE") return outputOperationError("LEGAL_HOLD");
  if (code.includes("NOT_INCLUDED")) return outputOperationError("PLAN_REFUSED");
  if (code.includes("ALLOWANCE") || code.includes("STORAGE_LIMIT") || code.includes("QUOTA")) {
    return outputOperationError("STORAGE_REFUSED");
  }
  if (code.startsWith("BLOCKED") || code.includes("POLICY") || code === "ORGANIZATION_NOT_ACTIVE") {
    return outputOperationError("POLICY_REFUSED");
  }
  if (input.budgetExhausted) return outputOperationError("RETRY_BUDGET_EXHAUSTED");
  switch (input.failedStep ?? null) {
    case "GENERATING_REPORT":
      return outputOperationError("REPORT_RENDER_FAILED");
    case "VERIFYING_REPORT":
      return outputOperationError(code.includes("CHECKSUM") || code.includes("HEAD") ? "REPORT_READBACK_FAILED" : "REPORT_PUBLICATION_FAILED");
    case "BUILDING_PACKAGE":
      return outputOperationError("PACKAGE_RENDER_FAILED");
    case "VERIFYING_PACKAGE":
      return outputOperationError(code.includes("CHECKSUM") || code.includes("HEAD") ? "PACKAGE_READBACK_FAILED" : "PACKAGE_PUBLICATION_FAILED");
    default:
      return outputOperationError("WORKER_FAILED");
  }
}

/**
 * THE response-side resolver: an HTTP failure (or a declined 2xx/409 body)
 * from the generation endpoint, the status endpoint or a download, mapped to
 * one typed error. `null` input fields are fine. Never returns raw server text.
 */
export function outputOperationErrorForOutcome(outcome: string | null | undefined): OutputOperationError | null {
  switch ((outcome ?? "").trim().toUpperCase()) {
    case "NOT_INCLUDED":
    case "ENTITLEMENT_UNAVAILABLE":
      return outputOperationError("PLAN_REFUSED");
    case "WORKSPACE_UNRESOLVED":
      return outputOperationError("WORKSPACE_UNRESOLVED");
    case "EVIDENCE_NOT_FOUND":
      return outputOperationError("MEMBERSHIP_REFUSED");
    case "RECOVERABLE_BLOCKED":
      return outputOperationError("POLICY_REFUSED");
    case "QUEUE_UNAVAILABLE":
      return outputOperationError("QUEUE_UNAVAILABLE");
    case "ALREADY_ACTIVE":
      return outputOperationError("REQUEST_ACTIVE");
    case "REQUEST_PERSIST_FAILED":
    case "REQUESTER_REQUIRED":
      return outputOperationError("UNKNOWN");
    default:
      return null;
  }
}

export function resolveOutputOperationError(input: {
  status?: number | null;
  code?: string | null;
  reason?: string | null;
  /** The declined request's typed generation outcome (`details.outcome`). */
  outcome?: string | null;
  /** The request never received an answer (network loss, timeout). */
  network?: boolean;
}): OutputOperationError {
  const code = (input.code ?? "").trim();
  const upper = code.toUpperCase();
  if (input.network) return outputOperationError("OFFER_LOAD_FAILED");
  switch (upper) {
    case "OUTPUT_OFFER_STALE":
    case "OUTPUT_OFFER_REQUIRED":
      return outputOperationError("OFFER_STALE");
    case "UPDATED_REPORT_REASON_REQUIRED":
      return outputOperationError("REASON_INVALID");
    case "GENERATION_NOT_PERMITTED":
      return outputOperationError("PERMISSION_REFUSED");
    case "EVIDENCE_INTEGRITY_FAILED":
      return outputOperationError("INTEGRITY_TERMINAL");
    case "RATE_LIMITED":
    case "CONCURRENCY_LIMITED":
      return outputOperationError("RATE_LIMITED");
    case "QUEUE_UNAVAILABLE":
    case "REDIS_UNAVAILABLE":
      return outputOperationError("QUEUE_UNAVAILABLE");
    case "ENQUEUE_FAILED":
      return outputOperationError("ENQUEUE_FAILED");
    case "REPORT_ARTIFACT_MISSING":
      return outputOperationError("REPORT_OBJECT_MISSING");
    case "VERIFICATION_PACKAGE_ARTIFACT_MISSING":
      return outputOperationError("PACKAGE_OBJECT_MISSING");
    case "OUTPUT_ACTION_UNAVAILABLE": {
      const byReason = outputOperationErrorForReason(input.reason);
      if (byReason) return byReason;
      break;
    }
    default:
      break;
  }
  if (upper.startsWith("BLOCKED") || upper.includes("POLICY") || upper.startsWith("GOVERNANCE")) {
    return outputOperationError("POLICY_REFUSED");
  }
  const byReason = outputOperationErrorForReason(input.reason);
  if (byReason) return byReason;
  // A declined generation request carries its typed OUTCOME (`details.outcome`)
  // even when it has no bounded reason. Read it before the status fallback:
  // a 409 refusal for a commercial or scoping answer is not a version conflict.
  const byOutcome = outputOperationErrorForOutcome(input.outcome);
  if (byOutcome) return byOutcome;
  switch (input.status ?? 0) {
    case 400:
      return outputOperationError("REASON_INVALID");
    case 401:
      return outputOperationError("OFFER_LOAD_FAILED");
    case 403:
      return outputOperationError("PERMISSION_REFUSED");
    case 404:
      return outputOperationError("MEMBERSHIP_REFUSED");
    case 409:
      return outputOperationError("VERSION_CONFLICT");
    case 410:
      return outputOperationError("RECOVERY_REQUIRED");
    case 429:
      return outputOperationError("RATE_LIMITED");
    case 502:
    case 503:
    case 504:
      return outputOperationError("QUEUE_UNAVAILABLE");
    default:
      return outputOperationError("UNKNOWN");
  }
}

// ===========================================================================
// THE EXPLAINED "UPDATE AVAILABLE" (2026-10-24)
// ===========================================================================

/** One explained reason a newer report is owed — privacy-safe, display-ready. */
export type ReportFreshnessReasonView = {
  /** Stable React/list key. */
  key: string;
  code: ReportFreshnessChangeCode;
  reason: ReportableCustodyReason | null;
  /** The sentence a person reads — never a payload, an id or an event code. */
  label: string;
  count: number | null;
  firstAtUtc: string | null;
  latestAtUtc: string | null;
};

export type ReportFreshnessExplanation = {
  /** The immutable version the explanation compares against; it stays unchanged. */
  reportVersion: number | null;
  /** The version a new generation would create. */
  nextVersion: number | null;
  /** How many reportable facts changed (custody groups count each fact; a TSA/OTS/integrity change counts once). */
  changeCount: number;
  reasons: ReportFreshnessReasonView[];
  /** When the earliest and latest of them were recorded, when known. */
  firstAtUtc: string | null;
  latestAtUtc: string | null;
};

/**
 * Explain a freshness result for every surface (Evidence ID card, Reports,
 * mobile): the server builds it once from the owed-report authority's result,
 * so no client composes or derives it. Empty when nothing is owed — internal
 * Review activity never appears here.
 */
export function explainReportFreshness(
  freshness: ReportFreshness | null | undefined,
  opts: { nextVersion?: number | null } = {},
): ReportFreshnessExplanation | null {
  if (!freshness) return null;
  const reasons = freshness.changes.map((c, i): ReportFreshnessReasonView => ({
    key: `${c.code}:${c.reason ?? "-"}:${i}`,
    code: c.code,
    reason: c.reason ?? null,
    label: reportFreshnessChangeCopy(c, freshness.reportVersion),
    count: c.count ?? null,
    firstAtUtc: c.firstAtUtc ?? c.atUtc ?? null,
    latestAtUtc: c.atUtc ?? null,
  }));
  const times = (pick: (r: ReportFreshnessReasonView) => string | null) =>
    reasons.map(pick).filter((t): t is string => typeof t === "string").sort();
  const firsts = times((r) => r.firstAtUtc);
  const lasts = times((r) => r.latestAtUtc);
  return {
    reportVersion: freshness.reportVersion,
    nextVersion: opts.nextVersion ?? (freshness.reportVersion != null ? freshness.reportVersion + 1 : null),
    changeCount: reasons.reduce((n, r) => n + (r.count ?? 1), 0),
    reasons,
    firstAtUtc: firsts[0] ?? null,
    latestAtUtc: lasts.at(-1) ?? null,
  };
}
