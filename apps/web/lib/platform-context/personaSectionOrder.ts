/**
 * PHASE 38.2 — Persona-aware dashboard section order.
 *
 * Pure function. Given the Command Center envelope's section ids, returns
 * a persona-appropriate display order. NEVER adds or removes sections —
 * just reorders the existing ones.
 *
 * Hard rules:
 *
 *   1. Capabilities remain authoritative. A section that the user
 *      cannot see based on capability is already absent from the
 *      input set; persona doesn't bring it back.
 *   2. Pure function. Same input → same output. No fetches, no role
 *      derivation, no side effects.
 *   3. Bounded section ids. The persona priority lists below reference
 *      the canonical Command Center section ids (`summary`,
 *      `operationalPressure`, etc.).
 *   4. Stable for unknown personas. Falls back to canonical default
 *      order when persona is unrecognised.
 */

import type { WorkspacePersonaProfile } from "./types";

/**
 * Bounded section-id priority list per persona. Sections matching
 * the leading ids land first; the remainder retain canonical order.
 *
 * Section ids match the Command Center envelope's
 * `CommandCenterEnvelope["sections"]` keys.
 */
export const PERSONA_DASHBOARD_PRIORITY: Record<
  WorkspacePersonaProfile,
  ReadonlyArray<string>
> = {
  INDIVIDUAL: [
    "summary",
    "projectionSummary",
    "recentEvidence",
    "caseOperations",
    "pipelineDetail",
  ],
  LAWYER: [
    "caseOperations",
    "summary",
    "pipelineDetail",
    "governancePosture",
    "auditReadiness",
    "recentEvidence",
  ],
  INSURANCE: [
    "reviewerOrchestration",
    "operationalPressure",
    "caseOperations",
    "summary",
    "pipelineDetail",
  ],
  INVESTIGATOR: [
    "investigationIntelligence",
    "timeline",
    "caseOperations",
    "recentEvidence",
    "summary",
  ],
  JOURNALIST: [
    "summary",
    "pipelineDetail",
    "recentEvidence",
    "caseOperations",
  ],
  ENTERPRISE_COMPLIANCE: [
    "governancePosture",
    "auditReadiness",
    "operationalPressure",
    "summary",
    "caseOperations",
  ],
  ADMIN_OPERATOR: [
    "operationalPressure",
    "incidents",
    "reviewerOrchestration",
    "summary",
    "pipelineDetail",
    "organizationalIntelligence",
  ],
};

/**
 * Reorder a list of section ids by persona priority. Unknown sections
 * retain their original order after the prioritized ones.
 *
 *   priorityIds: ids matching the persona's priority list, in priority order
 *   remaining:   ids that didn't match, in original input order
 *   result:      [...priorityIds, ...remaining]
 */
export function getPersonaSectionOrder(input: {
  persona: WorkspacePersonaProfile;
  availableSectionIds: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const priorityList = PERSONA_DASHBOARD_PRIORITY[input.persona] ?? [];
  if (input.availableSectionIds.length === 0) {
    return [];
  }
  if (priorityList.length === 0 || input.persona === "INDIVIDUAL") {
    return [...input.availableSectionIds];
  }
  const available = new Set(input.availableSectionIds);
  const claimed = new Set<string>();
  const ordered: string[] = [];
  for (const id of priorityList) {
    if (available.has(id) && !claimed.has(id)) {
      ordered.push(id);
      claimed.add(id);
    }
  }
  for (const id of input.availableSectionIds) {
    if (!claimed.has(id)) ordered.push(id);
  }
  return ordered;
}
