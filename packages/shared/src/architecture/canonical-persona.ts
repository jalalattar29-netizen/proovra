/**
 * PROOVRA Phase 3 — Canonical TOM (Target Operating Model) persona
 * projection.
 *
 * Four parallel persona projection systems coexist in the codebase
 * today (Phase 1 audit finding):
 *
 *   1. `Persona` (role × scope, 5 codes) — derived in
 *      `services/api/src/services/platform-context/types.ts` and
 *      mirrored in `apps/web/lib/platform-context/types.ts`. Used
 *      by the platform-context envelope.
 *
 *   2. `WorkspacePersonaProfile` (use-case, 7 codes — INDIVIDUAL,
 *      LAWYER, INSURANCE, INVESTIGATOR, JOURNALIST,
 *      ENTERPRISE_COMPLIANCE, ADMIN_OPERATOR) — Phase 38 use-case
 *      persona, surfaced on the envelope for ordering / terminology
 *      / dashboard emphasis.
 *
 *   3. `Persona` (operational, 6 codes — OWNER_ADMIN, REVIEWER,
 *      GOVERNANCE_OFFICER, OPERATOR, INVESTIGATOR, VIEWER) —
 *      `services/api/src/services/dashboard/persona-resolver.service.ts`.
 *      Drives dashboard section order.
 *
 *   4. `PersonaCode` (verification content, N codes) —
 *      `packages/shared-evidence-presentation/src/persona-content.ts`.
 *      Drives verify-page copy.
 *
 * Each of those four serves a different consumer at a different layer
 * and the Phase 3 brief is explicit: do NOT delete any of them. They
 * remain authoritative for their layer.
 *
 * What this module provides:
 *
 *   * `TOM_PERSONA_KINDS` — the canonical 8-persona Target Operating
 *     Model vocabulary that matches the constitutional product
 *     positioning (Individual / Journalist / Lawyer / Investigator /
 *     Small Team / Organization / Enterprise / Government Agency).
 *
 *   * `projectTomPersona(input)` — a pure deterministic projection
 *     that maps the envelope (workspace kind + plan + role + use-case
 *     profile) onto one of the 8 TOM personas. NO capability
 *     grants, NO mutations, NO fetches. UX-LAYER ONLY.
 *
 *   * `tomPersonaLabel(kind)` + `tomPersonaShortLabel(kind)` —
 *     consistent display copy.
 *
 * Hard rules (Phase 3 constitution):
 *
 *   - UX-layer only. MUST NOT influence capability gates.
 *   - Pure function. No I/O.
 *   - Deterministic. Same input ⇒ same output.
 *   - Bounded. Output is exactly one of `TOM_PERSONA_KINDS`.
 *
 * Constitutional reference:
 *   docs/architecture/proovra-domain-model.md — section "TOM personas"
 *   docs/architecture/architecture-invariants.md — INV-4
 */

import type { TargetWorkspaceKind } from "./workspace-kinds.js";

// =============================================================================
// TOM persona kinds — the constitutional 8-persona Target Operating Model
// =============================================================================

export const TOM_PERSONA_KINDS = [
  /** Solo user on a Personal workspace. Bootstrap default for every signup. */
  "INDIVIDUAL",
  /** Solo investigative journalist. Personal or small-team workspace, JOURNALIST profile. */
  "JOURNALIST",
  /** Solo / small-firm lawyer. Personal or small-team workspace, LAWYER profile. */
  "LAWYER",
  /** PI, claims investigator, fraud analyst. Personal or small-team workspace, INVESTIGATOR profile. */
  "INVESTIGATOR",
  /** Small team using collaboration features. Team workspace, headcount under the small-team ceiling. */
  "SMALL_TEAM",
  /** Mid-market organization. Organization workspace, ENTERPRISE_COMPLIANCE profile, no enterprise plan. */
  "ORGANIZATION",
  /** Fortune-500 / enterprise tier. Organization workspace + enterprise plan + SSO/SCIM available. */
  "ENTERPRISE",
  /** Government / public-sector agency. Organization workspace, government billing path. */
  "GOVERNMENT_AGENCY",
] as const;

export type TomPersonaKind = (typeof TOM_PERSONA_KINDS)[number];

// =============================================================================
// Projection input — read from the canonical platform-context envelope
// =============================================================================

/**
 * Bounded input shape for `projectTomPersona`. Mirrors the relevant
 * envelope fields without coupling this module to the envelope type
 * (which lives in `apps/web` and `services/api`).
 *
 * All fields are read-only. Pass the canonical envelope values
 * verbatim; the projection never mutates the input.
 */
