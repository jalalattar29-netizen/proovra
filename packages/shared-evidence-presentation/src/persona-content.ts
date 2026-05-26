/**
 * Phase E7 — Canonical persona content (single source of truth).
 *
 * The PROOVRA persona system is presentation-only. It influences
 * ordering, labels, recommended templates, empty-state copy, and
 * onboarding next-step text. It MUST NOT influence:
 *
 *   - permissions / authorization (capability registry has no persona param)
 *   - capture / upload / finalize / custody / signing / timestamping
 *   - report / package generation
 *   - the truth of any verification claim
 *   - the legal posture documented by the Trust Center
 *
 * The bounded persona enum (already shipped by the backend; see
 * `services/api/src/services/platform-context/types.ts`
 * `WORKSPACE_PERSONA_PROFILES`) is:
 *
 *     INDIVIDUAL | LAWYER | INSURANCE | INVESTIGATOR
 *     | JOURNALIST | ENTERPRISE_COMPLIANCE | ADMIN_OPERATOR
 *
 * This module exposes, for each enum code, a complete `PersonaContent`
 * record: display label, primary jobs, recommended capture-template
 * priorities, dashboard section priority order, onboarding next-step
 * copy, contextual empty-state hints. Existing per-surface helpers
 * (`personaSectionOrder.ts`, `personaEmptyStates.ts`, `personaHints.ts`
 * inside `apps/web/lib/platform-context/`) continue to operate; this
 * module is the AUTHORITATIVE description of what every persona is
 * supposed to feel like and the test suite uses it to assert
 * cross-surface alignment.
 *
 * Hard rules pinned by `phase-e7-persona-aware-ux.test.ts`:
 *
 *   1. Every enum code has exactly one `PersonaContent` record. Adding
 *      a new persona requires adding a record here AND updating the
 *      backend enum AND adding tests.
 *   2. No `PersonaContent.bullets` / `recommendedNextStep` /
 *      `emptyStateHints` value matches any pattern in
 *      `PERSONA_CONTENT_FORBIDDEN_PATTERNS` (the marketing-claim
 *      forbidden-phrase guard). Phrasing must respect the E5 boundary:
 *      no "legally admissible", "compliance certified",
 *      "AI confirmed", "journalistically verified", "claim proven",
 *      "forensically certified", etc.
 *   3. Recommended capture templates are SUGGESTIONS, not enforcement.
 *      The recommended-template list lives here for UX; the actual
 *      workflow-template registry remains authoritative for what is
 *      selectable.
 *   4. The dashboard priority list references existing Command Center
 *      section ids only — persona may reorder, never invent.
 *   5. The persona content module has no runtime dependencies (no fs,
 *      no fetch, no Prisma). It is a pure data + types module shared
 *      across web + api test surfaces.
 */

// ---------------------------------------------------------------------------
// Bounded persona enum + types
// ---------------------------------------------------------------------------

export const PERSONA_CODES = [
  "INDIVIDUAL",
  "LAWYER",
  "INSURANCE",
  "INVESTIGATOR",
  "JOURNALIST",
  "ENTERPRISE_COMPLIANCE",
  "ADMIN_OPERATOR",
] as const;

export type PersonaCode = (typeof PERSONA_CODES)[number];

// Public-facing display label families. Maintained verbatim because
// they are what users see in the persona picker and on hub headers.
export const PERSONA_DISPLAY_LABEL: Record<PersonaCode, string> = {
  INDIVIDUAL: "General / individual",
  LAWYER: "Legal practitioner",
  INSURANCE: "Insurance team",
  INVESTIGATOR: "Investigations team",
  JOURNALIST: "Newsroom / field reporting",
  ENTERPRISE_COMPLIANCE: "Compliance / governance",
  ADMIN_OPERATOR: "Enterprise administrator",
};

// Stable "domain" group used by the navigation disclosure resolver so
// that operator-style personas surface advanced hubs prominently.
export const PERSONA_DOMAIN_GROUP: Record<PersonaCode, "individual" | "operator" | "admin"> = {
  INDIVIDUAL: "individual",
  LAWYER: "operator",
  INSURANCE: "operator",
  INVESTIGATOR: "operator",
  JOURNALIST: "individual",
  ENTERPRISE_COMPLIANCE: "operator",
  ADMIN_OPERATOR: "admin",
};

export type PersonaCaseTerm = "Case" | "Matter" | "Claim" | "Investigation";

// Cases page renders "Cases" / "Matters" / "Claims" / "Investigations"
// based on persona. Persona-aware labels reuse this map.
export const PERSONA_CASE_TERM: Record<PersonaCode, PersonaCaseTerm> = {
  INDIVIDUAL: "Case",
  LAWYER: "Matter",
  INSURANCE: "Claim",
  INVESTIGATOR: "Investigation",
  JOURNALIST: "Case",
  ENTERPRISE_COMPLIANCE: "Case",
  ADMIN_OPERATOR: "Case",
};

