/**
 * Evidence record — the ONE classification of what a record's facts ask of
 * the person reading it (2026-10-23).
 *
 * The Evidence ID page used to assemble its "What needs attention" strip and
 * its "Risk Signals" rail in the browser: the server's reviewer alerts, plus
 * four signals the web derived from source context itself, plus case and
 * review prompts — all rendered as the same kind of pill. "Review ready" (a
 * POSITIVE state), "Imported upload" (provenance), "File timestamp note" (an
 * advisory) and "No case assigned" (optional metadata) therefore sat under a
 * heading that says something needs attention, and the rail repeated them as
 * large cards.
 *
 * This module classifies every one of those facts ONCE, by a stable machine
 * code — never by colour or by copy — into one of five categories:
 *
 *   ACTION_REQUIRED     a current failure or block, or an action policy
 *                       requires;
 *   ACTION_RECOMMENDED  a useful workflow step the viewer can take; the
 *                       evidence is not unhealthy;
 *   ADVISORY            context worth understanding (a heuristic, a
 *                       limitation) — never a failure;
 *   HEALTHY             a positive state; never "needs attention";
 *   INFORMATIONAL       neutral provenance or workflow metadata.
 *
 * The API runs it (it knows the viewer's capabilities and the record's live
 * state) and sends the result; the web renders it and derives nothing.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const EVIDENCE_ATTENTION_CATEGORIES = [
  "ACTION_REQUIRED",
  "ACTION_RECOMMENDED",
  "ADVISORY",
  "HEALTHY",
  "INFORMATIONAL",
] as const;
export type EvidenceAttentionCategory = (typeof EVIDENCE_ATTENTION_CATEGORIES)[number];

/**
 * The semantic tone a category renders with — the existing PROOVRA token
 * families, never a colour per fact. Meaning is never carried by tone alone:
 * every item also has a label, and the strip a heading.
 */
export type EvidenceAttentionTone = "destructive" | "warning" | "advisory" | "success" | "info";

/** The one direct action an item may offer. The web maps each to a control. */
export type EvidenceAttentionAction = "ASSIGN_CASE" | "START_REVIEW" | "OPEN_ARTIFACTS";

/**
 * WHERE an item belongs on the page.
 *
 *   ATTENTION   the "What needs attention" strip (actionable only);
 *   SIGNAL      the rail's Risk Signals (a fact about the evidence);
 *   PROVENANCE  the source/provenance context, which already explains it;
 *   STATUS      a compact state line, never a card.
 */
export type EvidenceAttentionPlacement = "ATTENTION" | "SIGNAL" | "PROVENANCE" | "STATUS";

/** Output-lifecycle states an alert can be raised for. */
type OutputAlertState =
  | "QUEUED"
  | "GENERATING"
  | "ELIGIBLE_NOT_GENERATED"
  | "RETRYABLE_FAILURE"
  | "TERMINAL_FAILURE"
  | "BLOCKED";

/** The stable code of every server reviewer alert. */
export type EvidenceReviewerAlertCode =
  | "TRASH_RETENTION_ACTIVE"
  | "RECORD_SEALED"
  | "CUSTODY_CHAIN_ISSUE"
  | "INTEGRITY_FAILED"
  | "OTS_FAILED"
  | "OTS_UNAVAILABLE"
  | "STORAGE_RETENTION_ENDED"
  | "STORAGE_PROTECTION_INCOMPLETE"
  | "STORAGE_PROTECTION_UNCONFIRMED"
  | "NO_FLAGGED_ISSUES"
  | "PUBLIC_VERIFICATION_NOT_INCLUDED"
  | "VERIFICATION_PAGE_WITHDRAWN"
  | "VERIFICATION_PAGE_SUSPENDED"
  | "PACKAGE_POLICY_BLOCKED"
  | `REPORT_${OutputAlertState}`
  | `PACKAGE_${OutputAlertState}`;

/** Codes this module adds from source context and workflow facts. */
export type EvidenceAttentionDerivedCode =
  | "IMPORTED_UPLOAD"
  | "FILE_TIMESTAMP_NOTE"
  | "SCREENSHOT_FILENAME_HEURISTIC"
  | "GENERIC_MIME_TYPE"
  | "CASE_UNASSIGNED"
  | "REVIEW_NOT_STARTED";

export type EvidenceAttentionCode = EvidenceReviewerAlertCode | EvidenceAttentionDerivedCode;

export type EvidenceAttentionItem = {
  code: EvidenceAttentionCode;
  category: EvidenceAttentionCategory;
  tone: EvidenceAttentionTone;
  placement: EvidenceAttentionPlacement;
  label: string;
  detail: string;
  action: EvidenceAttentionAction | null;
};

/**
 * Whether linking a record to a case is expected (2026-10-23).
 *
 * No product rule anywhere requires or recommends a case for a record — cases
 * are an organising tool. So the policy is OPTIONAL for every workspace, and
 * an unassigned record is a workflow state, never an error. Stated as a
 * function so a future policy has exactly one place to live.
 */
