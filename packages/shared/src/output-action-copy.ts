/**
 * THE WORDS FOR THE OUTPUT ACTIONS — one table for web, PWA and native.
 *
 * `resolveEvidenceOutputActions` decides WHICH action an output offers and why
 * none is offered. This module only names them, so every surface says the
 * same thing for the same decision: a package-only recovery is never labelled
 * "Regenerate report", and the separate new-version action is never labelled
 * as recovery.
 *
 * Labels only. Nothing here decides whether an action is shown.
 */

import type {
  OutputAction,
  OutputActionUnavailableReason,
} from "./evidence-output-lifecycle.js";

export type OutputKind = "report" | "verificationPackage";

/**
 * The verb for an action on one output.
 *
 * `compact` is for dense rows (the Reports list); it is always a shortening of
 * the full label, never a different name.
 */
export function outputActionLabel(
  output: OutputKind,
  action: OutputAction,
  variant: "full" | "compact" = "full",
): string {
  const compact = variant === "compact";
  if (action === "NONE") return "";
  if (action === "REGENERATE") return NEW_VERSION_LABEL;
  if (output === "verificationPackage") {
    switch (action) {
      // Offered only once the report exists. Missing or failed, the click
      // produces ONLY the package profiles that report is still owed; the
      // stored report is never regenerated.
      case "RECOVER":
      case "RETRY":
        return compact ? "Retry package" : "Retry verification package";
      case "GENERATE":
        // A package is generated WITH its report; the report's action names it.
        return compact ? "Generate report & package" : "Generate report & verification package";
    }
  }
  switch (action) {
    case "GENERATE":
      return compact ? "Generate report & package" : "Generate report & verification package";
    case "RETRY":
      return compact ? "Retry report" : "Retry report generation";
    case "RECOVER":
      return compact ? "Recover report" : "Recover report";
  }
  return "";
}

/**
 * The separate, optional action. Never a recovery verb.
 *
 * 2026-09-29: an UPDATED REPORT is an exceptional, authorized issuance that
 * documents later facts (a later anchor, a corrected timestamp reading, new
 * custody events). It carries its own issue date and a stated reason, and it
 * never replaces or relabels the first issue.
 */
export const NEW_VERSION_LABEL = "Generate updated report";

/**
 * A sentence for a reason no action is offered — only for reasons a person
 * should read. `null` where the state panel or the progress indicator already
 * says it (nothing is needed, work is in flight, the record is not finalized).
 */
export function outputUnavailableReasonCopy(
  reason: OutputActionUnavailableReason | null | undefined,
): string | null {
  switch (reason) {
    case null:
    case undefined:
    case "NOT_REQUIRED":
    case "IN_PROGRESS":
    case "FOLLOWS_REPORT":
    case "NOT_FINALIZED":
    case "INTEGRITY_FAILED":
    case "NOT_INCLUDED":
    case "PAIR_INCOMPLETE":
      return null;
    case "ESCALATED_TO_OPERATOR":
      return "Automatic retries were exhausted, so this has been reported to your workspace operators. A member who can resolve workspace operations can retry it from this record or from Operations. The evidence record and any existing downloads are unaffected.";
    case "REPORT_INTEGRITY_REVIEW":
      return "The stored report could not be verified, so it will not be used or replaced automatically. The issue has been reported for review; the evidence record is unaffected.";
    case "CONSISTENCY_REVIEW_REQUIRED":
      return "This record's outputs need a review before anything is regenerated. The issue has been reported.";
    case "LEGAL_HOLD_ACTIVE":
      return "A legal hold preserves this record as it is, so a new version cannot be created while it is in place.";
    case "WORKSPACE_SUSPENDED":
      return "This workspace is suspended, so outputs cannot be generated right now.";
    case "WORKSPACE_CLOSED":
      return "This workspace is closed, so outputs cannot be generated.";
    case "EVIDENCE_TRASHED":
      return "This record is in the trash. Restore it to generate or recover its outputs.";
    case "EVIDENCE_ARCHIVED":
      return "This record is archived. Outputs are not generated for archived records.";
    case "PENDING_DESTRUCTION":
      return "This record is scheduled for destruction, so no new outputs are generated.";
    case "EVIDENCE_DESTROYED":
      return "This record has been destroyed.";
    case "BLOCKED_BY_POLICY":
      return "A workspace policy currently prevents generating this output. It becomes possible again when that decision changes.";
    case "PERMISSION_DENIED":
      return "Generating or recovering outputs for this record needs a role with that permission.";
    case "WORKSPACE_UNRESOLVED":
      return "This older record needs a workspace association before a new report or verification package can be requested. Everything already generated for it stays available.";
    case "STORAGE_LIMIT":
      return "A new version would exceed this workspace's storage allowance.";
    case "RETRY_AVAILABLE":
      return "The last attempt failed and can be retried first.";
    case "ACTIONS_UNAVAILABLE":
      return "The actions for this record could not be loaded right now. They will return when the page refreshes.";
  }
  return null;
}

