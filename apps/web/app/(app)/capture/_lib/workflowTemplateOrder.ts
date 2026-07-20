/**
 * Capture template ordering.
 *
 * Pure function. Reorders the canonical `COLLECTION_PLAN_TEMPLATES`
 * list so the canonical priority templates appear first. NEVER adds or
 * removes templates — capability is upstream and the operator can
 * always pick any template.
 *
 * (2026-07-20) The per-workflow-profile priority lists were removed
 * with the workspace-persona / workflow-personalization feature.
 * Ordering is now canonical for every operator.
 *
 * Hard rules:
 *
 *   1. Pure. Same input → same output.
 *   2. Preserving — every input template appears in the output exactly
 *      once. The function is structurally a partition + concat, so the
 *      length is invariant.
 *   3. Priority PRIORITISES templates; absence does not remove.
 */

import type { CollectionPlanTemplate } from "./types";

/**
 * Canonical priority template ids. Templates not listed still appear
 * (in canonical order) after the priority slice.
 */
export const CANONICAL_TEMPLATE_PRIORITY: ReadonlyArray<string> = [
  "general-evidence-record",
];

/**
 * Reorder capture templates so the canonical priority templates lead
 * the list. The returned array contains exactly the same templates as
 * the input — only the order changes. No template is ever hidden.
 */
export function orderTemplatesByWorkflow(input: {
  templates: ReadonlyArray<CollectionPlanTemplate>;
}): ReadonlyArray<CollectionPlanTemplate> {
  const priorityIds = CANONICAL_TEMPLATE_PRIORITY;
  if (priorityIds.length === 0) return [...input.templates];

  const byId = new Map<string, CollectionPlanTemplate>(
    input.templates.map((t) => [t.id, t]),
  );
  const claimed = new Set<string>();
  const ordered: CollectionPlanTemplate[] = [];

  for (const id of priorityIds) {
    if (byId.has(id) && !claimed.has(id)) {
      ordered.push(byId.get(id)!);
      claimed.add(id);
    }
  }
  for (const t of input.templates) {
    if (!claimed.has(t.id)) ordered.push(t);
  }
  return ordered;
}
