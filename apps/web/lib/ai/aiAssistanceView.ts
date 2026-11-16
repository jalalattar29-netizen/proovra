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
 *   - Organization members holding the SERVER-projected SETTINGS_MANAGE
 *     capability get the governance view (full policy incl. data-class
 *     controls + capability disclosure).
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
  /**
   * B6-F-27 (free-user audit 0ea0) — a personal workspace somebody else owns,
   * seen by a member who cannot manage its AI policy: the member-safe status
   * view, never the owner's switches (a save would be refused).
   */
  | "personal-readonly"
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
  /**
   * PHASE 12 POINT 4 STEP 1 — SERVER-projected authority to change the
   * workspace AI policy, read from `envelope.capabilities.SETTINGS_MANAGE`.
   *
   * This replaces the former `orgRole === "OWNER" || orgRole === "ADMIN"`
   * client comparison. `SETTINGS_MANAGE` is granted by
   * `capability-registry.ts` to exactly the OWNER/ADMIN membership that
   * `PUT /v1/workspaces/ai-policy` enforces via the
   * `intelligence.policy.manage` permission, so the editable surface and
   * the write gate cannot disagree.
   *
   * `null` = envelope loading / degraded / capability absent → FAIL CLOSED
   * (read-only governance summary, never an editable policy form).
   */
  canManageWorkspaceAiPolicy: boolean | null;
};

export function deriveAiSettingsMode(input: AiAssistanceViewInput): AiSettingsMode {
  if (input.workspaceKind === "ORGANIZATION") {
    return input.canManageWorkspaceAiPolicy === true
      ? "org-governance"
      : "org-readonly";
  }
  // B6-F-27 — editability follows the management capability, not the space
  // type: a member of a shared personal workspace reads the owner's policy
  // (intelligence.read) but may not change it. Unknown (null) keeps the
  // server-gated editor, as before.
  if (input.canManageWorkspaceAiPolicy === false) return "personal-readonly";
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

/**
 * Free audit B6-F-22 / B6-F-46 — the policy switches that turn on a PAID AI
 * capability (mirrors the API's PAID_AI_SWITCHES in
 * workspace-ai-policy.routes.ts). `PUT /v1/workspaces/ai-policy` refuses to
 * switch any of them ON where the workspace plan does not include the
 * capability (403 ENTITLEMENT_REQUIRED, `details.fields`); turning one off,
 * or re-sending a value the row already holds, still succeeds.
 */
export const PAID_AI_POLICY_SWITCHES = [
  "semanticSearchEnabled",
  "embeddingsAllowed",
  "contentIntelligenceEnabled",
  "rawContentProcessingAllowed",
  "ocrAllowed",
  "transcriptionAllowed",
  "reviewerCopilotEnabled",
  "caseCopilotEnabled",
] as const;
export type PaidAiPolicySwitch = (typeof PAID_AI_POLICY_SWITCHES)[number];

/** Plans whose catalog entry includes only the advisory trial capabilities. */
const TRIAL_AI_PLANS = new Set(["FREE", "PAYG"]);

export const AI_SWITCH_NOT_INCLUDED_COPY = "Not included in your plan";

/**
 * Which paid switches are plan-locked for this workspace. Two server answers
 * feed it: the plan the usage read resolved for the workspace (FREE / PAYG
 * carry no paid AI capability), and the `details.fields` of a refused save.
 * An unknown plan locks nothing (the server still refuses).
 */
export function planLockedAiSwitches(input: {
  workspacePlan?: string | null;
  refusedFields?: ReadonlyArray<string> | null;
}): ReadonlySet<string> {
  const locked = new Set<string>();
  const plan = typeof input.workspacePlan === "string" ? input.workspacePlan.toUpperCase() : null;
  if (plan && TRIAL_AI_PLANS.has(plan)) {
    for (const key of PAID_AI_POLICY_SWITCHES) locked.add(key);
  }
  for (const field of input.refusedFields ?? []) {
    if ((PAID_AI_POLICY_SWITCHES as ReadonlyArray<string>).includes(field)) locked.add(field);
  }
  return locked;
}

/** The refused paid switches of a 403 ENTITLEMENT_REQUIRED save, else null. */
export function aiPolicyEntitlementRefusal(err: unknown): string[] | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { statusCode?: unknown; code?: unknown; details?: unknown };
  if (e.statusCode !== 403 || e.code !== "ENTITLEMENT_REQUIRED") return null;
  const details = e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : {};
  const fields = Array.isArray(details.fields)
    ? details.fields.filter((f): f is string => typeof f === "string")
    : [];
  return fields.length > 0 ? fields : [...PAID_AI_POLICY_SWITCHES];
}