export type PersonaContent = {
  code: PersonaCode;
  displayLabel: string;
  domainGroup: "individual" | "operator" | "admin";
  caseTerm: PersonaCaseTerm;
  /** 1-line summary used on the persona picker + header chips. */
  summary: string;
  /** 3–5 primary jobs-to-be-done bullets shown in onboarding + the persona settings page. */
  primaryJobs: ReadonlyArray<string>;
  /**
   * Recommended capture workflow / template slugs ordered by priority.
   * These are SUGGESTIONS — the workflow-template registry remains
   * authoritative for what is selectable. Unknown slugs are skipped
   * by the workflow-template-order resolver.
   */
  recommendedTemplates: ReadonlyArray<string>;
  /**
   * Recommended dashboard section ids in priority order. Existing
   * `getPersonaSectionOrder()` consumes this; sections missing from
   * the envelope (because the viewer lacks capability) are simply
   * skipped — persona never re-grants visibility.
   */
  dashboardPriority: ReadonlyArray<string>;
  /** Single onboarding "do this first" copy. Plain text, no markdown. */
  recommendedNextStep: string;
  /**
   * Surface-keyed empty-state hints. Used by `personaEmptyStates.ts`
   * helpers to render contextual hints when a list is empty. Keys
   * are page slugs (`evidence`, `cases`, `reports`, ...).
   */
  emptyStateHints: Readonly<Record<string, string>>;
};

// ---------------------------------------------------------------------------
// Forbidden marketing-claim shapes (mirrors E5 trust-center guard)
// ---------------------------------------------------------------------------

export const PERSONA_CONTENT_FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\blegally\s*admissible\b/i,
  /\badmissible\s+in\s+court\b/i,
  /\bclaim\s+proven\b/i,
  /\bauthenticity\s+guaranteed\b/i,
  /\bjournalistically\s+verified\b/i,
  /\bcompliance\s+certified\b/i,
  /\bAI[- ]?confirmed\b/i,
  /\bAI[- ]?verified\b/i,
  /\bforensically\s+certified\b/i,
  /\bforensic\s+(?:authority|grade)\b/i,
  /\bcourt[- ]?ready\b/i,
  /\bcourt[- ]?certified\b/i,
  /\btamper[- ]?proof\b/i,
  /\b100%\s+secure\b/i,
  /\bguarantees?\s+(?:authenticity|admissibility|truth)\b/i,
  /\bSOC\s*2\s+(?:compliant|certified)\b/i,
  /\bHIPAA\s+(?:compliant|certified)\b/i,
  /\bGDPR\s+(?:compliant|certified)\b/i,
];

// ---------------------------------------------------------------------------
// Per-persona content. Order matches PERSONA_CODES.
// ---------------------------------------------------------------------------

