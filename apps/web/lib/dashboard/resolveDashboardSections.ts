/**
 * PHASE R3 — Canonical dashboard section orchestrator.
 *
 * Pure function. Combines workspace experience mode + availability
 * into a single ordered list of sections with emphasis labels.
 *
 * (2026-07-20) The persona priority layer was removed with the
 * workspace-persona / workflow-personalization feature. Ordering is
 * now driven solely by the experience mode + canonical input order.
 *
 * Layering (mode wins over canonical):
 *
 *   1. Mode priority pulls its matching sections to the front, in
 *      mode-priority order, with `emphasis = "primary"`.
 *   2. Remaining available sections retain canonical input order
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

  // Step 2 — remaining available sections in canonical input order
  // get `de-emphasized` emphasis. The dashboard still renders them
  // (per the no-remove rule).
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