/**
 * The same reasons, as a short badge for dense rows. Null exactly where
 * `outputUnavailableReasonCopy` is null, so a row and a detail page never
 * disagree about whether there is something to say.
 */
export function outputUnavailableReasonShort(
  reason: OutputActionUnavailableReason | null | undefined,
): string | null {
  if (outputUnavailableReasonCopy(reason) === null) return null;
  switch (reason) {
    case "ESCALATED_TO_OPERATOR":
      return "Escalated to operators";
    case "REPORT_INTEGRITY_REVIEW":
      return "Report under integrity review";
    case "CONSISTENCY_REVIEW_REQUIRED":
      return "Needs review";
    case "LEGAL_HOLD_ACTIVE":
      return "Legal hold";
    case "WORKSPACE_SUSPENDED":
      return "Workspace suspended";
    case "WORKSPACE_CLOSED":
      return "Workspace closed";
    case "EVIDENCE_TRASHED":
      return "In trash";
    case "EVIDENCE_ARCHIVED":
      return "Archived";
    case "PENDING_DESTRUCTION":
      return "Scheduled for destruction";
    case "EVIDENCE_DESTROYED":
      return "Destroyed";
    case "BLOCKED_BY_POLICY":
      return "Blocked by policy";
    case "PERMISSION_DENIED":
      return "Needs permission";
    case "WORKSPACE_UNRESOLVED":
      return "Needs a workspace association";
    case "STORAGE_LIMIT":
      return "Storage limit reached";
    case "RETRY_AVAILABLE":
      return "Retry available";
    case "ACTIONS_UNAVAILABLE":
      return "Actions unavailable";
  }
  return null;
}

/** Bytes, for an estimate. Never more precise than an estimate deserves. */
export function formatEstimatedBytes(raw: string | number | null | undefined): string | null {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (n == null || !Number.isFinite(n) || n < 0) return null;
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${Math.round(v)} bytes` : `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * What creating a new version does, stated before it happens. The estimate
 * is labelled as one, with what it is based on; with no estimate, that is
 * said too.
 */
export function newVersionConsequence(input: {
  currentVersion: number | null;
  nextVersion: number | null;
  estimate: { estimatedBytes: string; basis: "PREVIOUS_PAIR" | "ORIGINAL_EVIDENCE" } | null;
}): string[] {
  const lines: string[] = [];
  lines.push(
    input.nextVersion != null
      ? `Issues report version ${input.nextVersion}, dated today, and its verification package${
          input.currentVersion != null ? `, alongside version ${input.currentVersion}` : ""
        }.`
      : "Issues a new report, dated today, and its verification package.",
  );
  lines.push("It documents facts as they stand now. Earlier versions are kept unchanged, keep their own dates and stay downloadable.");
  const size = input.estimate ? formatEstimatedBytes(input.estimate.estimatedBytes) : null;
  lines.push(
    size
      ? `Estimated additional storage: about ${size} (${
          input.estimate!.basis === "PREVIOUS_PAIR"
            ? "based on the current report and package, which includes a copy of the original evidence"
            : "based on the original evidence, which the package includes a copy of"
        }).`
      : "The additional storage cannot be estimated for this record; it includes a copy of the original evidence.",
  );
  lines.push("No evidence credit is charged. The original evidence and its timestamps are not changed.");
  return lines;
}

/**
 * The worker's terminal code for "the signed original was not readable at its
 * recorded storage location" (a store 404). Mirrors the worker constant; the
 * worker cannot import this package's copy, and the code is the contract.
 */
export const ORIGINAL_NOT_READABLE_TERMINAL_CODE = "EVIDENCE_ORIGINAL_NOT_FOUND";

/**
 * THE WORDS FOR A TERMINAL REASON THAT NEEDS ITS OWN SENTENCE (2026-09-29).
 *
 * Copy only — it decides nothing, and it does not change the action or the
 * reason the lifecycle resolved. A surface that holds the bounded terminal
 * code shows this INSTEAD of the reason copy, because the reason for this
 * code (operator escalation) comes with "Automatic retries were exhausted",
 * which is false here: the worker stops on the first confirmed 404.
 *
 * It must never read as destruction or as a failed hash or signature: a 404
 * at the recorded key means only that the bytes cannot currently be read
 * there (a delete marker, a wrong key or bucket, or a missing object are all
 * possible). It names nothing about storage — no key, no file name.
 */
export function outputTerminalReasonCopy(
  terminalReasonCode: string | null | undefined,
): { short: string; copy: string } | null {
  if ((terminalReasonCode ?? "").trim().toUpperCase() !== ORIGINAL_NOT_READABLE_TERMINAL_CODE) {
    return null;
  }
  return {
    short: "Original unreadable — under operator review",
    copy:
      "The signed original cannot currently be read from storage. No report or package was built from replacement bytes. This has been sent for operator review; the record's fingerprint, signature and custody history are unchanged.",
  };
}

/**
 * The sentence (and short badge) a surface shows beside an output that offers
 * no action: the terminal-code copy when it has one, else the reason copy.
 * Every web, PWA and native site that used `outputUnavailableReasonCopy` /
 * `…Short` directly reads this instead, so the two cannot disagree.
 */
export function outputNoteCopy(output: {
  actionUnavailableReason?: OutputActionUnavailableReason | string | null;
  terminalReasonCode?: string | null;
}): string | null {
  return (
    outputTerminalReasonCopy(output.terminalReasonCode)?.copy ??
    outputUnavailableReasonCopy(output.actionUnavailableReason as OutputActionUnavailableReason | null)
  );
}

export function outputNoteShort(output: {
  actionUnavailableReason?: OutputActionUnavailableReason | string | null;
  terminalReasonCode?: string | null;
}): string | null {
  return (
    outputTerminalReasonCopy(output.terminalReasonCode)?.short ??
    outputUnavailableReasonShort(output.actionUnavailableReason as OutputActionUnavailableReason | null)
  );
}

/**
 * A caller idempotency key for one explicit request. Kept for the life of
 * one confirmation, so a retry after a lost response reuses it and the server
 * returns the first request instead of creating a second version.
 */
export function makeClientRequestKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `nv-${c.randomUUID()}`;
  const rnd = () => Math.random().toString(36).slice(2, 10);
  return `nv-${Date.now().toString(36)}-${rnd()}${rnd()}`;
}

