/**
 * Canonical USER-VISIBLE AI capability resolver (2026-07-17 Settings
 * remediation, §9).
 *
 * ONE pure derivation that decides what the `/settings/ai` surface and the
 * Settings-overview AI card show for the current workspace/plan/role.
 * Filters by plan entitlement, launch status, workspace type, and role —
 * never by "a checkbox exists on the policy row".
 *
 * PRODUCT BOUNDARIES it enforces:
 *   - Personal users get a concise AI-ASSISTANCE page: master control +
 *     the LAUNCHED personal features only. Internal stubs, unlaunched
 *     copilots, provider diagnostics, and enterprise data-class
 *     governance NEVER render for personal users.
 *   - Organization ENTERPRISE Admin/Owner get the governance view
 *     (full policy incl. data-class controls + capability disclosure).
 *   - Ordinary organization members get a concise READ-ONLY policy
 *     summary — no editing.
 *   - Personal FREE (allowance 0) gets an honest "not included" surface
 *     with no editable controls.
 *
 * RELEVANCE/PRESENTATION ONLY — the backend AI policy evaluator and the
 * AI cost guard stay the enforcement points for every AI call, and the
 * PUT policy route keeps its own OWNER/ADMIN authorization.
 */

export type AiSettingsMode =
  | "personal-assistance"
  | "personal-not-included"
  | "org-governance"
  | "org-readonly";

export type AiAssistanceViewInput = {
  workspaceKind: "PERSONAL" | "ORGANIZATION" | null;
  /**
   * envelope.planFeatures.aiAssistanceMonthlyOperations:
   * 0 = not included, n>0 = monthly cap, null = custom (Enterprise),
   * undefined = envelope predates the field (treated as included so a
   * stale envelope never hides a real surface).
   */
  monthlyAllowance: number | null | undefined;
  /** Active-org role when the workspace is an ORGANIZATION. */
  orgRole: "OWNER" | "ADMIN" | "MEMBER" | "VIEWER" | null;
};

export function deriveAiSettingsMode(input: AiAssistanceViewInput): AiSettingsMode {
  if (input.workspaceKind === "ORGANIZATION") {
    return input.orgRole === "OWNER" || input.orgRole === "ADMIN"
      ? "org-governance"
      : "org-readonly";
  }
  if (input.monthlyAllowance === 0) return "personal-not-included";
  return "personal-assistance";
}

/** The Settings-overview AI card renders only when something real exists. */
export function showAiOverviewCard(mode: AiSettingsMode): boolean {
  return mode !== "personal-not-included";
}

// -----------------------------------------------------------------------------
// Launched personal features — the ONLY capabilities a personal user sees.
// Keys map 1:1 onto the canonical workspace AI policy columns; everything
// else on the policy row (semantic search, content intelligence, copilots,
// raw-content/OCR/transcription/embeddings data-class controls) is either
// not launched for personal plans or is enterprise governance, and is
// filtered OUT here — hidden, not deleted (the backend capability remains).
// -----------------------------------------------------------------------------

export type PersonalAiFeature = {
  key:
    | "supportChatEnabled"
    | "captureAssistanceEnabled"
    | "evidenceCategorizationEnabled";
  label: string;
  description: string;
};

export const LAUNCHED_PERSONAL_AI_FEATURES: ReadonlyArray<PersonalAiFeature> = [
  {
    key: "supportChatEnabled",
    label: "Support assistant",
    description:
      "Answers product and evidence-operations questions. Uses metadata only.",
  },
  {
    key: "captureAssistanceEnabled",
    label: "Capture assistance",
    description:
      "Advisory completeness suggestions while you capture evidence.",
  },
  {
    key: "evidenceCategorizationEnabled",
    label: "Evidence categorization",
    description:
      "Advisory, metadata-based categorization of newly captured evidence.",
  },
];

export type PersonalAiPolicySlice = {
  aiEnabled: boolean;
  supportChatEnabled: boolean;
  captureAssistanceEnabled: boolean;
  evidenceCategorizationEnabled: boolean;
};

/** How many launched features are currently active (0 when master is off). */
export function enabledPersonalFeatureCount(
  policy: PersonalAiPolicySlice | null,
): number | null {
  if (!policy) return null;
  if (!policy.aiEnabled) return 0;
  return LAUNCHED_PERSONAL_AI_FEATURES.filter((f) => Boolean(policy[f.key]))
    .length;
}
