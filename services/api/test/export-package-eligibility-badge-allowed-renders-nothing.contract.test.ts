/**
 * Phase EVIDENCE-DETAIL-CLEANUP — regression lock for the
 * positive-state-badge removal.
 *
 * Before this pass, `ExportPackageEligibilityBadge.tsx` rendered
 * green "Export allowed" / "Package allowed" pills next to every
 * download button — even when the operator could already see the
 * action was available (the button was enabled). The user flagged
 * this as redundant UI noise.
 *
 * The fix:
 *   * ALLOWED state → render nothing.
 *   * LOADING state → render nothing (button is disabled while we
 *     wait; transient pills add no signal).
 *   * BLOCKED state → render a single warning panel with the bounded
 *     label + an actionable next-step line.
 *   * UNKNOWN (fail-closed) state → render a single warning panel
 *     stating eligibility is unavailable and actions are blocked.
 *
 * This file pins the source-level shape of that contract so a future
 * refactor cannot accidentally re-introduce the "allowed" pills.
 *
 *   1. The string literals "Export allowed", "Package allowed",
 *      "Exports allowed", "Package generation allowed" are absent
 *      from the badge file.
 *   2. The component returns `null` for the loading and eligible
 *      branches (the actual UI surface only renders for blocked /
 *      unknown).
 *   3. The fail-closed `onEligibilityChange` contract is preserved
 *      — parents still get a `disabled=true` callback while loading
 *      and on snapshot failure.
 *   4. The new restriction panel carries a next-step line keyed by
 *      the canonical reason strings emitted by the governance
 *      snapshot (parity with `GovernedExportAction.NEXT_STEP`).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const BADGE_SOURCE = readFileSync(
  resolve(
    REPO_ROOT,
    "apps",
    "web",
    "components",
    "operational",
    "ExportPackageEligibilityBadge.tsx",
  ),
  "utf8",
);
// Phase EVIDENCE-IA-DECOMPOSE — page.tsx was split into _tabs/*;
// concatenate the orchestrator + every tab body so source-shape
// assertions still find the relevant snippets.
const PAGE_SOURCE = [
  "page.tsx",
  "_tabs/_lib.tsx",
  "_tabs/EvidenceOverviewTab.tsx",
  "_tabs/EvidenceIntegrityTab.tsx",
  "_tabs/EvidenceCustodyTab.tsx",
  "_tabs/EvidenceReviewTab.tsx",
  "_tabs/EvidenceArtifactsTab.tsx",
  "_tabs/EvidenceDiscussionTab.tsx",
  "_tabs/EvidenceTechnicalAppendixTab.tsx",
]
  .map((rel) =>
    readFileSync(
      resolve(REPO_ROOT, "apps", "web", "app", "(app)", "evidence", "[id]", rel),
      "utf8",
    ),
  )
  .join("\n\n");

describe("ExportPackageEligibilityBadge — positive-state removal", () => {
  it("does NOT contain the positive-state badge labels", () => {
    // Hard regression lock against the exact strings the user asked
    // us to remove. If a future refactor re-introduces them, this
    // fails immediately.
    expect(BADGE_SOURCE).not.toMatch(/"Export allowed"/);
    expect(BADGE_SOURCE).not.toMatch(/"Package allowed"/);
    expect(BADGE_SOURCE).not.toMatch(/"Exports allowed"/);
    expect(BADGE_SOURCE).not.toMatch(/"Package generation allowed"/);
    expect(BADGE_SOURCE).not.toMatch(/"Compliance export allowed"/);
  });

  it("returns null on loading + eligible (no positive-state UI)", () => {
    // Match: `if (state.loading || state.eligible) {\n    return null;`
    expect(BADGE_SOURCE).toMatch(
      /if\s*\(\s*state\.loading\s*\|\|\s*state\.eligible\s*\)\s*\{\s*\n\s*return\s+null\s*;/,
    );
  });

  it("keeps the fail-closed onEligibilityChange contract for blocked + unknown", () => {
    // The parent must still receive `eligible: false, disabled-effective`
    // on snapshot failure (UNKNOWN) and blocked outcomes. This is the
    // mechanism that disables the download buttons.
    expect(BADGE_SOURCE).toMatch(/onEligibilityChange\?\.\(\s*\{/);
    // The unknown branch must report unknown=true so parents disable.
    expect(BADGE_SOURCE).toMatch(/unknown:\s*true,/);
  });

  it("blocked panel carries a next-step line", () => {
    // The new warning panel must surface a next-step line. The
    // bounded copy is supplied by `nextStepForReason()`.
    expect(BADGE_SOURCE).toMatch(/data-eligibility-next-step/);
    expect(BADGE_SOURCE).toMatch(/function\s+nextStepForReason/);
  });

  it("next-step copy covers every canonical blocked reason", () => {
    // Parity with the canonical reason vocabulary emitted by the
    // governance snapshot (services/api/src/services/
    // governance-lifecycle/*). If a new outcome is added, this list
    // must be extended in lockstep.
    expect(BADGE_SOURCE).toMatch(/active_legal_hold/);
    expect(BADGE_SOURCE).toMatch(/BLOCKED_BY_HOLD/);
    expect(BADGE_SOURCE).toMatch(/BLOCKED_BY_LIFECYCLE/);
    expect(BADGE_SOURCE).toMatch(/BLOCKED_BY_REVIEW_GATE/);
    expect(BADGE_SOURCE).toMatch(/BLOCKED_BY_POLICY/);
    expect(BADGE_SOURCE).toMatch(/immutable_storage_drift_open/);
    expect(BADGE_SOURCE).toMatch(/governance_state_unavailable/);
  });

  it("Evidence Detail page still mounts the badge twice (export + package) — fail-closed disable wiring intact", () => {
    // Even though the component renders nothing when ALLOWED, the
    // page MUST still mount it so the `onEligibilityChange`
    // callback fires and `exportDisabled`/`packageDisabled` reach the
    // download buttons. This is the load-bearing wiring; removing
    // the badges entirely would re-enable downloads even on blocked
    // outcomes.
    const exportMounts = PAGE_SOURCE.match(
      /<ExportPackageEligibilityBadge[\s\S]*?kind=\{?"export"\}?/g,
    );
    const packageMounts = PAGE_SOURCE.match(
      /<ExportPackageEligibilityBadge[\s\S]*?kind=\{?"package"\}?/g,
    );
    expect(exportMounts?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(packageMounts?.length ?? 0).toBeGreaterThanOrEqual(1);
    // And both must wire onEligibilityChange.
    expect(PAGE_SOURCE).toMatch(/setExportDisabled/);
    expect(PAGE_SOURCE).toMatch(/setPackageDisabled/);
  });
});

describe("Evidence Detail page — Discussion tab gate uses capability flags, not labels", () => {
  it("page.tsx no longer reads `workspaceType === \"PERSONAL\"` to gate the Discussion tab", () => {
    // The brittle label-based gate must be gone. (The label may still
    // appear elsewhere on the page for non-Discussion display
    // purposes — we only assert it is NOT the gating predicate.)
    expect(PAGE_SOURCE).not.toMatch(
      /isPersonalWorkspace[\s\S]*?DETAIL_TABS\.filter[\s\S]*?discussion[\s\S]*?isPersonalWorkspace/,
    );
  });

  it("page.tsx gates Discussion tab on discussionEnabled || discussionReadOnly", () => {
    // The capability-based filter must be present.
    expect(PAGE_SOURCE).toMatch(/workspaceCaps\?\.discussionEnabled\s*===\s*true/);
    expect(PAGE_SOURCE).toMatch(/workspaceCaps\?\.discussionReadOnly\s*===\s*true/);
    expect(PAGE_SOURCE).toMatch(
      /DETAIL_TABS\.filter\([\s\S]*?discussion[\s\S]*?!canSeeDiscussion/,
    );
  });

  it("page.tsx passes readOnly to EvidenceDiscussionPanel when discussionReadOnly is true", () => {
    expect(PAGE_SOURCE).toMatch(
      /readOnly=\{workspaceCaps\?\.discussionReadOnly\s*===\s*true\}/,
    );
  });
});
