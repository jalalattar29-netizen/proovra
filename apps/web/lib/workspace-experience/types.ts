/**
 * PHASE R1.5B — Workspace experience segmentation types.
 *
 * Pure data types for the canonical experience-mode resolver. No
 * authorization, no permission, no fetch. The experience mode is an
 * EMPHASIS axis ON TOP of the canonical access + workflow chain — it
 * NEVER changes what a user is allowed to load.
 */

/**
 * The four canonical experience modes. The mode describes WHAT KIND
 * of operational experience the current context calls for — not what
 * permissions it has. Capabilities continue to be the only source of
 * truth for authorization.
 */
export type WorkspaceExperienceMode =
  | "PERSONAL"
  | "ORGANIZATION"
  | "REVIEW_OPS"
  | "GOVERNANCE";

/**
 * Inputs to the experience resolver. Read-only views of the canonical
 * envelope state. The resolver is a PURE function of these inputs.
 */
export interface WorkspaceExperienceInput {
  /** "PERSONAL" or "ORGANIZATION" or null while loading. */
  readonly activeSpaceType: "PERSONAL" | "ORGANIZATION" | null;
  /**
   * Per-capability boolean map (from `envelope.capabilities`). Used
   * ONLY to choose ORG sub-mode emphasis (REVIEW_OPS vs GOVERNANCE
   * vs generic ORGANIZATION). Never used to authorize anything; the
   * route-access resolver remains authoritative for that.
   */
  readonly capabilities: Readonly<Record<string, boolean>>;
  /**
   * Primary workflow code (from `workflowFromPersona(persona)`).
   * Used to tilt the ORG sub-mode toward review-ops vs governance
   * vs operations, when the active space is ORGANIZATION.
   */
  readonly primaryWorkflow: string;
}

/**
 * Resolver output.
 *
 *   - `mode` — the chosen experience mode.
 *   - `subModeReason` — debug string explaining why the resolver
 *     chose this mode (for tests + the dev observability trace).
 *   - `demotionRouteIds` — the bounded set of route ids that the
 *     sidebar should push from `primaryItems`/`secondaryItems` into
 *     `moreAdvancedItems` for this mode. The route stays reachable
 *     via the "More / Advanced" disclosure, All Tools, search, and
 *     direct links — only the primary-prominence changes.
 *   - `dashboardEmphasis` — a short label the dashboard component
 *     uses for its `data-cc-experience-mode` attribute, so CSS /
 *     R3 work can target the emphasis without a feature fork.
 *   - `helpAudience` — a short label the help / empty-state /
 *     recommendation surfaces can consume to vary copy by mode.
 */
export interface WorkspaceExperienceResult {
  readonly mode: WorkspaceExperienceMode;
  readonly subModeReason: string;
  readonly demotionRouteIds: ReadonlySet<string>;
  readonly dashboardEmphasis:
    | "personal-quick-actions"
    | "organization-operational"
    | "review-ops"
    | "governance-compliance";
  readonly helpAudience:
    | "personal-operator"
    | "organization-operator"
    | "review-ops-operator"
    | "governance-operator";
}