// ===========================================================================
// RGA-03 — THE ONE reason authority for an updated report (NEW_VERSION).
// ===========================================================================
//
// The minimum and maximum live here so the API route (server authority), the web
// modal, and native all enforce the SAME bounds and the SAME normalization. A
// reason is single-line, free of control/invisible characters and angle brackets,
// whitespace-collapsed, trimmed, and length-bounded. It is NEVER the idempotency
// identity (that is the client request key), so two different reasons do not
// create two versions and the same reason does not collapse two legitimate ones.

export const NEW_VERSION_REASON_MIN = 3;
export const NEW_VERSION_REASON_MAX = 120;

/**
 * Canonical normalization for an updated-report reason. Pure and dependency-free
 * (safe in the API, the browser and native). Strips C0/C1 control characters and
 * Unicode invisibles, removes angle brackets, collapses whitespace, trims, and
 * bounds to NEW_VERSION_REASON_MAX.
 */
export function normalizeNewVersionReason(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    // Stripping control characters is the point of this normalizer.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, "")
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NEW_VERSION_REASON_MAX);
}

export type NewVersionReasonValidation =
  | { ok: true; value: string }
  | { ok: false; value: string; reason: "EMPTY" | "TOO_SHORT" | "TOO_LONG" };

/**
 * Validate an updated-report reason against the canonical bounds, returning the
 * normalized value and a typed failure. The server rejects on `ok: false`; a
 * client disables Confirm on it and shows the matching inline message.
 * `TOO_LONG` can only arise from the raw length before truncation, so clients can
 * warn before the value is silently clipped.
 */
export function validateNewVersionReason(raw: unknown): NewVersionReasonValidation {
  const value = normalizeNewVersionReason(raw);
  const rawTrimmedLength = typeof raw === "string" ? raw.trim().length : 0;
  if (value.length === 0) return { ok: false, value, reason: "EMPTY" };
  if (value.length < NEW_VERSION_REASON_MIN) return { ok: false, value, reason: "TOO_SHORT" };
  if (rawTrimmedLength > NEW_VERSION_REASON_MAX) return { ok: false, value, reason: "TOO_LONG" };
  return { ok: true, value };
}

/** The inline message for each typed reason-validation failure (one copy). */
export function newVersionReasonError(
  reason: "EMPTY" | "TOO_SHORT" | "TOO_LONG",
): string {
  switch (reason) {
    case "EMPTY":
      return "Say why an updated report is being issued.";
    case "TOO_SHORT":
      return `Give at least ${NEW_VERSION_REASON_MIN} characters.`;
    case "TOO_LONG":
      return `Keep the reason to ${NEW_VERSION_REASON_MAX} characters or fewer.`;
    default:
      return "Enter a valid reason.";
  }
}
