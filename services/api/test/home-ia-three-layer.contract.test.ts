/**
 * Phase 7C — Home information-architecture lock (supersedes the old
 * 3-layer HomeLayerHeader IA).
 *
 * Home is now a clean Evidence Operations LANDING page, not a flat
 * scroll-wall of diagnostic cards. The default (above-the-fold) region
 * leads with the operational overview + "what needs you now" + recent
 * work; the deep diagnostic cards are RELEGATED into a collapsed
 * `<details data-home-diagnostics>` disclosure ("one click away, off the
 * default view"). This test pins that contract:
 *
 *   • the overview leads (ExecutiveSummary + KPI + OperationalQueue +
 *     RecentEvidence appear in the default region);
 *   • the `data-home-diagnostics` disclosure exists and OWNS the deep
 *     diagnostic cards;
 *   • those diagnostic cards do NOT render as default content above it.
 *
 * If a future pass dumps the diagnostics back into the default view (the
 * exact regression Phase 7C fixed), this test fails.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const DASH = readFileSync(
  resolve(
    REPO_ROOT,
    "apps/web/components/home-experience/SelfServeHomeDashboard.tsx",
  ),
  "utf8",
);

function indexOfOrThrow(needle: string): number {
  const idx = DASH.indexOf(needle);
  if (idx < 0) throw new Error(`Missing in dashboard source: ${needle}`);
  return idx;
}

// The disclosure marker is the boundary between the clean landing region
// (before) and the relegated diagnostics region (after).
const DIAGNOSTICS_MARKER = "data-home-diagnostics";

describe("Phase 7C Home — diagnostics are relegated behind a disclosure", () => {
  it("renders a `data-home-diagnostics` disclosure (deep diagnostics are not default content)", () => {
    expect(DASH).toMatch(/data-home-diagnostics/);
  });

  it("the overview LEADS: ExecutiveSummary + KPI + OperationalQueue + RecentEvidence render before the diagnostics disclosure", () => {
    const boundary = indexOfOrThrow(DIAGNOSTICS_MARKER);
    const landing = DASH.slice(0, boundary);
    expect(landing).toMatch(/<ExecutiveSummaryBand/);
    expect(landing).toMatch(/<KpiRow/);
    expect(landing).toMatch(/<OperationalQueue/);
    expect(landing).toMatch(/<RecentEvidenceCard/);
  });

  it("the deep diagnostic cards do NOT appear in the default (pre-disclosure) region", () => {
    const boundary = indexOfOrThrow(DIAGNOSTICS_MARKER);
    const landing = DASH.slice(0, boundary);
    // These are the dense signals Phase 7C moved OFF the default view.
    expect(landing).not.toMatch(/<TrustStateCard/);
    expect(landing).not.toMatch(/<EvidenceTypeDonutCard/);
    expect(landing).not.toMatch(/<EvidenceActivityChart/);
    expect(landing).not.toMatch(/<StorageUsageCard/);
    expect(landing).not.toMatch(/<WorkspaceHealthCard/);
    expect(landing).not.toMatch(/<ActivityFeed/);
  });

  it("the diagnostics disclosure OWNS the deep diagnostic cards (relegated, not deleted)", () => {
    const boundary = indexOfOrThrow(DIAGNOSTICS_MARKER);
    const diagnostics = DASH.slice(boundary);
    expect(diagnostics).toMatch(/<TrustStateCard/);
    expect(diagnostics).toMatch(/<VerificationHealthCard/);
    expect(diagnostics).toMatch(/<WorkspaceHealthCard/);
    expect(diagnostics).toMatch(/<EvidenceTypeDonutCard/);
    expect(diagnostics).toMatch(/<EvidenceActivityChart/);
    expect(diagnostics).toMatch(/<ActivityFeed/);
    expect(diagnostics).toMatch(/<StorageUsageCard/);
  });
});
