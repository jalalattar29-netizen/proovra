/**
 * PHASE R4 — Canonical operational terminology dictionary.
 *
 * One concept → one canonical operational term. This file is the
 * authoritative reference for everything that ships in user-visible
 * copy: route labels, dashboard sections, hub names, sidebar
 * groups, quick actions, help copy.
 *
 * If you find yourself naming the same concept two different ways
 * across surfaces, fix the surface to match THIS file (or update
 * THIS file in a coordinated PR with the surfaces).
 *
 * Hard rules:
 *
 *   1. Operational, calm, enterprise tone. No marketing fluff.
 *
 *   2. No backend / engineering / architecture terms leak through.
 *
 *   3. The canonical term is a label, not a sentence. Use
 *      `stateLabels.ts` for state copy; use this for concept names.
 *
 *   4. Forensic-trust terms (custody, verification, integrity,
 *      timestamp, anchor) are PRESERVED as-is — they carry legal
 *      weight and must not be softened into marketing language.
 */

/** Workspace + tenant model terms. */
export const TERM_WORKSPACE = "Workspace";
export const TERM_PERSONAL_SPACE = "Personal Space";
export const TERM_ORGANIZATION = "Organization";
export const TERM_TEAM_MEMBER = "Member";

/** Navigation + hub terms. */
export const TERM_REVIEW_QUEUE = "Review queue";
export const TERM_ESCALATIONS = "Escalations";
export const TERM_SLA_TRACKING = "SLA tracking";
export const TERM_GOVERNANCE_POSTURE = "Governance posture";
export const TERM_GOVERNANCE_INSIGHTS = "Governance insights";
export const TERM_RETENTION_POLICY = "Retention policy";
export const TERM_LIFECYCLE_REVIEWS = "Lifecycle reviews";
export const TERM_INVESTIGATION_HUB = "Investigation overview";
export const TERM_OBSERVABILITY = "Observability";
export const TERM_RUNBOOKS = "Runbooks";
export const TERM_OPERATIONS_CENTER = "Operations center";
export const TERM_SECURITY_CENTER = "Security center";
export const TERM_INTAKE_LINKS = "Intake links";

/** Operational action terms — CTA wording. */
export const CTA_CAPTURE_EVIDENCE = "Capture evidence";
export const CTA_REVIEW_EVIDENCE = "Review evidence";
export const CTA_OPEN_QUEUE = "Open reviewer queue";
export const CTA_REVIEW_ESCALATIONS = "Review escalations";
export const CTA_CONFIGURE_INTAKE = "Configure intake operations";
export const CTA_REVIEW_POSTURE = "Review governance posture";

/** Permission / access copy. Replaces raw "Access" / "Org" chips. */
export const ACCESS_REQUIRES_ORGANIZATION = "Requires organization";
export const ACCESS_REQUIRES_PERMISSION = "Requires permission";
export const ACCESS_SETUP_NEEDED = "Setup needed";
export const ACCESS_UPGRADE_REQUIRED = "Upgrade required";

/** Empty-state copy (operationally meaningful, never generic). */
export const EMPTY_WORKSPACE_SETUP_INCOMPLETE =
  "Workspace setup incomplete";
export const EMPTY_NO_OPERATIONAL_PRESSURE =
  "No operational pressure detected";
export const EMPTY_NOT_CONFIGURED = "Not configured";

/**
 * Forensic-trust terms that R4 deliberately preserves verbatim.
 * Renaming any of these for marketing would compromise legal
 * weight. Tests pin their continued presence.
 */
export const FORENSIC_TERMS_PRESERVED: ReadonlyArray<string> = [
  "custody",
  "verification",
  "integrity",
  "timestamp",
  "anchor",
  "tamper-evident",
  "hash chain",
  "audit log",
];

/**
 * Dictionary of canonical concept → canonical term. Use this for
 * test-time enforcement (Test 7 — no duplicated terminology for the
 * same concept).
 */
export const CONCEPT_CANONICAL_TERMS: Readonly<Record<string, string>> = {
  workspace: TERM_WORKSPACE,
  personal_space: TERM_PERSONAL_SPACE,
  organization: TERM_ORGANIZATION,
  team_member: TERM_TEAM_MEMBER,
  review_queue: TERM_REVIEW_QUEUE,
  escalations: TERM_ESCALATIONS,
  sla_tracking: TERM_SLA_TRACKING,
  governance_posture: TERM_GOVERNANCE_POSTURE,
  governance_insights: TERM_GOVERNANCE_INSIGHTS,
  retention_policy: TERM_RETENTION_POLICY,
  lifecycle_reviews: TERM_LIFECYCLE_REVIEWS,
  investigation_hub: TERM_INVESTIGATION_HUB,
  observability: TERM_OBSERVABILITY,
  runbooks: TERM_RUNBOOKS,
  operations_center: TERM_OPERATIONS_CENTER,
  security_center: TERM_SECURITY_CENTER,
  intake_links: TERM_INTAKE_LINKS,
};
