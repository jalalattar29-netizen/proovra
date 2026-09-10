/**
 * PV-LANG-003 — product language for the governance, lifecycle, redaction
 * and review consoles.
 *
 * These pages printed stored identifiers as the words an operator reads
 * ("Permission required: DELEGATED_ADMIN", "DEAD_LETTERED", "picked_case").
 * Most families read correctly through the generic `identifierLabel` rule
 * from @proovra/shared ("PENDING_ACCEPTANCE" -> "Pending acceptance"); the
 * pages call it directly. This module holds only the families whose members
 * need different words than the rule produces, each with that rule as the
 * fallback so an unknown future member still renders as words, never as a
 * constant.
 */
import { identifierLabel } from "@proovra/shared";

function curated(map: Readonly<Record<string, string>>, value: string): string {
  return map[value] ?? identifierLabel(value);
}

// ---------------------------------------------------------------------------
// Permission denials
// ---------------------------------------------------------------------------

/**
 * WHO can grant access, said in product language. Every tier the API can
 * name (DELEGATED_ADMIN_TIERS) has a label here, plus the generic fallback
 * the pages used when none was sent.
 */
const DELEGATED_TIER_LABELS: Readonly<Record<string, string>> = {
  GLOBAL_ADMIN: "a global administrator",
  ORG_ADMIN: "an organization administrator",
  DEPARTMENT_ADMIN: "a department administrator",
  WORKSPACE_ADMIN: "a workspace administrator",
  REVIEWER_LEAD: "a reviewer lead",
  SECURITY_OFFICER: "a security officer",
  COMPLIANCE_OFFICER: "a compliance officer",
  DELEGATED_ADMIN: "a delegated administrator",
};

/** The role a reader should ask, never the constant. */
export function delegatedTierLabel(tier: string | null | undefined): string {
  if (!tier) return DELEGATED_TIER_LABELS.DELEGATED_ADMIN;
  return DELEGATED_TIER_LABELS[tier] ?? DELEGATED_TIER_LABELS.DELEGATED_ADMIN;
}

/**
 * The inline denial banner copy the non-shared lifecycle / exchange /
 * packaging / policy pages render. Same wording as the evidence-lifecycle
 * DenialBanner: a plan gap names the plan, a tier gap names who to ask.
 */
export function permissionDenialCopy(
  denial: string,
  tier: string | null | undefined,
): { title: string; detail: string } {
  if (denial === "ENTITLEMENT_REQUIRED") {
    return {
      title: "Not included in this workspace's plan.",
      detail: "Contact your account team to enable this feature.",
    };
  }
  return {
    title: "Permission required.",
    detail: `Ask ${delegatedTierLabel(tier)} to grant you access.`,
  };
}

// ---------------------------------------------------------------------------
// Evidence lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle webhook delivery state (WEBHOOK_DELIVERY_STATES). */
const WEBHOOK_DELIVERY_STATE_LABELS: Readonly<Record<string, string>> = {
  RETRYING: "Retrying",
  DEAD_LETTERED: "Failed — retries exhausted",
};
export function webhookDeliveryStateLabel(state: string): string {
  return curated(WEBHOOK_DELIVERY_STATE_LABELS, state);
}

/**
 * Retention templates (RETENTION_POLICY_TEMPLATES). The code carries the
 * period; the label says it.
 */
const RETENTION_TEMPLATE_LABELS: Readonly<Record<string, string>> = {
  INSURANCE_7Y: "Insurance — 7 years",
  JOURNALISM_10Y: "Journalism — 10 years",
  CORPORATE_5Y: "Corporate — 5 years",
  CUSTOM: "Custom period",
};
export function retentionTemplateLabel(template: string): string {
  return curated(RETENTION_TEMPLATE_LABELS, template);
}

// ---------------------------------------------------------------------------
// Governance
// ---------------------------------------------------------------------------

/** Department membership role (DEPARTMENT_MEMBERSHIP_ROLES). */
const DEPARTMENT_ROLE_LABELS: Readonly<Record<string, string>> = {
  MEMBER: "Member",
  LEAD: "Department lead",
  ADMIN: "Department admin",
};
export function departmentRoleLabel(role: string): string {
  return curated(DEPARTMENT_ROLE_LABELS, role);
}

/** Governance reconciliation run kind (GOVERNANCE_RECONCILIATION_KINDS). */
const RECONCILIATION_KIND_LABELS: Readonly<Record<string, string>> = {
  RETENTION: "Retention reconciliation",
  IMMUTABLE_STORAGE: "Immutable storage check",
  LIFECYCLE_DRIFT: "Lifecycle drift check",
  DESTRUCTION_SWEEP: "Destruction sweep",
};
export function reconciliationKindLabel(kind: string): string {
  return curated(RECONCILIATION_KIND_LABELS, kind);
}

/**
 * Why the retention engine picked the effective policy — the machine codes
 * `resolveEffectiveRetentionPolicy` returns
 * (services/api/src/services/governance-lifecycle/retention-engine.service.ts).
 */
