/**
 * PHASE R4 — Canonical product language, entry point.
 *
 * The single source of truth for the platform's operational
 * vocabulary. Surfaces import from here; new copy goes through
 * this dictionary or the R4 test suite breaks the build.
 *
 * Hard rules (pinned by `phase-r4-product-language-recovery.test.ts`):
 *
 *   1. No raw architecture chips ("Access", "Org") in primary UX.
 *   2. No raw ALL_CAPS backend states in user-visible copy.
 *   3. No marketing fluff / dramatic / debug phrases.
 *   4. Forensic-trust terms are preserved verbatim.
 *   5. New tones / states / terms are deliberate additions.
 */

export {
  UX_TONES,
  FORBIDDEN_TONE_PATTERNS,
  type UxTone,
} from "./tones";

export {
  RUNTIME_SEVERITY_LABELS,
  REVIEW_WORKFLOW_STAGE_LABELS,
  SLA_STATUS_LABELS,
  BILLING_ADDON_STATUS_LABELS,
  WORKSPACE_SETUP_LABELS,
  STATE_FALLBACK_LABEL,
  formatStateLabel,
} from "./stateLabels";

export {
  TERM_WORKSPACE,
  TERM_PERSONAL_SPACE,
  TERM_ORGANIZATION,
  TERM_TEAM_MEMBER,
  TERM_REVIEW_QUEUE,
  TERM_ESCALATIONS,
  TERM_SLA_TRACKING,
  TERM_GOVERNANCE_POSTURE,
  TERM_GOVERNANCE_INSIGHTS,
  TERM_RETENTION_POLICY,
  TERM_LIFECYCLE_REVIEWS,
  TERM_INVESTIGATION_HUB,
  TERM_OBSERVABILITY,
  TERM_RUNBOOKS,
  TERM_OPERATIONS_CENTER,
  TERM_SECURITY_CENTER,
  TERM_INTAKE_LINKS,
  CTA_CAPTURE_EVIDENCE,
  CTA_REVIEW_EVIDENCE,
  CTA_OPEN_QUEUE,
  CTA_REVIEW_ESCALATIONS,
  CTA_CONFIGURE_INTAKE,
  CTA_REVIEW_POSTURE,
  ACCESS_REQUIRES_ORGANIZATION,
  ACCESS_REQUIRES_PERMISSION,
  ACCESS_SETUP_NEEDED,
  ACCESS_UPGRADE_REQUIRED,
  EMPTY_WORKSPACE_SETUP_INCOMPLETE,
  EMPTY_NO_OPERATIONAL_PRESSURE,
  EMPTY_NOT_CONFIGURED,
  FORENSIC_TERMS_PRESERVED,
  CONCEPT_CANONICAL_TERMS,
} from "./operationalTerminology";

export {
  FORBIDDEN_ENGINEERING_PHRASES,
  FORBIDDEN_MARKETING_PHRASES,
  FORBIDDEN_DRAMATIC_PHRASES,
  ALL_FORBIDDEN_PHRASES,
} from "./forbidden";
