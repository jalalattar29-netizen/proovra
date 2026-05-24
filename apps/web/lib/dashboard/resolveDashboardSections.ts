/**
 * PHASE R3 — Canonical dashboard section orchestrator.
 *
 * Pure function. Combines workspace experience mode + persona +
 * availability into a single ordered list of sections with emphasis
 * labels.
 *
 * Layering (mode wins over persona; persona wins over canonical):
 *
 *   1. Mode priority pulls its matching sections to the front, in
 *      mode-priority order, with `emphasis = "primary"`.
 *   2. Persona priority then pulls its matching sections (that
 *      didn't already match the mode), with `emphasis = "secondary"`.
 *   3. Remaining available sections retain canonical input order
 *      with `emphasis = "de-emphasized"`.
 *
 * Hard rules:
 *
 *   - NEVER adds or removes a section. The orchestrator can only
 *     reorder + label.
 *   - NEVER consults route-level authorization fields.
 *   - Pure function. Same input → same output.
 */

import { MODE_SECTION_PRIORITY } from "./dashboardModeRules";
import { getPersonaSectionOrder } from "../platform-context/personaSectionOrder";
import type { WorkspacePersonaProfile } from "../platform-context/types";
import type {
  DashboardSectionsInput,
  DashboardSectionsResult,
  OrderedSectionId,
} from "./types";

export function resolveDashboardSections(
  input: DashboardSectionsInput,
): DashboardSectionsResult {
  const available = new Set(input.availableSectionIds);

  // Step 1 — mode priority. Pick matching sections in mode order.
  const modePriority = MODE_SECTION_PRIORITY[input.mode] ?? [];
  const claimed = new Set<string>();
  const ordered: OrderedSectionId[] = [];

  for (const id of modePriority) {
    if (available.has(id) && !claimed.has(id)) {
      ordered.push({ id, emphasis: "primary" });
      claimed.add(id);
    }
  }

  // Step 2 — persona priority over what's left. Delegate to the
  // existing canonical persona helper so we never duplicate that
  // logic, then label everything it adds as `secondary`.
  const personaOrdered = getPersonaSectionOrder({
    persona: input.persona as WorkspacePersonaProfile,
    availableSectionIds: input.availableSectionIds,
  });
  for (const id of personaOrdered) {
    if (!available.has(id)) continue;
    if (claimed.has(id)) continue;
    ordered.push({ id, emphasis: "secondary" });
    claimed.add(id);
  }

  // Step 3 — remaining available sections in canonical input order
  // get `de-emphasized` emphasis. The dashboard still renders them
  // (per the no-remove rule); R5/R6 may decide to fold these into a
  // collapsible "Advanced" section.
  for (const id of input.availableSectionIds) {
    if (claimed.has(id)) continue;
    ordered.push({ id, emphasis: "de-emphasized" });
    claimed.add(id);
  }

  return {
    sectionOrder: ordered.map((s) => s.id),
    sections: ordered,
  };
}