export type TomPersonaProjectionInput = {
  /**
   * The canonical workspace kind for the active workspace, or `null`
   * when the envelope has no active workspace (degraded state).
   */
  readonly workspaceKind: TargetWorkspaceKind | null;
  /**
   * The plan code on the active workspace, normalised to lowercase
   * tokens (e.g. `"free" | "payg" | "pro" | "team" | "enterprise" |
   * "government"`). `null` when unknown.
   */
  readonly plan: string | null;
  /**
   * The use-case persona profile chosen during onboarding (Phase 38
   * `WorkspacePersonaProfile`). `null` when no row exists yet (the
   * canonical default is then `INDIVIDUAL`).
   */
  readonly useCaseProfile: string | null;
  /**
   * The viewer's role on the active workspace (e.g. `"OWNER"`,
   * `"ADMIN"`, `"REVIEWER"`). `null` for personal workspaces.
   */
  readonly role: string | null;
  /**
   * Whether the organization has SSO/SCIM enabled. Distinguishes
   * `ORGANIZATION` from `ENTERPRISE` on org workspaces.
   */
  readonly hasSsoOrScim: boolean;
  /**
   * Whether the workspace is in a government billing / procurement
   * mode. Distinguishes `GOVERNMENT_AGENCY` from `ENTERPRISE`.
   */
  readonly isGovernmentTenant: boolean;
  /**
   * Total active member count on the workspace. Used to disambiguate
   * `SMALL_TEAM` from larger organizational tiers when the workspace
   * kind is `ORGANIZATION` but headcount is low. `null` when unknown.
   */
  readonly activeMemberCount: number | null;
};

// =============================================================================
// Pure projection function
// =============================================================================

const PERSONAL_USE_CASE_TO_PERSONA: Record<string, TomPersonaKind> = {
  JOURNALIST: "JOURNALIST",
  LAWYER: "LAWYER",
  INVESTIGATOR: "INVESTIGATOR",
  INSURANCE: "INVESTIGATOR", // insurance SIU is an investigator vertical
};

const SMALL_TEAM_HEADCOUNT_CEILING = 10;

/**
 * Project a TOM persona from envelope inputs. PURE — no I/O.
 *
 * Decision tree (resolved in order, first match wins):
 *
 *   1. No workspace kind → INDIVIDUAL (default for degraded /
 *      pre-bootstrap envelopes).
 *
 *   2. Workspace kind is PERSONAL:
 *        - Use the use-case profile to disambiguate:
 *          JOURNALIST / LAWYER / INVESTIGATOR / INSURANCE
 *        - Otherwise INDIVIDUAL.
 *
 *   3. Workspace kind is ORGANIZATION:
 *        - Government tenant → GOVERNMENT_AGENCY.
 *        - SSO/SCIM enabled OR plan is "enterprise" → ENTERPRISE.
 *        - Active members below the small-team ceiling AND no
 *          enterprise-shaped signal → SMALL_TEAM.
 *        - Otherwise ORGANIZATION.
 *
 * NEVER returns null. Always returns one of `TOM_PERSONA_KINDS`.
 */
export function projectTomPersona(
  input: TomPersonaProjectionInput,
): TomPersonaKind {
  if (input.workspaceKind === null) {
    return "INDIVIDUAL";
  }

  if (input.workspaceKind === "PERSONAL") {
    if (input.useCaseProfile) {
      const mapped = PERSONAL_USE_CASE_TO_PERSONA[input.useCaseProfile];
      if (mapped) return mapped;
    }
    return "INDIVIDUAL";
  }

  // workspaceKind === "ORGANIZATION"
  if (input.isGovernmentTenant) {
    return "GOVERNMENT_AGENCY";
  }

  const planLower = (input.plan ?? "").toLowerCase();
  if (input.hasSsoOrScim || planLower === "enterprise") {
    return "ENTERPRISE";
  }

  if (
    input.activeMemberCount !== null &&
    input.activeMemberCount > 0 &&
    input.activeMemberCount <= SMALL_TEAM_HEADCOUNT_CEILING
  ) {
    return "SMALL_TEAM";
  }

  return "ORGANIZATION";
}

// =============================================================================
// Display copy
// =============================================================================

const TOM_PERSONA_LABELS: Record<TomPersonaKind, string> = {
  INDIVIDUAL: "Individual",
  JOURNALIST: "Journalist",
  LAWYER: "Lawyer",
  INVESTIGATOR: "Investigator",
  SMALL_TEAM: "Small team",
  ORGANIZATION: "Organization",
  ENTERPRISE: "Enterprise",
  GOVERNMENT_AGENCY: "Government agency",
};

const TOM_PERSONA_SHORT_LABELS: Record<TomPersonaKind, string> = {
  INDIVIDUAL: "Individual",
  JOURNALIST: "Journalist",
  LAWYER: "Lawyer",
  INVESTIGATOR: "Investigator",
  SMALL_TEAM: "Team",
  ORGANIZATION: "Org",
  ENTERPRISE: "Enterprise",
  GOVERNMENT_AGENCY: "Gov",
};

export function tomPersonaLabel(kind: TomPersonaKind): string {
  return TOM_PERSONA_LABELS[kind];
}

export function tomPersonaShortLabel(kind: TomPersonaKind): string {
  return TOM_PERSONA_SHORT_LABELS[kind];
}

/**
 * Returns true when the persona represents a personal/solo footprint
 * (Individual + the three personal-aware verticals: Journalist,
 * Lawyer, Investigator). UX consumers use this to choose between
 * "you" and "your team" copy.
 */
export function isSoloTomPersona(kind: TomPersonaKind): boolean {
  return (
    kind === "INDIVIDUAL" ||
    kind === "JOURNALIST" ||
    kind === "LAWYER" ||
    kind === "INVESTIGATOR"
  );
}

/**
 * Returns true when the persona represents an organization-tier
 * footprint (Small team, Organization, Enterprise, Government).
 */
export function isOrgTomPersona(kind: TomPersonaKind): boolean {
  return !isSoloTomPersona(kind);
}