export const PERSONA_CONTENT: Record<PersonaCode, PersonaContent> = {
  INDIVIDUAL: {
    code: "INDIVIDUAL",
    displayLabel: PERSONA_DISPLAY_LABEL.INDIVIDUAL,
    domainGroup: PERSONA_DOMAIN_GROUP.INDIVIDUAL,
    caseTerm: PERSONA_CASE_TERM.INDIVIDUAL,
    summary:
      "Simple personal evidence workflow. Capture, preserve, and review without team operational depth.",
    primaryJobs: [
      "Capture a single piece of evidence and preserve its recorded integrity state.",
      "Generate a verification report or package for a specific incident.",
      "Share a public verification link with a recipient.",
    ],
    recommendedTemplates: [
      "general-evidence-record",
      "single-file-capture",
    ],
    dashboardPriority: [
      "summary",
      "projectionSummary",
      "recentEvidence",
      "caseOperations",
      "pipelineDetail",
    ],
    recommendedNextStep:
      "Capture your first evidence record from the Capture surface.",
    emptyStateHints: {
      evidence:
        "Capture an evidence item to preserve its recorded integrity state.",
      cases:
        "Create a case to group related evidence and generated reports.",
      reports:
        "Generate a report once you have at least one finalized evidence record.",
    },
  },

  LAWYER: {
    code: "LAWYER",
    displayLabel: PERSONA_DISPLAY_LABEL.LAWYER,
    domainGroup: PERSONA_DOMAIN_GROUP.LAWYER,
    caseTerm: PERSONA_CASE_TERM.LAWYER,
    summary:
      "Matter-centric workflow with custody continuity and review readiness front and centre.",
    primaryJobs: [
      "Organize evidence under a matter and preserve chain-of-custody activity.",
      "Generate review-ready technical reports for downstream legal review.",
      "Place and release legal holds in line with the matter lifecycle.",
      "Review evidence with structured reviewer notes and assignment history.",
    ],
    recommendedTemplates: [
      "legal-matter-evidence",
      "general-evidence-record",
    ],
    dashboardPriority: [
      "caseOperations",
      "summary",
      "pipelineDetail",
      "governancePosture",
      "auditReadiness",
      "recentEvidence",
    ],
    recommendedNextStep:
      "Create a matter to organize evidence, reviewer notes, and reports for one case.",
    emptyStateHints: {
      evidence:
        "Capture evidence and attach it to a matter to preserve its custody context.",
      cases:
        "Create a matter to organize evidence, reviewer notes, and generated reports.",
      reports:
        "Generate a report once the matter's evidence has been finalized.",
    },
  },

  INSURANCE: {
    code: "INSURANCE",
    displayLabel: PERSONA_DISPLAY_LABEL.INSURANCE,
    domainGroup: PERSONA_DOMAIN_GROUP.INSURANCE,
    caseTerm: PERSONA_CASE_TERM.INSURANCE,
    summary:
      "Claim intake plus reviewer assignment with package readiness for downstream submission.",
    primaryJobs: [
      "Intake evidence for a claim either directly or via an external intake link.",
      "Assign claims to reviewers and track review readiness through to closure.",
      "Generate verification packages ready for downstream submission.",
      "Monitor claim throughput via the reviewer queue and operational analytics.",
    ],
    recommendedTemplates: [
      "insurance-claim-intake",
      "general-evidence-record",
    ],
    dashboardPriority: [
      "reviewerOrchestration",
      "operationalPressure",
      "caseOperations",
      "summary",
      "pipelineDetail",
    ],
    recommendedNextStep:
      "Invite claims reviewers before sharing intake links with claimants.",
    emptyStateHints: {
      evidence:
        "Start a claim intake or share an intake link to receive evidence.",
      cases:
        "Open a claim to organize intake, reviewer assignment, and the verification package.",
      reports:
        "Generate a verification package once the claim's evidence has been reviewed.",
    },
  },

  INVESTIGATOR: {
    code: "INVESTIGATOR",
    displayLabel: PERSONA_DISPLAY_LABEL.INVESTIGATOR,
    domainGroup: PERSONA_DOMAIN_GROUP.INVESTIGATOR,
    caseTerm: PERSONA_CASE_TERM.INVESTIGATOR,
    summary:
      "Investigation-oriented workflow with timeline, evidence relationships, and reviewer task queues.",
    primaryJobs: [
      "Build an investigation timeline from multiple linked evidence records.",
      "Track evidence relationships and reviewer task progress.",
      "Preserve chain-of-custody activity for every investigation event.",
      "Generate investigator-ready reports with reviewer findings included.",
    ],
    recommendedTemplates: [
      "incident-investigation",
      "general-evidence-record",
    ],
    dashboardPriority: [
      "investigationIntelligence",
      "timeline",
      "caseOperations",
      "recentEvidence",
      "summary",
    ],
    recommendedNextStep:
      "Open an investigation to link related evidence and build the timeline.",
    emptyStateHints: {
      evidence:
        "Capture an evidence record and link it into the investigation timeline.",
      cases:
        "Open an investigation to link evidence, manage reviewer tasks, and assemble the timeline.",
      reports:
        "Generate an investigator report once the timeline and reviewer findings are in place.",
    },
  },

  JOURNALIST: {
    code: "JOURNALIST",
    displayLabel: PERSONA_DISPLAY_LABEL.JOURNALIST,
    domainGroup: PERSONA_DOMAIN_GROUP.JOURNALIST,
    caseTerm: PERSONA_CASE_TERM.JOURNALIST,
    summary:
      "Field capture with rapid verification package generation. Source-protection boundaries are operator-managed.",
    primaryJobs: [
      "Capture field evidence quickly and preserve its recorded integrity state.",
      "Generate a verification package for review or pre-publication checking.",
      "Group related field captures under a story or assignment.",
      "Share a public verification link with editors or external reviewers.",
    ],
    recommendedTemplates: [
      "field-capture",
      "general-evidence-record",
    ],
    dashboardPriority: [
      "summary",
      "pipelineDetail",
      "recentEvidence",
      "caseOperations",
    ],
    recommendedNextStep:
      "Capture a field evidence record from the Capture surface — the verification package follows automatically.",
    emptyStateHints: {
      evidence:
        "Capture a field evidence record to preserve its recorded integrity state.",
      cases:
        "Group field captures under a story or assignment to coordinate review.",
      reports:
        "Generate a verification package once the field capture is finalized.",
    },
  },

  ENTERPRISE_COMPLIANCE: {
    code: "ENTERPRISE_COMPLIANCE",
    displayLabel: PERSONA_DISPLAY_LABEL.ENTERPRISE_COMPLIANCE,
    domainGroup: PERSONA_DOMAIN_GROUP.ENTERPRISE_COMPLIANCE,
    caseTerm: PERSONA_CASE_TERM.ENTERPRISE_COMPLIANCE,
    summary:
      "Governance-led workflow: retention policy, legal holds, and lifecycle operations come first.",
    primaryJobs: [
      "Configure retention policy and review the lifecycle dashboard regularly.",
      "Place, monitor, and release legal holds against the affected evidence.",
      "Review governance analytics for active holds, holds placed, and lifecycle activity.",
      "Coordinate audit-ready evidence preservation across the workspace.",
    ],
    recommendedTemplates: [
      "compliance-audit-record",
      "general-evidence-record",
    ],
    dashboardPriority: [
      "governancePosture",
      "auditReadiness",
      "operationalPressure",
      "summary",
      "caseOperations",
    ],
    recommendedNextStep:
      "Configure your retention policy before opening compliance evidence intake.",
    emptyStateHints: {
      evidence:
        "Configure retention policy first so newly captured evidence inherits the workspace's lifecycle rules.",
      cases:
        "Open a governance case to coordinate audit-ready evidence preservation.",
      reports:
        "Generate a governance report once the lifecycle activity is recorded.",
    },
  },

  ADMIN_OPERATOR: {
    code: "ADMIN_OPERATOR",
    displayLabel: PERSONA_DISPLAY_LABEL.ADMIN_OPERATOR,
    domainGroup: PERSONA_DOMAIN_GROUP.ADMIN_OPERATOR,
    caseTerm: PERSONA_CASE_TERM.ADMIN_OPERATOR,
    summary:
      "Enterprise administrator: identity, integrations, security center, and operational health.",
    primaryJobs: [
      "Manage users, roles, and SSO / SCIM integrations.",
      "Monitor operational health via the runtime readiness aggregator and ops analytics.",
      "Manage integrations and automation rules — both with strict allow-list enforcement.",
      "Review security events, audit posture, and incident response.",
    ],
    recommendedTemplates: [
      "general-evidence-record",
    ],
    dashboardPriority: [
      "operationalPressure",
      "incidents",
      "reviewerOrchestration",
      "summary",
      "pipelineDetail",
      "organizationalIntelligence",
    ],
    recommendedNextStep:
      "Review the Security Center and Operations Center to set up users, SSO, and operational health checks.",
    emptyStateHints: {
      evidence:
        "Most evidence intake is owned by reviewers — administrators focus on operations and security.",
      cases:
        "Cases are reviewer-owned. Operate through Ops, Security Center, and the integrations surface.",
      reports:
        "Reports are reviewer-generated. Administrators monitor generation health via operational analytics.",
    },
  },
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Return the canonical content for a persona code. */
export function getPersonaContent(code: PersonaCode): PersonaContent {
  return PERSONA_CONTENT[code];
}

/** Return the persona's case-terminology label ("Matter" / "Claim" / ...). */
export function getPersonaCaseTerm(code: PersonaCode): PersonaCaseTerm {
  return PERSONA_CASE_TERM[code];
}

/**
 * Return persona-recommended dashboard section priority. Mirrors the
 * existing `PERSONA_DASHBOARD_PRIORITY` map in
 * `apps/web/lib/platform-context/personaSectionOrder.ts`.
 */
export function getPersonaDashboardPriority(
  code: PersonaCode,
): ReadonlyArray<string> {
  return PERSONA_CONTENT[code].dashboardPriority;
}

/**
 * Return the persona's recommended capture-template slugs in priority
 * order. Recommendations are not enforcement — the workflow-template
 * registry remains authoritative for what is selectable.
 */
export function getPersonaRecommendedTemplates(
  code: PersonaCode,
): ReadonlyArray<string> {
  return PERSONA_CONTENT[code].recommendedTemplates;
}

/**
 * Return the persona-specific empty-state hint for a surface, or the
 * INDIVIDUAL fallback if the persona/surface combination is unknown.
 */
export function getPersonaEmptyStateHint(
  code: PersonaCode,
  surface: string,
): string {
  const direct = PERSONA_CONTENT[code]?.emptyStateHints?.[surface];
  if (direct) return direct;
  return PERSONA_CONTENT.INDIVIDUAL.emptyStateHints[surface] ?? "";
}

/**
 * Return the persona-specific "do this first" onboarding line. Used
 * by the onboarding next-step copy on the dashboard and the persona
 * settings page.
 */
export function getPersonaRecommendedNextStep(code: PersonaCode): string {
  return PERSONA_CONTENT[code].recommendedNextStep;
}