const RETENTION_DECISION_REASON_LABELS: Readonly<Record<string, string>> = {
  inherited_from_org: "No workspace policy matched, so the organization's retention template applies.",
  no_active_policy: "No active retention policy applies.",
  no_winner: "Active policies exist, but none takes precedence for this evidence.",
  picked_workspace: "The workspace policy applies.",
  picked_evidence_type: "The evidence-type policy applies.",
  picked_case: "The case policy applies.",
  picked_regulatory: "The regulatory policy applies.",
};
export function retentionDecisionReasonLabel(reason: string): string {
  return curated(RETENTION_DECISION_REASON_LABELS, reason);
}

/** Conflict codes on the effective retention decision. */
const RETENTION_CONFLICT_LABELS: Readonly<Record<string, string>> = {
  duplicate_same_scope: "Duplicate policies",
  workspace_overrides_immutable: "Organization floor enforced",
  workspace_weaker_than_inherited: "Shorter than organization template",
};
export function retentionConflictLabel(code: string): string {
  return curated(RETENTION_CONFLICT_LABELS, code);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Redaction detection provider (REDACTION_DETECTION_PROVIDERS). */
const REDACTION_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  MANUAL: "Manual",
  REGEX_PII: "Pattern-based PII detection",
  POLICY_RULE: "Policy rule",
  AWS_REKOGNITION_FACES: "AWS Rekognition (faces)",
  AWS_REKOGNITION_TEXT: "AWS Rekognition (text)",
  AZURE_DOCUMENT_INTELLIGENCE: "Azure Document Intelligence",
  OCR_TEXT_LAYER: "OCR text layer",
  DEEPGRAM_TRANSCRIPT: "Deepgram transcript",
  CUSTOM_PROVIDER: "Custom provider",
};
export function redactionProviderLabel(provider: string): string {
  return curated(REDACTION_PROVIDER_LABELS, provider);
}

// ---------------------------------------------------------------------------
// External review
// ---------------------------------------------------------------------------

/** Per-row outcome of a bulk invitation (BULK_INVITATION_ROW_OUTCOMES). */
const BULK_INVITATION_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  INVITED: "Invited",
  FAILED: "Failed",
  DUPLICATE: "Already invited",
  INVALID_EMAIL: "Invalid email",
  POLICY_DENIED: "Blocked by policy",
};
export function bulkInvitationOutcomeLabel(outcome: string): string {
  return curated(BULK_INVITATION_OUTCOME_LABELS, outcome);
}

/**
 * Invitation email provider key
 * (services/api/src/services/external-review/portal-invitation-email.service.ts).
 */
const INVITATION_DELIVERY_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  RESEND_API: "Email",
  RESEND_DISABLED: "Email not configured",
};
export function invitationDeliveryProviderLabel(provider: string): string {
  return curated(INVITATION_DELIVERY_PROVIDER_LABELS, provider);
}

// ---------------------------------------------------------------------------
// Reviewer workspace + reviewer operations
// ---------------------------------------------------------------------------

/** Reviewer workspace role (REVIEWER_ROLES). */
const REVIEWER_ROLE_LABELS: Readonly<Record<string, string>> = {
  REVIEWER: "Reviewer",
  SENIOR_REVIEWER: "Senior reviewer",
  QC_REVIEWER: "QC reviewer",
  SUPERVISOR: "Supervisor",
  REVIEW_ADMIN: "Review admin",
};
export function reviewerRoleLabel(role: string): string {
  return curated(REVIEWER_ROLE_LABELS, role);
}

/**
 * Reviewer hotkey actions (REVIEWER_HOTKEY_CODES), plus the side-pane cycle
 * the workspace binds outside that vocabulary.
 */
const REVIEWER_HOTKEY_LABELS: Readonly<Record<string, string>> = {
  NEXT_ITEM: "Next item",
  PREVIOUS_ITEM: "Previous item",
  APPROVE: "Approve",
  REJECT: "Reject",
  FLAG: "Flag",
  ESCALATE: "Escalate",
  REQUEST_INFO: "Request information",
  ASSIGN: "Assign",
  SAVE: "Save",
  HELP: "Show or hide this help",
  TOGGLE_ANNOTATIONS: "Show or hide annotations",
  FOCUS_CODING_PANEL: "Go to the coding panel",
  FOCUS_VIEWER: "Go to the viewer",
  CYCLE_SIDE_PANE: "Switch side pane",
};
export function reviewerHotkeyLabel(code: string): string {
  return curated(REVIEWER_HOTKEY_LABELS, code);
}

/** Why a review was escalated (REVIEW_ESCALATION_REASONS). */
const ESCALATION_REASON_LABELS: Readonly<Record<string, string>> = {
  NO_REVIEWER_ASSIGNED: "No reviewer assigned",
  REVIEW_OVERDUE: "Review overdue",
  FIRST_REVIEW_OVERDUE: "First review overdue",
  COMPLETION_OVERDUE: "Completion overdue",
  WORKFLOW_STALLED: "Workflow stalled",
  EVIDENCE_REQUEST_UNRESOLVED: "Evidence request unanswered",
  INTEGRITY_RISK: "Integrity risk",
  VERIFICATION_MISMATCH: "Verification mismatch",
  REVIEWER_INACTIVE: "Reviewer inactive",
  GOVERNANCE_BLOCKED: "Blocked by governance policy",
  REPEATED_REJECTION_LOOP: "Repeatedly rejected",
};
export function escalationReasonLabel(reason: string): string {
  return curated(ESCALATION_REASON_LABELS, reason);
}