export type CaseAssignmentPolicy = "OPTIONAL" | "RECOMMENDED" | "REQUIRED";
export function caseAssignmentPolicyFor(record: { inWorkspace: boolean }): CaseAssignmentPolicy {
  // OPTIONAL for personal and workspace records alike today; the record is
  // where a future policy will read.
  void record;
  return "OPTIONAL";
}

export type EvidenceAttention = {
  /** Every classified item, most urgent first. */
  items: EvidenceAttentionItem[];
  /**
   * What the strip may say. NO_ACTION renders a compact calm line, never the
   * "What needs attention" heading.
   */
  headline: "ACTION_REQUIRED" | "ACTION_RECOMMENDED" | "NO_ACTION";
  caseAssignment: { assigned: boolean; policy: CaseAssignmentPolicy };
};

// ---------------------------------------------------------------------------
// The classification table — by CODE
// ---------------------------------------------------------------------------

type Rule = {
  category: EvidenceAttentionCategory;
  tone: EvidenceAttentionTone;
  placement: EvidenceAttentionPlacement;
  action: EvidenceAttentionAction | null;
};

const required = (tone: EvidenceAttentionTone, action: EvidenceAttentionAction | null = null): Rule => ({
  category: "ACTION_REQUIRED",
  tone,
  placement: "ATTENTION",
  action,
});
const informational: Rule = { category: "INFORMATIONAL", tone: "info", placement: "STATUS", action: null };

const OUTPUT_RULES: Record<OutputAlertState, Rule> = {
  QUEUED: informational,
  GENERATING: informational,
  ELIGIBLE_NOT_GENERATED: {
    category: "ACTION_RECOMMENDED",
    tone: "info",
    placement: "ATTENTION",
    action: "OPEN_ARTIFACTS",
  },
  RETRYABLE_FAILURE: required("warning", "OPEN_ARTIFACTS"),
  TERMINAL_FAILURE: required("warning", "OPEN_ARTIFACTS"),
  BLOCKED: required("warning", "OPEN_ARTIFACTS"),
};

const ALERT_RULES: Record<EvidenceReviewerAlertCode, Rule> = {
  // A record in trash: its outputs and links are blocked until restored.
  TRASH_RETENTION_ACTIVE: required("destructive"),
  CUSTODY_CHAIN_ISSUE: required("destructive"),
  INTEGRITY_FAILED: required("destructive"),
  // An external anchor that failed is a current failure — but the detail
  // says, and the strip keeps, that fingerprint, signature and custody are
  // unaffected.
  OTS_FAILED: required("warning"),
  OTS_UNAVAILABLE: required("warning"),
  STORAGE_PROTECTION_INCOMPLETE: required("warning"),
  STORAGE_PROTECTION_UNCONFIRMED: required("warning"),
  STORAGE_RETENTION_ENDED: { category: "ADVISORY", tone: "advisory", placement: "SIGNAL", action: null },
  VERIFICATION_PAGE_SUSPENDED: { category: "ADVISORY", tone: "warning", placement: "SIGNAL", action: null },
  // A withdrawal is a recorded decision, stated by the Verification page row.
  VERIFICATION_PAGE_WITHDRAWN: informational,
  PUBLIC_VERIFICATION_NOT_INCLUDED: informational,
  RECORD_SEALED: { category: "HEALTHY", tone: "success", placement: "STATUS", action: null },
  NO_FLAGGED_ISSUES: { category: "HEALTHY", tone: "success", placement: "STATUS", action: null },
  PACKAGE_POLICY_BLOCKED: required("warning", "OPEN_ARTIFACTS"),
  REPORT_QUEUED: OUTPUT_RULES.QUEUED,
  REPORT_GENERATING: OUTPUT_RULES.GENERATING,
  REPORT_ELIGIBLE_NOT_GENERATED: OUTPUT_RULES.ELIGIBLE_NOT_GENERATED,
  REPORT_RETRYABLE_FAILURE: OUTPUT_RULES.RETRYABLE_FAILURE,
  REPORT_TERMINAL_FAILURE: OUTPUT_RULES.TERMINAL_FAILURE,
  REPORT_BLOCKED: OUTPUT_RULES.BLOCKED,
  PACKAGE_QUEUED: OUTPUT_RULES.QUEUED,
  PACKAGE_GENERATING: OUTPUT_RULES.GENERATING,
  PACKAGE_ELIGIBLE_NOT_GENERATED: OUTPUT_RULES.ELIGIBLE_NOT_GENERATED,
  PACKAGE_RETRYABLE_FAILURE: OUTPUT_RULES.RETRYABLE_FAILURE,
  PACKAGE_TERMINAL_FAILURE: OUTPUT_RULES.TERMINAL_FAILURE,
  PACKAGE_BLOCKED: OUTPUT_RULES.BLOCKED,
};

/** Is a string one of the alert codes this table classifies? */
export function isEvidenceReviewerAlertCode(code: unknown): code is EvidenceReviewerAlertCode {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(ALERT_RULES, code);
}

