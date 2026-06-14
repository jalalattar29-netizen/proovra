/**
 * Phase HOME-IA — 3-layer Home information architecture lock.
 *
 * The Home dashboard now organises its cards into three altitude
 * layers instead of one flat scroll wall:
 *
 *   Layer 1 — Overview        (Executive Summary + KPI row)
 *   Layer 2 — Your work       (Op Queue, Matters, Intake, Reports,
 *                              Priorities, Recent Evidence)
 *   Layer 3 — Verification &  (Verification summary, Public links,
 *             details         Workspace health, Records by type,
 *                             Activity chart, Recent activity,
 *                             Storage)
 *
 * Each layer is preceded by a `HomeLayerHeader` (chip + heading +
 * subtitle) that carries `data-home-layer={1|2|3}` — this is the
 * stable contract this test pins. Cards are then placed *under*
 * their owning layer in source order, so the user reads top→down
 * by altitude.
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

describe("Phase HOME-IA — three layered HomeLayerHeader chips", () => {
  it("renders Layer 1 with the 'Overview' title", () => {
    expect(DASH).toMatch(
      /<HomeLayerHeader\s+layer=\{1\}\s+title="Overview"/,
    );
  });

  it("renders Layer 2 with the 'Your work' title", () => {
    expect(DASH).toMatch(
      /<HomeLayerHeader\s+layer=\{2\}\s+title="Your work"/,
    );
  });

  it("renders Layer 3 with the 'Verification & details' title", () => {
    expect(DASH).toMatch(
      /<HomeLayerHeader\s+layer=\{3\}\s+title="Verification & details"/,
    );
  });

  it("the HomeLayerHeader component emits the `data-home-layer` contract attribute", () => {
    expect(DASH).toMatch(/data-home-layer=\{layer\}/);
  });

  it("subtitles describe what each layer answers (anti-vague-heading guard)", () => {
    expect(DASH).toMatch(
      /subtitle="What you have, what is ready, what needs you right now\."/,
    );
    expect(DASH).toMatch(
      /subtitle="Open actions, matters, intake, and report production\."/,
    );
    expect(DASH).toMatch(
      /subtitle="Trust posture, distribution, recent activity, and storage\."/,
    );
  });
});

describe("Phase HOME-IA — cards live under their owning layer (source order)", () => {
  // The dashboard source is the single source of truth for read
  // order. We pin source-order, not visual order: the rendered
  // grid follows the source. If a card moves layers in source, a
  // future copy/IA pass will fail this test and the author will
  // either confirm the move or move it back.

  it("Layer 1 contains Executive Summary + KPI row, and ONLY those (no operational cards above L2)", () => {
    const l1 = indexOfOrThrow('title="Overview"');
    const l2 = indexOfOrThrow('title="Your work"');
    const l1Slice = DASH.slice(l1, l2);
    expect(l1Slice).toMatch(/<ExecutiveSummaryBand/);
    expect(l1Slice).toMatch(/<KpiRow/);
    // L1 must NOT carry any of the Layer-2/3 cards.
    expect(l1Slice).not.toMatch(/<OperationalQueue/);
    expect(l1Slice).not.toMatch(/<TrustStateCard/);
    expect(l1Slice).not.toMatch(/<EvidenceTypeDonutCard/);
  });

  it("Layer 2 contains Op Queue, Active Matters, Intake, Report Production, Recent Evidence, Priorities", () => {
    const l2 = indexOfOrThrow('title="Your work"');
    const l3 = indexOfOrThrow('title="Verification & details"');
    const slice = DASH.slice(l2, l3);
    expect(slice).toMatch(/<OperationalQueue/);
    expect(slice).toMatch(/<ActiveMatters/);
    expect(slice).toMatch(/<IntakePipelineCard/);
    expect(slice).toMatch(/<ReportProductionCard/);
    expect(slice).toMatch(/<RecentEvidenceCard/);
    expect(slice).toMatch(/<WorkspacePrioritiesCard/);
    // L2 must NOT carry pure-detail cards.
    expect(slice).not.toMatch(/<TrustStateCard/);
    expect(slice).not.toMatch(/<EvidenceTypeDonutCard/);
    expect(slice).not.toMatch(/<StorageUsageCard/);
    expect(slice).not.toMatch(/<EvidenceActivityChart/);
  });

  it("Layer 3 contains Verification summary, Public verification links, Workspace health, Records by type, activity chart, recent activity, storage", () => {
    const l3 = indexOfOrThrow('title="Verification & details"');
    const slice = DASH.slice(l3);
    expect(slice).toMatch(/<TrustStateCard/);
    expect(slice).toMatch(/<VerificationHealthCard/);
    expect(slice).toMatch(/<WorkspaceHealthCard/);
    expect(slice).toMatch(/<EvidenceTypeDonutCard/);
    expect(slice).toMatch(/<EvidenceActivityChart/);
    expect(slice).toMatch(/<ActivityFeed/);
    expect(slice).toMatch(/<StorageUsageCard/);
    // The Op Queue must NOT sneak into L3 even if a later refactor
    // tries to consolidate the dashboard.
    expect(slice).not.toMatch(/<OperationalQueue/);
  });
});
