import type { WorkspaceAiFeature } from "./workspace-ai-policy.service.js";

/**
 * WHICH POLICY SWITCH GOVERNS WHICH AI OPERATION.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 * PROOVRA has two "feature" vocabularies, and they are not the same axis:
 *
 *   POLICY FEATURE (`WorkspaceAiFeature`) — the switch an administrator can
 *   turn off. Seven of them, a TypeScript union, enforced by the evaluator.
 *
 *   OPERATION LABEL — what actually ran, recorded on `AiUsageEvent.feature`
 *   and `AiCopilotRun.feature`. Both are `String` columns, so nothing in the
 *   type system ever connected the two.
 *
 * Six labels happen to spell the same word as their policy feature. One does
 * not: `/v1/ai/evidence/:id/copilot` records its usage as `EVIDENCE_COPILOT`
 * while its policy gate evaluates `EVIDENCE_CATEGORIZATION`. Read from the
 * usage table, the evidence copilot appeared to be governed by a switch that
 * does not exist.
 *
 * =============================================================================
 * WHY THE LABELS ARE NOT SIMPLY MERGED
 * =============================================================================
 * The obvious tidy-up — rename `EVIDENCE_COPILOT` to `EVIDENCE_CATEGORIZATION`
 * — is wrong twice over.
 *
 * They are genuinely different operations. `/v1/evidence/:id/ai-categorization`
 * runs the advisory provider over evidence metadata; `/v1/ai/evidence/:id/
 * copilot` runs the structured copilot provider with a JSON schema, a different
 * model variable, and a different cost. Collapsing them would make it
 * impossible to tell from the usage ledger which one a workspace was spending
 * on — losing real operational information to fix a naming complaint.
 *
 * And the labels are PERSISTED. Renaming means migrating historical rows, or
 * accepting a table where the same operation is called two things depending on
 * when it ran. Neither is an improvement on a mapping.
 *
 * The other direction — giving the evidence copilot its own policy flag —
 * would add an eighth switch that no administrator asked for, and would change
 * behaviour: a workspace that disabled evidence AI today would silently regain
 * the copilot tomorrow under a flag defaulting to something. A naming fix must
 * not change what is enabled.
 *
 * =============================================================================
 * SO: ONE MAPPING, STATED ONCE
 * =============================================================================
 * The operation keeps its precise label; the policy keeps its switch; and the
 * relationship between them stops being an implicit convention repeated at
 * each call site and becomes a table that can be read and tested.
 *
 * Adding an operation without deciding what governs it is now a type error,
 * which is the property that was missing.
 *
 * NOTE — this maps to a policy switch only. It does NOT decide budget: daily
 * and monthly limits are per WORKSPACE (`aiUsageDaily` is keyed
 * `workspaceId_dayUtc`, with no feature dimension), so the label has never
 * participated in a limit decision and the mismatch was never a budget bypass.
 * It is attribution, and attribution is what was wrong.
 */

/** Every distinct AI operation that can consume budget or produce a run row. */
export type AiOperation =
  | "SUPPORT_CHAT"
  | "CAPTURE_ASSISTANCE"
  | "EVIDENCE_CATEGORIZATION"
  | "EVIDENCE_COPILOT"
  | "CASE_COPILOT"
  | "REVIEWER_COPILOT"
  | "SEMANTIC_SEARCH";

/**
 * The governing policy switch for each operation.
 *
 * `Record<AiOperation, …>` is the point: a new operation cannot be added
 * without naming the switch that turns it off.
 */
export const AI_OPERATION_POLICY_FEATURE: Record<AiOperation, WorkspaceAiFeature> = {
  SUPPORT_CHAT: "SUPPORT_CHAT",
  CAPTURE_ASSISTANCE: "CAPTURE_ASSISTANCE",
  EVIDENCE_CATEGORIZATION: "EVIDENCE_CATEGORIZATION",
  /*
   * The one operation whose label differs from its switch.
   *
   * The evidence copilot reads the same evidence metadata the categorisation
   * feature does and sends the same allow-listed fields outbound, so it is the
   * same decision for an administrator: turning off evidence AI turns off both.
   * Giving it a switch of its own would let a workspace that has already opted
   * out get it back by default.
   */
  EVIDENCE_COPILOT: "EVIDENCE_CATEGORIZATION",
  CASE_COPILOT: "CASE_COPILOT",
  REVIEWER_COPILOT: "REVIEWER_COPILOT",
  SEMANTIC_SEARCH: "SEMANTIC_SEARCH",
};

/**
 * The policy switch a route must evaluate before running `operation`.
 *
 * Call this rather than writing the feature name at the gate: the two are then
 * one decision in one place, and a route cannot drift from the label it later
 * records.
 */
export function policyFeatureForOperation(operation: AiOperation): WorkspaceAiFeature {
  return AI_OPERATION_POLICY_FEATURE[operation];
}

/** The operations governed by a given switch — for operator-facing surfaces. */
export function operationsGovernedBy(feature: WorkspaceAiFeature): AiOperation[] {
  return (Object.keys(AI_OPERATION_POLICY_FEATURE) as AiOperation[]).filter(
    (op) => AI_OPERATION_POLICY_FEATURE[op] === feature,
  );
}