const CATEGORY_RANK: Record<EvidenceAttentionCategory, number> = {
  ACTION_REQUIRED: 0,
  ACTION_RECOMMENDED: 1,
  ADVISORY: 2,
  HEALTHY: 3,
  INFORMATIONAL: 4,
};
const TONE_RANK: Record<EvidenceAttentionTone, number> = {
  destructive: 0,
  warning: 1,
  advisory: 2,
  info: 3,
  success: 4,
};

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export type EvidenceAttentionInput = {
  /** The server's reviewer alerts, each with its stable code. */
  alerts: ReadonlyArray<{ code: EvidenceReviewerAlertCode; label: string; detail: string }>;
  /** Source-context facts the API recorded at intake. */
  source: {
    importedUpload: boolean;
    oldLastModified: boolean;
    screenshotLikeDetected: boolean;
    genericMime: boolean;
  };
  caseAssignment: {
    assigned: boolean;
    policy: CaseAssignmentPolicy;
    /** May THIS viewer link the record to a case? */
    viewerCanAssign: boolean;
  };
  review: {
    /** Does this workspace run a review workflow for this record at all? */
    applicable: boolean;
    /** No workflow row, or one in NOT_STARTED. */
    notStarted: boolean;
    /** May THIS viewer start it (claim or assign)? */
    viewerCanStart: boolean;
  };
};

export function classifyEvidenceAttention(input: EvidenceAttentionInput): EvidenceAttention {
  const items: EvidenceAttentionItem[] = [];
  const seen = new Set<string>();
  const add = (code: EvidenceAttentionCode, rule: Rule, label: string, detail: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    items.push({ code, ...rule, label, detail });
  };

  for (const alert of input.alerts) {
    add(alert.code, ALERT_RULES[alert.code], alert.label, alert.detail);
  }

  // SOURCE CONTEXT — advisory or provenance, never a failure.
  if (input.source.screenshotLikeDetected) {
    add(
      "SCREENSHOT_FILENAME_HEURISTIC",
      { category: "ADVISORY", tone: "advisory", placement: "SIGNAL", action: null },
      "Screenshot filename heuristic",
      "The filename and client metadata resemble a screenshot. This is a heuristic only, not image forensics.",
    );
  }
  if (input.source.oldLastModified) {
    add(
      "FILE_TIMESTAMP_NOTE",
      { category: "ADVISORY", tone: "advisory", placement: "SIGNAL", action: null },
      "File timestamp note",
      "The file was last modified before it was uploaded. This is common for existing documents and does not indicate manipulation.",
    );
  }
  if (input.source.importedUpload) {
    add(
      "IMPORTED_UPLOAD",
      { category: "INFORMATIONAL", tone: "info", placement: "PROVENANCE", action: null },
      "Imported upload",
      "PROOVRA preserved the uploaded file and recorded its integrity. It does not independently prove the original capture source.",
    );
  }
  if (input.source.genericMime) {
    add(
      "GENERIC_MIME_TYPE",
      informational,
      "Generic file type",
      "The client reported a generic file type.",
    );
  }

  // WORKFLOW — actionable only when the policy asks for it AND this viewer
  // can act; otherwise it is metadata the rail states once.
  if (!input.caseAssignment.assigned) {
    const policy = input.caseAssignment.policy;
    const canAct = input.caseAssignment.viewerCanAssign;
    const rule: Rule =
      canAct && policy === "REQUIRED"
        ? required("warning", "ASSIGN_CASE")
        : canAct && policy === "RECOMMENDED"
          ? { category: "ACTION_RECOMMENDED", tone: "info", placement: "ATTENTION", action: "ASSIGN_CASE" }
          : informational;
    add(
      "CASE_UNASSIGNED",
      rule,
      "No case assigned",
      policy === "OPTIONAL"
        ? "Linking this record to a case is optional."
        : policy === "RECOMMENDED"
          ? "Linking this record to a case is recommended in this workspace."
          : "This workspace requires every record to be linked to a case.",
    );
  }
  if (input.review.applicable && input.review.notStarted && input.review.viewerCanStart) {
    add(
      "REVIEW_NOT_STARTED",
      { category: "ACTION_RECOMMENDED", tone: "info", placement: "ATTENTION", action: "START_REVIEW" },
      "Review not started",
      "No reviewer owns this record yet. Starting review assigns it to you.",
    );
  }

  items.sort(
    (a, b) =>
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || TONE_RANK[a.tone] - TONE_RANK[b.tone],
  );

  const headline = items.some((i) => i.category === "ACTION_REQUIRED")
    ? "ACTION_REQUIRED"
    : items.some((i) => i.category === "ACTION_RECOMMENDED")
      ? "ACTION_RECOMMENDED"
      : "NO_ACTION";

  return {
    items,
    headline,
    caseAssignment: { assigned: input.caseAssignment.assigned, policy: input.caseAssignment.policy },
  };
}
