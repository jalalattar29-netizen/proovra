/**
 * PHASE 38.10 — Workflow-aware capture template ordering.
 *
 * Pure function. Reorders the canonical `COLLECTION_PLAN_TEMPLATES`
 * list so the workflow profile's primary templates appear first. NEVER
 * adds or removes templates — capability is upstream and the operator
 * can always pick any template.
 *
 * Hard rules:
 *
 *   1. Pure. Same input → same output.
 *   2. Preserving — every input template appears in the output exactly
 *      once. The function is structurally a partition + concat, so the
 *      length is invariant.
 *   3. Workflow tags PRIORITISE templates; absence does not remove.
 *   4. Bounded template ids — the priority lists below are pinned to
 *      the canonical template id strings.
 */

import type { WorkflowProfileCode } from "../../../../lib/platform-context";
import type { CollectionPlanTemplate } from "./types";

/**
 * Priority template ids per workflow profile. Templates not listed
 * still appear (in canonical order) after the priority slice.
 */
export const WORKFLOW_TEMPLATE_PRIORITY: Record<
  WorkflowProfileCode,
  ReadonlyArray<string>
> = {
  VERIFICATION_DOCUMENTATION: ["general-evidence-record"],
  LEGAL_CASEWORK: ["legal-matter", "general-evidence-record"],
  REVIEW_OPERATIONS: ["insurance-claim", "general-evidence-record"],
  INVESTIGATION_RECONSTRUCTION: [
    "incident-investigation",
    "general-evidence-record",
  ],
  MEDIA_VERIFICATION: [
    "journalism-field-capture",
    "general-evidence-record",
  ],
  GOVERNANCE_COMPLIANCE: ["compliance-audit", "general-evidence-record"],
  OPERATIONAL_ADMINISTRATION: [
    "compliance-audit",
    "incident-investigation",
    "general-evidence-record",
  ],
};

/**
 * Reorder capture templates so the workflow's priority templates lead
 * the list. The returned array contains exactly the same templates as
 * the input — only the order changes. No template is ever hidden.
 */
export function orderTemplatesByWorkflow(input: {
  templates: ReadonlyArray<CollectionPlanTemplate>;
  workflow: WorkflowProfileCode;
}): ReadonlyArray<CollectionPlanTemplate> {
  const priorityIds = WORKFLOW_TEMPLATE_PRIORITY[input.workflow] ?? [];
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
