/**
 * Phase 28-J — Enterprise operations maturity source-contract tests.
 *
 * Asserts:
 *   - useGlobalRuntimeState polls the three real endpoints and derives
 *     severity with the documented precedence.
 *   - GlobalRuntimeIndicator renders the five severity states, opens a
 *     dropdown on click, fails closed to UNKNOWN, and exposes the four
 *     quick-link footer entries.
 *   - AppAccountToolbar mounts the indicator between LanguageSwitcher and
 *     the account menu.
 *   - Sidebar IA reorganised into Primary / Operations / Governance /
 *     Admin and consumes real runtime state for badges.
 *   - Observability page surfaces worker heartbeat + queue health
 *     summary tiles, an operational heat card, and live trend
 *     sparklines (with deltas).
 *   - Sparkline component renders inline SVG, never invents data.
 *   - OperationalTimelinePanel groups by date, marks governance + life-
 *     cycle events with severity-dominant treatment, exposes
 *     `data-event-type` for testing.
 *   - No fake counters, no hidden text, WCAG-readable contrast on
 *     degraded/critical surfaces.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// =============================================================================
// useGlobalRuntimeState
// =============================================================================

describe("useGlobalRuntimeState (Phase 28-J)", () => {
  const src = readSource(
    "../../../apps/web/lib/useGlobalRuntimeState.ts",
  );

  it("polls the three runtime-awareness endpoints", () => {
    expect(src).toMatch(/\/admin\/runtime\/readiness\?teamId=/);
    expect(src).toMatch(/\/v1\/ops\/incidents\?teamId=[^&]+&status=OPEN/);
    expect(src).toMatch(
      /\/v1\/reviewer-ops\/escalations\?teamId=[^&]+&status=OPEN/,
    );
  });

  it("exports the five severity states", () => {
    for (const s of [
      '"HEALTHY"',
      '"DEGRADED"',
      '"INCIDENT_ACTIVE"',
      '"CRITICAL"',
      '"UNKNOWN"',
    ]) {
      expect(src).toContain(s);
    }
  });

  it("derives severity with the documented precedence (CRITICAL > INCIDENT_ACTIVE > DEGRADED > UNKNOWN > HEALTHY)", () => {
    // The derivation must check `anyCritical` first, then incidents
    // (INCIDENT_ACTIVE), then readiness DEGRADED, then errored/UNKNOWN,
    // then HEALTHY. Anchor the ordering on the actual `return` lines so
    // we ignore type-annotation occurrences of the strings.
    const fn = src.slice(
      src.indexOf("function deriveSeverity"),
      src.indexOf("function deriveSeverity") + 900,
    );
    const idxCritical = fn.indexOf('return "CRITICAL"');
    const idxIncidentActive = fn.indexOf('return "INCIDENT_ACTIVE"');
    const idxDegraded = fn.indexOf('return "DEGRADED"');
    const idxUnknown = fn.indexOf('return "UNKNOWN"');
    const idxHealthy = fn.indexOf('return "HEALTHY"');
    expect(idxCritical).toBeGreaterThan(0);
    expect(idxIncidentActive).toBeGreaterThan(idxCritical);
    expect(idxDegraded).toBeGreaterThan(idxIncidentActive);
    expect(idxUnknown).toBeGreaterThan(idxDegraded);
    expect(idxHealthy).toBeGreaterThan(idxUnknown);
  });

  it("never collapses unknown into HEALTHY (fail-closed)", () => {
    // `anySourceErrored` floors the rollup at UNKNOWN.
    expect(src).toMatch(/anySourceErrored[\s\S]{0,200}return\s*"UNKNOWN"/);
  });

  it("clamps polling cadence to [15s, 5 min]", () => {
    expect(src).toMatch(/POLL_MS_MIN\s*=\s*15_000/);
    expect(src).toMatch(/POLL_MS_MAX\s*=\s*5 \* 60_000/);
  });

  it("counts dedicated to the topbar/sidebar are derived from real arrays (no fake numbers)", () => {
    expect(src).toMatch(/incidentsCritical/);
    expect(src).toMatch(/incidentsHigh/);
    expect(src).toMatch(/degradedSubsystems/);
    // No magic numbers (excluding poll-bound constants).
    expect(src).not.toMatch(/escalations:\s*\d+,/);
    expect(src).not.toMatch(/incidents:\s*\d+,/);
  });
});

// =============================================================================
// GlobalRuntimeIndicator (pill + dropdown)
// =============================================================================

describe("GlobalRuntimeIndicator (Phase 28-J)", () => {
  const src = readSource(
    "../../../apps/web/components/operational/GlobalRuntimeIndicator.tsx",
  );

  it("renders a button with aria-haspopup=dialog", () => {
    expect(src).toMatch(/aria-haspopup="dialog"/);
    expect(src).toMatch(/aria-expanded=\{open\}/);
  });

  it("data-severity attribute reflects every severity state", () => {
    expect(src).toMatch(/data-severity=\{state\.severity\}/);
  });

  it("CRITICAL severity pulses (visually dominates)", () => {
    expect(src).toMatch(/global-runtime-pulse/);
    expect(src).toMatch(/CRITICAL:\s*\{[\s\S]*?pulse:\s*true/);
  });

  it("HEALTHY pill is muted (no pulse) — non-shouting in calm state", () => {
    expect(src).toMatch(/HEALTHY:\s*\{[\s\S]*?pulse:\s*false/);
  });

  it("dropdown closes on outside click and Escape (keyboard accessible)", () => {
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toMatch(/window\.addEventListener\("mousedown"/);
  });

  it("dropdown rows surface degraded subsystems, active incidents, and escalations from the hook", () => {
    expect(src).toContain('title="Degraded subsystems"');
    expect(src).toContain('title="Active incidents"');
    expect(src).toContain('title="Reviewer escalations"');
  });

  it("dropdown footer exposes the four quick links to canonical operator pages", () => {
    expect(src).toMatch(/href="\/operations"/);
    expect(src).toMatch(/href="\/operations\/observability"/);
    expect(src).toMatch(/href="\/reviewer-ops\/escalations"/);
    expect(src).toMatch(/href="\/operations\/runbooks"/);
  });

  it("on any source failure the dropdown labels rows as unavailable, never silently empty", () => {
    expect(src).toMatch(/Readiness unavailable — treat as unknown/);
    expect(src).toMatch(/Incident endpoint unavailable — treat as unknown/);
    expect(src).toMatch(/Escalation endpoint unavailable — treat as unknown/);
  });

  it("uses the shared light-surface tokens (no rgba(255,255,255,...) on light pages)", () => {
    expect(src).toMatch(/from\s*"\.\/tokens"/);
    // No leftover dark-shell tokens hardcoded in the component.
    expect(src).not.toMatch(/rgba\(255,255,255/);
  });
});

// =============================================================================
// Topbar wiring
// =============================================================================

// Product-reset: AppTopbarV2 (dead duplicate topbar) deleted; contract
// retargeted to the live AppAccountToolbar.
describe("AppAccountToolbar — runtime indicator wiring", () => {
  const src = readSource(
    "../../../apps/web/components/app-shell-v2/AppAccountToolbar.tsx",
  );

  it("imports GlobalRuntimeIndicator from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*GlobalRuntimeIndicator[^}]*\}\s*from\s*"\.\.\/operational"/,
    );
  });

  it("resolves teamId via the canonical platform context", () => {
    // The live toolbar reads teamId from the canonical envelope:
    // `envelope.activeSpace.id` when the active space is an
    // ORGANIZATION; null otherwise. The legacy useActiveWorkspaceId
    // fallback is not used.
    expect(src).toMatch(/usePlatformContext/);
    expect(src).toMatch(/envelope[\s\S]{0,200}activeSpace\.id/);
  });

  it("renders the indicator inside the topbar actions, before the language switcher", () => {
    const indicatorIdx = src.indexOf("<GlobalRuntimeIndicator");
    const langIdx = src.indexOf("<LanguageSwitcher");
    expect(indicatorIdx).toBeGreaterThan(0);
    expect(langIdx).toBeGreaterThan(0);
    expect(indicatorIdx).toBeLessThan(langIdx);
  });

  it("indicator slot carries a stable test attribute", () => {
    expect(src).toMatch(/data-app-topbar-runtime/);
  });
});

// =============================================================================
// Sidebar IA + badges
// =============================================================================

describe("AppSidebarV2 — IA + operational badges", () => {
  // Phase 38.6 — the canonical navigation source of truth is the route
  // registry (`lib/navigation/routeRegistry.ts`); the legacy
  // `lib/navigation-config.ts` (NavGroup/domain shape) was deleted. The
  // renderer is in AppSidebarV2.tsx. Label invariants routeRegistry
  // still expresses are re-pointed below; assertions about the deleted
  // file's NavGroup titles / group-specific label vocabulary were
  // removed with it.
  const src = readSource(
    "../../../apps/web/components/app-shell-v2/AppSidebarV2.tsx",
  );
  const navConfig = readSource(
    "../../../apps/web/lib/navigation/routeRegistry.ts",
  );

  // OBSOLETE — Phase 38.6 removed navigation-config, which was the only
  // source that modeled sidebar GROUP titles ("Workspace" / "Review &
  // Governance" / "Platform Health" / "Administration"). The canonical
  // routeRegistry is a flat list of route records with no NavGroup
  // headings, so the group-order + group-membership label assertions
  // below no longer have a source to read. Group ordering is now a
  // rendering concern in AppSidebarV2 + the disclosure resolver, covered
  // by their own tests.
  it.skip("declares the five canonical groups in the documented order (removed with navigation-config)", () => {});

  it("canonical workspace routes include Home, Capture, Evidence, Cases, Reports, Search", () => {
    // Dashboard is consolidated under /home — the canonical label is
    // "Home", not "Dashboard". These labels are expressed verbatim in
    // the route registry.
    expect(navConfig).toMatch(/label: "Home"/);
    expect(navConfig).toMatch(/label: "Capture"/);
    expect(navConfig).toMatch(/label: "Evidence"/);
    expect(navConfig).toMatch(/label: "Cases"/);
    expect(navConfig).toMatch(/label: "Reports"/);
    expect(navConfig).toMatch(/label: "Search"/);
  });

  // OBSOLETE — Phase 38.6. The Review & Governance / Platform Health
  // group label vocabulary ("Reviewer Ops", "SLA", "Policy",
  // "Security Center", "Destruction", …) was navigation-config's
  // per-group NavItem labelling. The routeRegistry re-labels several of
  // these surfaces ("SLA tracking", "Governance policy", "Identity &
  // Security", "Destruction reviews"), so the literal-label assertions
  // no longer hold and were removed with the deleted file.
  it.skip("Review & Governance group lists Reviewer Ops, SLA, ... (removed with navigation-config)", () => {});
  it.skip("Platform Health group lists Operations Center, ... (removed with navigation-config)", () => {});

  it("canonical administration routes include Workspaces, Billing, Integrations", () => {
    // Phase B0.5 renamed the operational nav label from "Teams" to
    // "Workspaces"; the DB-level Team model name is unchanged. These
    // three labels are expressed verbatim in the route registry.
    // (Intake links / account settings / platform admin use different
    // canonical casing in routeRegistry and are covered by the registry's
    // own contract tests.)
    expect(navConfig).toMatch(/label: "Workspaces"/);
    expect(navConfig).toMatch(/label: "Billing"/);
    expect(navConfig).toMatch(/label: "Integrations"/);
  });

  it("consumes the real useGlobalRuntimeState hook (real runtime data, not fake)", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?useGlobalRuntimeState[\s\S]*?\}\s*from\s*"\.\.\/\.\.\/lib\/useGlobalRuntimeState"/,
    );
    expect(src).toMatch(/runtime\.counts\.escalations/);
  });

  it("escalation badge tone scales with severity (CRITICAL > HIGH > WARNING)", () => {
    // Phase 32.8B — code was re-formatted across lines after the
    // data-driven refactor; the assertion allows whitespace between
    // `some(` and its arrow function.
    expect(src).toMatch(
      /escalations\.some\(\s*\(e\)\s*=>\s*e\.severity === "CRITICAL"[\s\S]*?\)[\s\S]*?"critical"[\s\S]*?"high"[\s\S]*?"warning"/,
    );
  });

  it("operations center + observability links carry a runtime dot when severity != HEALTHY", () => {
    expect(src).toMatch(/ariaLabel:\s*`Runtime \$\{runtime\.severity\.toLowerCase\(\)\}`/);
    expect(src).toMatch(/kind:\s*"dot"/);
  });

  it("never emits a badge when the count is zero (no decorative chips)", () => {
    expect(src).toMatch(
      /runtime\.counts\.escalations > 0/,
    );
    expect(src).toMatch(/governanceIncidents > 0/);
  });
});

// =============================================================================
// Sparkline
// =============================================================================

describe("Sparkline (Phase 28-J)", () => {
  const src = readSource(
    "../../../apps/web/components/operational/Sparkline.tsx",
  );

  it("renders inline SVG only (no external chart library)", () => {
    expect(src).toMatch(/<svg/);
    expect(src).not.toMatch(/from\s+"chart\.js|recharts|d3"/);
  });

  it("requires ≥ 2 samples to render a trend (otherwise renders a 'collecting' hint)", () => {
    expect(src).toMatch(/safeValues\.length >= 2/);
    expect(src).toMatch(/collecting samples…/);
  });

  it("renders a real delta indicator when provided (never invents one)", () => {
    expect(src).toMatch(/data-sparkline-delta/);
    // Delta must come from the caller via the typed prop.
    expect(src).toMatch(/delta\?:\s*number \| null/);
  });

  it("severity prop drives the stroke color (no fixed orange/red ink leak)", () => {
    expect(src).toMatch(/STROKE_FOR:\s*Record<SparklineSeverity, string>/);
  });

  it("exposes data-sample-count for testing", () => {
    expect(src).toMatch(/data-sample-count=\{safeValues\.length\}/);
  });
});

// =============================================================================
// Observability page — maturity layout
// =============================================================================

describe("Observability page — Phase 28-J maturity", () => {
  const src = readSource(
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
  );

  it("imports Sparkline from the operational barrel", () => {
    expect(src).toMatch(
      /import\s*\{[\s\S]*?Sparkline[\s\S]*?\}\s*from\s*"[\.\/]+components\/operational"/,
    );
  });

  it("summary row exposes Worker heartbeat + Queue health tiles", () => {
    expect(src).toMatch(/label="Worker heartbeat"/);
    expect(src).toMatch(/label="Queue health"/);
  });

  it("worker + queue tiles read from real readiness subsystem entries", () => {
    expect(src).toMatch(/workersSubsystem/);
    expect(src).toMatch(/queuesSubsystem/);
    expect(src).toMatch(
      /readiness\?\.subsystems\.find\(\(s\) => s\.id === "workers"\)/,
    );
    expect(src).toMatch(
      /readiness\?\.subsystems\.find\(\(s\) => s\.id === "queues"\)/,
    );
  });

  it("renders the operational heat card with real gauge-derived hotspots", () => {
    expect(src).toMatch(/data-observability-heat/);
    expect(src).toMatch(/Hottest queue/);
    expect(src).toMatch(/Highest SLA pressure/);
    expect(src).toMatch(/Active escalation pressure/);
    expect(src).toMatch(/Highest retry source/);
  });

  it("operational heat values come from the gauge snapshot, not fabricated", () => {
    expect(src).toMatch(/Object\.entries\(metrics\.gauges\)/);
    expect(src).toMatch(/operationalHeat/);
  });

  it("renders the live trend sparkline grid built from polled samples", () => {
    expect(src).toMatch(/data-observability-sparklines/);
    expect(src).toMatch(/HOT_METRICS/);
    expect(src).toMatch(/SAMPLE_CAP/);
    // Sparkline grid is rendered.
    expect(src).toMatch(/<Sparkline\b/);
  });

  it("sparkline delta is computed from the rolling buffer, not a magic constant", () => {
    expect(src).toMatch(
      /const\s+delta\s*=\s*buffer\.length\s*>=\s*2\s*\?\s*last\s*-\s*first\s*:\s*null/,
    );
  });

  it("never fabricates operational counters (no fake escalations / incidents constants)", () => {
    expect(src).not.toMatch(/escalations:\s*\d+,/);
    expect(src).not.toMatch(/incidents:\s*\d+,/);
    expect(src).not.toMatch(/overdue:\s*\d+,/);
  });
});

// =============================================================================
// OperationalTimelinePanel — lifecycle grouping + governance visibility
// =============================================================================

describe("OperationalTimelinePanel — Phase 28-J richness", () => {
  const src = readSource(
    "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
  );

  it("groups entries by UTC date bucket", () => {
    expect(src).toMatch(/dateBucket\s*\(/);
    expect(src).toMatch(/data-timeline-bucket=\{bucket\.key\}/);
    expect(src).toMatch(/Today|Yesterday/);
  });

  it("recognises governance events by canonical event-type prefix (LEGAL_HOLD_, RETENTION_, IMMUTABLE_, EXPORT_BLOCKED, PACKAGE_BLOCKED, GOVERNANCE_, LIFECYCLE_, DESTRUCTION_, CASE_LEGAL_HOLD_)", () => {
    for (const prefix of [
      '"LEGAL_HOLD_"',
      '"RETENTION_"',
      '"IMMUTABLE_"',
      '"EXPORT_BLOCKED"',
      '"PACKAGE_BLOCKED"',
      '"GOVERNANCE_"',
      '"LIFECYCLE_"',
      '"DESTRUCTION_"',
      '"CASE_LEGAL_HOLD_"',
    ]) {
      expect(src, `missing governance prefix ${prefix}`).toContain(prefix);
    }
  });

  it("marks governance + lifecycle rows with a visible chip tag", () => {
    expect(src).toMatch(/data-tag="governance"/);
    expect(src).toMatch(/data-tag="lifecycle"/);
  });

  it("CRITICAL severity rows visually dominate (critical bg + critical ink)", () => {
    expect(src).toMatch(/entry\.severity === "CRITICAL"[\s\S]*?OPS_TONES\.critical\.bg/);
    expect(src).toMatch(/OPS_TONES\.critical\.ink/);
  });

  it("each timeline row exposes data-event-type + data-severity for downstream tests", () => {
    expect(src).toMatch(/data-event-type=\{entry\.eventType\}/);
    expect(src).toMatch(/data-severity=\{entry\.severity\}/);
  });

  it("never renders private review notes or decision-note bodies", () => {
    expect(src).not.toContain("privateReviewerNote");
    expect(src).not.toContain("decisionNote");
    expect(src).not.toMatch(/\bnote\.body\b/);
  });
});

// =============================================================================
// Cross-surface contrast + safety invariants
// =============================================================================

describe("Phase 28-J cross-surface invariants", () => {
  const FILES = [
    "../../../apps/web/components/operational/GlobalRuntimeIndicator.tsx",
    "../../../apps/web/components/operational/Sparkline.tsx",
    "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
    "../../../apps/web/app/(app)/operations/observability/page.tsx",
  ];

  it("no operational surface uses banned wording in string literals", () => {
    const BANNED =
      /\btamper(ed|ing)?\b|\bforged\b|\bforgery\b|\baltered content\b|\bmanipulated evidence\b/i;
    for (const rel of FILES) {
      const src = readSource(rel);
      const literals = src.match(/"[^"\n]+"/g) ?? [];
      expect(
        literals.join(" "),
        `banned wording leaked into ${rel}`,
      ).not.toMatch(BANNED);
    }
  });

  it("no operational surface fabricates hardcoded counters", () => {
    for (const rel of FILES) {
      const src = readSource(rel);
      expect(src).not.toMatch(/escalations:\s*\d+,/);
      expect(src).not.toMatch(/incidents:\s*\d+,/);
      expect(src).not.toMatch(/overdue:\s*\d+,/);
    }
  });

  it("no operational surface uses dark-shell rgba(255,255,255,...) text on a light page", () => {
    // Whitelist: AppSidebarV2 + sidebar badge palette intentionally
    // uses rgba(255,255,255,...) on top of the dark velvet sidebar
    // shell — that's the correct contrast there. Topbar + observability
    // are LIGHT surfaces and must NOT use those tokens.
    const LIGHT_SURFACES = [
      "../../../apps/web/components/operational/GlobalRuntimeIndicator.tsx",
      "../../../apps/web/components/operational/Sparkline.tsx",
      "../../../apps/web/components/operational/OperationalTimelinePanel.tsx",
      "../../../apps/web/app/(app)/operations/observability/page.tsx",
    ];
    for (const rel of LIGHT_SURFACES) {
      const src = readSource(rel);
      expect(
        src,
        `${rel} mixes dark-shell tokens with a light surface`,
      ).not.toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/);
    }
  });
});
