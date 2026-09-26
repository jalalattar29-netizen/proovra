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
      case "RECOVER":
        return compact ? "Recover package" : "Recover verification package";
      case "RETRY":
        // Offered only once the report exists: it retries the package's
        // recovery around that stored report.
        return compact ? "Retry recovery" : "Retry package recovery";
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

/** The separate, optional action. Never a recovery verb. */
export const NEW_VERSION_LABEL = "Create new version";

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
      return "Automatic retries were exhausted, so this has been reported to your workspace operators, who can retry it from Operations. The evidence record and any existing downloads are unaffected.";
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
      ? `Creates report version ${input.nextVersion} and its verification package${
          input.currentVersion != null ? `, alongside version ${input.currentVersion}` : ""
        }.`
      : "Creates a new report and its verification package.",
  );
  lines.push("Earlier versions are kept unchanged and stay downloadable.");
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
