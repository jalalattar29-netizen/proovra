/**
 * Phase 28-G — UI operational wiring source-contract tests.
 *
 * Proves the four new apps/web components consume the right
 * endpoints, fail closed on API failure, never expose forbidden
 * fields, and use bounded safe wording.
 *
 * Also asserts the proof-point wiring (reviewer-ops escalations page
 * now imports + renders the empty-state preset + runtime banner).
 *
 * Pure source-contract assertions. No DOM, no React renderer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// GovernanceSnapshotPanel
// =============================================================================

describe("GovernanceSnapshotPanel", () => {
  const src = readSource(
    "../../../apps/web/components/operational/GovernanceSnapshotPanel.tsx",
  );

  it("consumes the snapshot endpoint", () => {
    expect(src).toMatch(
      /\/v1\/evidence\/\$\{[^}]+\}\/governance-snapshot\?teamId=/,
    );
  });

  it("fails closed on API error (renders GovernanceSnapshotUnavailableNotice)", () => {
    expect(src).toContain("GovernanceSnapshotUnavailableNotice");
    expect(src).toMatch(/error \|\| !snapshot/);
  });

  it("never invents 'allowed' state when snapshot is unknown", () => {
    // `eligibilityBadge(null)` must return "Unknown — treat as blocked".
    expect(src).toContain("Unknown — treat as blocked");
  });

  it("uses bounded safe wording for storage governance (no tamper / forged / altered)", () => {
    // Scope to STRING LITERALS only — comments may legitimately
    // reference the banned wording while documenting the rule.
    const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
    const all = stringLiterals.join(" ");
    expect(all).not.toMatch(/\btamper(ed|ing)?\b/i);
    expect(all).not.toMatch(/\bforged\b|\bforgery\b/i);
    expect(all).not.toMatch(/\baltered content\b/i);
  });

  it("never selects forbidden fields from the snapshot", () => {
    // The snapshot endpoint never returns these. We additionally
    // assert the component doesn't reference them by accident.
    for (const forbidden of [
      "internalNotes",
      "privateReviewerNote",
      "decisionNote",
      "signatureBase64",
      "publicKeyPem",
      "otsProofBase64",
      "storageKey",
    ]) {
      expect(src).not.toContain(forbidden);
    }
  });

  it("displays operator-readable warning labels from the snapshot, not codes alone", () => {
    expect(src).toContain("snapshot.warnings");
    expect(src).toMatch(/w\.label/);
  });
});

// =============================================================================
// OperationalTimelinePanel
// =============================================================================

describe("OperationalTimelinePanel", () => {
  const src = readSource(
    "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
  );

  it("consumes the operational-timeline endpoint", () => {
    expect(src).toMatch(
      /\/v1\/evidence\/\$\{[^}]+\}\/operational-timeline\?teamId=/,
    );
  });

  it("fails closed when timeline API fails", () => {
    expect(src).toMatch(
      /data-timeline-state="unavailable"/,
    );
    expect(src).toMatch(/failing closed/i);
  });

  it("uses the bounded empty-state preset when there are 0 entries", () => {
    expect(src).toContain("NoOperationalTimelineEmptyState");
  });

  it("does not render note bodies / private review content", () => {
    // No field that hints at private content is referenced.
    expect(src).not.toContain("privateReviewerNote");
    expect(src).not.toContain("decisionNote");
    expect(src).not.toMatch(/\bnote\.body\b/);
  });

  it("never invents events — every row from a real backend stream", () => {
    // The endpoint payload type defines `entries` from lifecycle /
    // review / incident. Phase 28-J groups entries by UTC date bucket,
    // so the iteration walks `timeline.entries` once to build buckets
    // and then `bucket.entries.map(...)` to render rows. Either pattern
    // proves the component does not fabricate events.
    expect(src).toMatch(/for\s*\(\s*const\s+entry\s+of\s+timeline\.entries/);
    expect(src).toContain("bucket.entries.map");
    expect(src).not.toMatch(/synthetic|fake|invented/i);
  });
});

// =============================================================================
// RuntimeStatusBanner
// =============================================================================

describe("RuntimeStatusBanner", () => {
  const src = readSource(
    "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
  );
  /**
   * The same source with comments removed.
   *
   * The docblock records what this component USED to read and why that was the
   * defect (ADM-P1-003). A guard matching raw source would fail on its own
   * explanation, and the fix for that failure would be deleting the
   * explanation — so the assertions below that forbid a string run against the
   * CODE, and the assertions that require one run against either.
   */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const STORE = readSource("../../../apps/web/lib/useServiceStatus.ts");
  const HEADER = readSource(
    "../../../apps/web/components/operational/ServiceStatusIndicator.tsx",
  );

  it("consumes the TENANT-SAFE projection (through the one shared store), not the platform aggregator", () => {
    /*
     * ADM-P1-003 / OWN-1 still holds: nothing here can reach
     * `/admin/runtime/*`. Since 2026-09-26 the read is the app-wide
     * `useServiceStatus` store, shared by every consumer on the page.
     */
    expect(STORE).toContain("/v1/runtime/status");
    expect(code).toContain("useServiceStatus()");
    for (const c of [code, STORE.replace(/\/\*[\s\S]*?\*\//g, "")]) {
      expect(c, "the platform aggregator must not be reachable from a tenant surface").not.toMatch(/\/admin\/runtime\//);
    }
  });

  it("HEALTHY — and anything not confirmed impaired — renders nothing beside an action", () => {
    expect(code).toMatch(/if \(notices\.length === 0\) return null;/);
  });

  it("API failure is never silently HEALTHY — the header says 'Status unavailable'", () => {
    // Beside an action a failed read says nothing (an unverified warning next
    // to a working button is a false alarm); the header indicator is where
    // "could not measure" is said, once.
    expect(HEADER).toContain("summarizeTenantServiceStatus(error ? null : status)");
  });

  it("renders no platform detail a tenant must not see", () => {
    expect(code).not.toMatch(/reasonCode/);
    expect(code).not.toMatch(/remediationHint/);
    expect(code).not.toMatch(/affectedDomain/);
    expect(code).not.toMatch(/failingSubsystems/);
    expect(code).not.toMatch(/RuntimeDegradedNotice/);
    expect(code).not.toMatch(/href=/);
  });

  it("never exposes env values or secret content", () => {
    expect(src).not.toContain("process.env");
    expect(src).not.toMatch(/SECRET|TOKEN|API_KEY/);
  });

  it("polls on a bounded interval (60s), once for every consumer", () => {
    expect(STORE).toMatch(/SERVICE_STATUS_POLL_MS = 60_000/);
    expect(STORE).toMatch(/if \(timer\) return;/);
  });
});

// =============================================================================
// ExportPackageEligibilityBadge
// =============================================================================

describe("ExportPackageEligibilityBadge", () => {
  const src = readSource(
    "../../../apps/web/components/operational/ExportPackageEligibilityBadge.tsx",
  );

  it("consumes the snapshot endpoint", () => {
    expect(src).toMatch(/\/v1\/evidence\/\$\{[^}]+\}\/governance-snapshot/);
  });

  it("snapshot failure → UNKNOWN, callback eligible=false (fail-closed)", () => {
    expect(src).toMatch(
      /unknown:\s*true[\s\S]*?eligible:\s*false/,
    );
    // Phase EVIDENCE-DETAIL-CLEANUP — the badge no longer emits the
    // "Unknown — blocked" pill literal; the fail-closed signal is
    // now carried by the alert panel title and the
    // data-eligibility-state="unknown" attribute. The behavior the
    // older assertion was protecting (operator is told the action
    // is blocked) is preserved by these checks.
    expect(src).toMatch(/data-eligibility-state=\{[^}]*?"unknown"/);
    expect(src).toMatch(/eligibility unavailable/i);
  });

  it("loading state disables the action", () => {
    expect(src).toMatch(/loading:\s*true/);
    expect(src).toContain('data-eligibility-state=');
  });

  it("supports both export and package kinds", () => {
    expect(src).toMatch(/kind\s*===\s*"export"/);
    expect(src).toContain('"package"');
  });

  it("exposes a callback so parent disables the underlying button", () => {
    expect(src).toContain("onEligibilityChange");
    expect(src).toMatch(/onEligibilityChange\?\.\(\{/);
  });

  it("never claims the action is ready when state is unknown or loading", () => {
    // Phase EVIDENCE-DETAIL-CLEANUP — the "Export allowed" /
    // "Package allowed" / "Unknown — blocked" pill literals were
    // removed. The component now renders NOTHING for the eligible
    // and loading branches (no positive-state noise), and a single
    // warning panel for blocked and unknown. The behavior this test
    // was protecting — "never imply readiness when state is not
    // eligible" — is now enforced more strictly: the component
    // returns null for eligible/loading and returns a clearly-tagged
    // alert panel for blocked/unknown.
    expect(src).not.toMatch(/"Export allowed"/);
    expect(src).not.toMatch(/"Package allowed"/);
    expect(src).not.toMatch(/"Unknown — blocked"/);
    // The new explicit short-circuit for non-blocked states.
    expect(src).toMatch(
      /if\s*\(\s*state\.loading\s*\|\|\s*state\.eligible\s*\)\s*\{\s*\n\s*return\s+null\s*;/,
    );
    // The unknown / blocked panel is tagged role="alert".
    expect(src).toMatch(/role="alert"/);
  });
});

// =============================================================================
// Barrel
// =============================================================================

describe("operational/index barrel", () => {
  const src = readSource(
    "../../../apps/web/components/operational/index.ts",
  );

  it("re-exports the four new panels", () => {
    expect(src).toContain("GovernanceSnapshotPanel");
    expect(src).toContain("OperationalTimelinePanel");
    expect(src).toContain("RuntimeStatusBanner");
    expect(src).toContain("ExportPackageEligibilityBadge");
  });

  it("re-exports every empty-state preset + variant", () => {
    expect(src).toContain("NoEscalationsEmptyState");
    expect(src).toContain("NoWorkloadSnapshotsEmptyState");
    expect(src).toContain("NoGovernanceIncidentsEmptyState");
    expect(src).toContain("NoSlaBreachesEmptyState");
    expect(src).toContain("NoOperationalTimelineEmptyState");
    expect(src).toContain("GovernanceSnapshotUnavailableNotice");
    // The header's service status and the contextual notice; the operator
    // diagnostic panel is gone (2026-09-26).
    expect(src).toContain("ServiceStatusIndicator");
    expect(src).toContain("RuntimeStatusBanner");
    expect(src).not.toContain("RuntimeDegradedNotice");
  });

  it("file-level comment documents the fail-closed contract", () => {
    expect(src).toMatch(/fail-closed/i);
    expect(src).toMatch(/UNKNOWN \/ DEGRADED state/i);
  });
});

// =============================================================================
// Proof-point wiring — reviewer-ops escalations page
// =============================================================================

describe("Escalations page (proof-point wiring)", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/reviewer-ops/escalations/page.tsx",
  );

  it("imports the new empty-state preset + runtime banner from the operational barrel", () => {
    expect(src).toMatch(
      /import \{[\s\S]*?NoEscalationsEmptyState,[\s\S]*?RuntimeStatusBanner,[\s\S]*?\} from "[./]+components\/operational"/,
    );
  });

  it("renders NoEscalationsEmptyState when rows array is empty", () => {
    // P7 — the page now renders through the shared <DataTable>, which shows
    // its `emptyState` slot when there are no rows. The empty preset is wired
    // into that slot (functionally equivalent to the old rows.length===0 gate).
    expect(src).toMatch(/emptyState=\{[\s\S]*?NoEscalationsEmptyState/);
  });

  it("removed the old static 'No escalations match these filters' text", () => {
    expect(src).not.toContain("No escalations match these filters.");
  });

  it("renders the runtime banner above the main escalations table", () => {
    // P7 — the raw <section> table wrapper was replaced by the shared
    // <DataTable>. The banner still renders above the table (the DataTable).
    // ADM-P1-003 — the banner no longer takes `teamId`. The tenant-safe
    // projection answers the same for every caller, so a workspace id would be
    // a parameter with nothing to parameterise. The page still gates the
    // banner on being IN a workspace, which is a placement decision, not a
    // scope one — see the next test.
    const bannerIdx = src.indexOf("<RuntimeStatusBanner");
    const tableIdx = src.indexOf("<DataTable");
    expect(bannerIdx).toBeGreaterThan(0);
    expect(tableIdx).toBeGreaterThan(0);
    expect(bannerIdx).toBeLessThan(tableIdx);
  });

  it("says review automation — the one capability this page's figures depend on", () => {
    // This asserted `teamId ? <RuntimeStatusBanner`, and after ADM-P1-003 it
    // was satisfied only by a COMMENT quoting the old code. The notice is
    // caller-independent (no workspace to wait for) and scoped by capability.
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).toContain('<RuntimeStatusBanner requires={["reviewAutomation"]} />');
  });
});

// =============================================================================
// Wording invariants across the operational component family
// =============================================================================

describe("Phase 28-G [wording invariants]", () => {
  const files = [
    "../../../apps/web/components/operational/GovernanceSnapshotPanel.tsx",
    "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
    "../../../apps/web/components/operational/RuntimeStatusBanner.tsx",
    "../../../apps/web/components/operational/ExportPackageEligibilityBadge.tsx",
    "../../../apps/web/components/operational/OperationalEmptyState.tsx",
  ];

  it("no file contains tamper / forged / altered-content in its visible string literals", () => {
    for (const file of files) {
      const src = readSource(file);
      const stringLiterals = src.match(/"[^"\n]+"/g) ?? [];
      const all = stringLiterals.join(" ");
      expect(all, `wording check failed in ${file}`).not.toMatch(
        /\btamper(ed|ing)?\b|\bforged\b|\baltered content\b/i,
      );
    }
  });

  it("no file references env values directly in rendered text", () => {
    for (const file of files) {
      const src = readSource(file);
      // We allow process.env in client code only for non-secret
      // public env (NEXT_PUBLIC_*). We forbid it entirely in these
      // components since they should not surface env state.
      expect(src, `env reference in ${file}`).not.toContain("process.env");
    }
  });

  it("no fake counter / hardcoded operational number renders anywhere", () => {
    for (const file of files) {
      const src = readSource(file);
      // Hardcoded "count" / numeric badges would smell of fake data.
      // We don't ban all numerics (style values are fine); we ban
      // literal hardcoded count-shaped patterns.
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/overdue:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
    }
  });
});
