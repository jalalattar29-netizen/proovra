/**
 * Phase 32.8C — /home renders the Enterprise Evidence Operations
 * Command Center.
 *
 * The previous /home page was a marketing-style hero + single
 * evidence list. Phase 32.8C consolidates the dashboard surface
 * into the Command Center, which:
 *   - is data-driven (every section is backed by real backend state)
 *   - is workspace-aware (personal vs team behavior)
 *   - is role-aware (mutation CTAs filtered by role)
 *   - degrades gracefully (per-section status; one degraded
 *     subsystem does not poison the whole dashboard)
 *   - never invents metrics, fake charts, or marketing copy
 *
 * The data comes from `/v1/dashboard/command-center` — a read-only,
 * partial-failure-tolerant aggregator added in this phase.
 */

import { CommandCenter } from "../../../components/command-center/CommandCenter";

export default function HomePage() {
  return <CommandCenter />;
}
