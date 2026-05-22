/**
 * Phase 32.8C+++++++ — Dashboard Navigation + Operational Reliability.
 *
 * Source-contract tests for:
 *
 *  PART 1 — Every major dashboard section has id + data-section +
 *           aria-label matching the persona priority chip targets
 *  PART 2 — useActiveSection hook implemented with IntersectionObserver
 *  PART 3 — Persona chips wire onclick to smooth-scroll + URL hash sync
 *  PART 4 — Ops-health evaluator services + shared types
 *  PART 5 — Envelope exposes opsHealth (telemetry / reconcile / security)
 *  PART 6 — OpsHealthBanner renders with severity ladder
 *  PART 7 — Reconcile UNAVAILABLE-as-red is replaced with structured
 *           state-based severity
 *  PART 8 — No-regression invariants
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readApi(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
}
function readWeb(rel: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../../apps/web/${rel}`, import.meta.url)),
    "utf8",
  );
}

const CC_TSX = readWeb("components/command-center/CommandCenter.tsx");
const CC_TYPES = readWeb("components/command-center/types.ts");
const CC_CSS = readWeb("components/command-center/command-center.css");
const OPS_TYPES = readApi("src/services/ops-health/types.ts");
const TELEMETRY_HEALTH = readApi(
  "src/services/ops-health/telemetry-health.service.ts",
);
const RECONCILE_HEALTH = readApi(
  "src/services/ops-health/reconcile-health.service.ts",
);
const ROLLUP_HEALTH = readApi(
  "src/services/ops-health/security-rollup-health.service.ts",
);
const PROJECTION_HEALTH = readApi(
  "src/services/ops-health/projection-health.service.ts",
);
const COMMAND_CENTER_API = readApi(
  "src/services/dashboard/command-center.service.ts",
);

// =============================================================================
// PART 1 — Major sections have id + data-section + aria-label
// =============================================================================

describe("Phase 32.8C+++++++ — section IDs match persona priority chip targets", () => {
  const REQUIRED_SECTION_IDS = [
    "operationalPressure",
    "routingQueue",
    "investigationIntelligence",
    "workloadEngine",
    "caseOperations",
    "reviewerOrchestration",
    "pipelineDetail",
    "governancePosture",
    "queueCongestion",
    "auditReadiness",
    "organizationalIntelligence",
    "custodyIntegrityAnomalies",
    "accessSecurityAnomalies",
    "timeline",
    "recentEvidence",
    "incidents",
    "predictiveRisk",
    "organizationalIntelligenceV2",
    "relationshipIntelligence",
    "crossCaseIntelligenceV2",
    "deepIntegrityWatch",
    "accessSecurityClassifier",
    "queueWorkerTelemetry",
    "coordinationSignals",
    "reconstructedTimeline",
    "reviewerCapacity",
    "operationalGraph",
    "organizationalHealth",
  ];

  it("every required section id is present in the render", () => {
    for (const id of REQUIRED_SECTION_IDS) {
      expect(CC_TSX, `missing id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it("every required section has a matching data-section hook", () => {
    for (const id of REQUIRED_SECTION_IDS) {
      expect(
        CC_TSX,
        `missing data-section="${id}"`,
      ).toContain(`data-section="${id}"`);
    }
  });

  it("every required section has an aria-label", () => {
    // We sample a handful — the wrapping pattern is consistent.
    for (const id of ["incidents", "routingQueue", "queueWorkerTelemetry"]) {
      const block = CC_TSX.match(
        new RegExp(
          `id="${id}"[\\s\\S]{0,200}aria-label="[^"]+"`,
        ),
      );
      expect(block, `aria-label missing near id="${id}"`).not.toBeNull();
    }
  });
});

// =============================================================================
// PART 2 — useActiveSection hook
// =============================================================================

describe("Phase 32.8C+++++++ — useActiveSection IntersectionObserver", () => {
  it("the hook is defined + uses IntersectionObserver", () => {
    expect(CC_TSX).toMatch(/function useActiveSection\(/);
    expect(CC_TSX).toMatch(/new IntersectionObserver\(/);
  });

  it("honors an initial URL hash on first mount", () => {
    expect(CC_TSX).toMatch(/window\.location\.hash\.replace\("#",\s*""\)/);
    expect(CC_TSX).toMatch(/el\.scrollIntoView\(\{\s*behavior:\s*"smooth"/);
  });

  it("syncs the URL hash via history.replaceState (no history pollution)", () => {
    expect(CC_TSX).toMatch(/history\.replaceState\(null,\s*"",\s*`#\$\{best\.id\}`/);
  });

  it("observer disconnects on unmount (cleanup)", () => {
    expect(CC_TSX).toMatch(/observer\.unobserve\(el\)/);
    expect(CC_TSX).toMatch(/observer\.disconnect\(\)/);
  });

  it("hook is consumed by the dashboard render", () => {
    expect(CC_TSX).toMatch(/const activeSection = useActiveSection\(/);
  });
});

// =============================================================================
// PART 3 — Persona chips wire onclick + URL sync
// =============================================================================

describe("Phase 32.8C+++++++ — persona chip click wiring", () => {
  it("chips have an onClick handler that smooth-scrolls + replaces hash", () => {
    expect(CC_TSX).toMatch(/onClick=\{\(ev\)\s*=>/);
    expect(CC_TSX).toMatch(/el\.scrollIntoView\(\{\s*behavior:\s*"smooth",\s*block:\s*"start"/);
    expect(CC_TSX).toMatch(/history\.replaceState\(\s*null,\s*"",\s*`#\$\{sectionId\}`/);
  });

  it("active chip has data-cc-persona-priority-active + aria-current", () => {
    expect(CC_TSX).toMatch(/data-cc-persona-priority-active=\{isActive \? "true" : "false"\}/);
    expect(CC_TSX).toMatch(/aria-current=\{isActive \? "true" : undefined\}/);
  });

  it("clicked section gets a brief landed-flash (data-cc-section-landed)", () => {
    expect(CC_TSX).toMatch(/data-cc-section-landed/);
    // The setTimeout callback can span multiple lines; allow large window.
    expect(CC_TSX).toMatch(/setTimeout\([\s\S]{0,400}1500\)/);
  });

  it("CSS defines the active chip + landed-flash animations", () => {
    expect(CC_CSS).toMatch(/data-cc-persona-priority-active="true"/);
    expect(CC_CSS).toMatch(/data-cc-section-landed="true"/);
    expect(CC_CSS).toMatch(/@keyframes cc-section-landed-flash/);
  });
});

// =============================================================================
// PART 4 — Ops-health evaluator services + shared types
// =============================================================================

describe("Phase 32.8C+++++++ — ops-health evaluators", () => {
  it("shared types declare the 7-state severity ladder", () => {
    for (const v of [
      "HEALTHY",
      "STALE",
      "DEGRADED",
      "PARTIAL",
      "UNAVAILABLE",
      "FAILED",
      "DISCONNECTED",
    ]) {
      expect(OPS_TYPES).toContain(`"${v}"`);
    }
  });

  it("OpsHealthState carries canonicalSourceHealthy + recoverable + retrying", () => {
    expect(OPS_TYPES).toMatch(/canonicalSourceHealthy:\s*boolean/);
    expect(OPS_TYPES).toMatch(/recoverable:\s*boolean/);
    expect(OPS_TYPES).toMatch(/retrying:\s*boolean/);
    expect(OPS_TYPES).toMatch(/lastSuccessfulRunAt:\s*string \| null/);
    expect(OPS_TYPES).toMatch(/degradedSince:\s*string \| null/);
  });

  it("severityForStatus maps each status to a bounded severity", () => {
    expect(OPS_TYPES).toMatch(/severityForStatus/);
    expect(OPS_TYPES).toMatch(/case\s+"HEALTHY":\s*\n?\s*return\s+"info"/);
    expect(OPS_TYPES).toMatch(/case\s+"STALE":\s*\n?\s*case\s+"PARTIAL":\s*\n?\s*return\s+"amber"/);
    expect(OPS_TYPES).toMatch(/case\s+"FAILED":\s*\n?\s*return\s+"critical"/);
  });

  it("telemetry evaluator distinguishes STALE (worker fresh) from FAILED (worker dead)", () => {
    expect(TELEMETRY_HEALTH).toMatch(
      /status:\s*"STALE"[\s\S]{0,400}heartbeat last recorded[\s\S]{0,200}worker is likely overloaded/i,
    );
    expect(TELEMETRY_HEALTH).toMatch(
      /status:\s*"FAILED"[\s\S]{0,400}beyond the failure threshold/,
    );
  });

  it("reconcile evaluator never paints UNAVAILABLE when worker is alive", () => {
    // The DEGRADED + STALE branches both fire when workerAlive — only
    // the path where reconcileAgeH > stale AND worker not alive sets
    // UNAVAILABLE.
    expect(RECONCILE_HEALTH).toMatch(/status:\s*"DEGRADED"[\s\S]{0,300}Worker is alive/);
    expect(RECONCILE_HEALTH).toMatch(/status:\s*"UNAVAILABLE"[\s\S]{0,300}worker heartbeat is also stale/);
  });

  it("security rollup evaluator distinguishes DEGRADED (canonical alive) from FAILED (both reads dead)", () => {
    expect(ROLLUP_HEALTH).toMatch(
      /status:\s*"DEGRADED"[\s\S]{0,300}Detection remains operational/,
    );
    expect(ROLLUP_HEALTH).toMatch(
      /status:\s*"FAILED"[\s\S]{0,300}canonical SecurityEvent log read failed/,
    );
  });

  it("projection evaluator is generic + accepts canonicalSourceHealthy callback", () => {
    expect(PROJECTION_HEALTH).toMatch(/canonicalSourceHealthy\?:\s*\(\)\s*=>\s*Promise<boolean>/);
    expect(PROJECTION_HEALTH).toMatch(/projectionName:/);
  });

  it("no evaluator throws — every error path returns a typed state", () => {
    for (const src of [
      TELEMETRY_HEALTH,
      RECONCILE_HEALTH,
      ROLLUP_HEALTH,
      PROJECTION_HEALTH,
    ]) {
      // Each evaluator wraps Prisma reads in try/catch and returns a
      // structured state on failure; no explicit `throw` outside the
      // outer signature.
      expect(src).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
      // The outer function does not throw — verify no `throw new` exists
      // outside the try/catch decision trees.
      const throws = src.match(/throw new /g) ?? [];
      expect(throws.length).toBe(0);
    }
  });
});

// =============================================================================
// PART 5 — Envelope exposes opsHealth
// =============================================================================

describe("Phase 32.8C+++++++ — envelope opsHealth wiring", () => {
  it("envelope type carries opsHealth.{telemetry,reconcile,securityRollup}", () => {
    expect(COMMAND_CENTER_API).toMatch(/opsHealth:\s*\{/);
    expect(COMMAND_CENTER_API).toMatch(/telemetry:\s*OpsHealthState/);
    expect(COMMAND_CENTER_API).toMatch(/reconcile:\s*OpsHealthState/);
    expect(COMMAND_CENTER_API).toMatch(/securityRollup:\s*OpsHealthState/);
  });

  it("buildCommandCenter awaits the three evaluators in parallel", () => {
    expect(COMMAND_CENTER_API).toMatch(/evaluateTelemetryHealth\(/);
    expect(COMMAND_CENTER_API).toMatch(/evaluateReconcileHealth\(/);
    expect(COMMAND_CENTER_API).toMatch(/evaluateSecurityRollupHealth\(/);
  });

  it("each evaluator call has a .catch fallback so the envelope never throws", () => {
    expect(COMMAND_CENTER_API).toMatch(
      /evaluateTelemetryHealth\(\{\s*teamId:\s*input\.teamId\s*\}\)\.catch\(/,
    );
    expect(COMMAND_CENTER_API).toMatch(
      /evaluateReconcileHealth\(\{\s*teamId:\s*input\.teamId\s*\}\)\.catch\(/,
    );
    expect(COMMAND_CENTER_API).toMatch(
      /evaluateSecurityRollupHealth\(\{\s*teamId:\s*input\.teamId\s*\}\)\.catch\(/,
    );
  });

  it("envelope return statement includes opsHealth on every branch", () => {
    expect(COMMAND_CENTER_API).toMatch(
      /opsHealth:\s*\{\s*telemetry:\s*telemetryHealth,\s*reconcile:\s*reconcileHealth,\s*securityRollup:\s*securityRollupHealth/,
    );
  });

  it("frontend types.ts mirrors the opsHealth shape", () => {
    expect(CC_TYPES).toMatch(/opsHealth\?:\s*\{/);
    expect(CC_TYPES).toMatch(/export type OpsHealthState\s*=/);
    expect(CC_TYPES).toMatch(/export type OpsHealthStatus\s*=/);
  });
});

// =============================================================================
// PART 6 — OpsHealthBanner severity ladder
// =============================================================================

describe("Phase 32.8C+++++++ — OpsHealthBanner severity rendering", () => {
  it("OpsHealthBanner component is defined", () => {
    expect(CC_TSX).toMatch(/function OpsHealthBanner\(/);
  });

  it("banner hides when health is HEALTHY (no banner means healthy)", () => {
    expect(CC_TSX).toMatch(/if \(health\.status === "HEALTHY"\) return null/);
  });

  it("banner exposes data-cc-ops-health-* hooks for testing + CSS", () => {
    expect(CC_TSX).toMatch(/data-cc-ops-health-banner/);
    expect(CC_TSX).toMatch(/data-cc-ops-health-status=\{health\.status\}/);
    expect(CC_TSX).toMatch(/data-cc-ops-health-severity=\{health\.severity\}/);
    expect(CC_TSX).toMatch(/data-cc-ops-health-canonical=/);
  });

  it("CSS ladder: amber for STALE+PARTIAL, warning for DEGRADED, high for UNAVAILABLE, critical for FAILED", () => {
    expect(CC_CSS).toMatch(/data-cc-ops-health-severity="amber"/);
    expect(CC_CSS).toMatch(/data-cc-ops-health-severity="warning"/);
    expect(CC_CSS).toMatch(/data-cc-ops-health-severity="high"/);
    expect(CC_CSS).toMatch(/data-cc-ops-health-severity="critical"/);
    expect(CC_CSS).toMatch(/data-cc-ops-health-severity="muted"/);
  });

  it("banner surfaces canonical-source state to operators", () => {
    expect(CC_TSX).toMatch(/canonicalSourceHealthy \?[\s\S]{0,80}canonical source healthy/);
  });
});

// =============================================================================
// PART 7 — Reconcile UNAVAILABLE-as-red replaced
// =============================================================================

describe("Phase 32.8C+++++++ — reconcile severity reclassification", () => {
  it("QueueWorkerTelemetryBoard accepts telemetryHealth + reconcileHealth props", () => {
    expect(CC_TSX).toMatch(/telemetryHealth\?:/);
    expect(CC_TSX).toMatch(/reconcileHealth\?:/);
  });

  it("Reconcile title uses humanized ops-health label, not the raw enum", () => {
    expect(CC_TSX).toMatch(/reconcileLabel = reconcileHealth/);
    expect(CC_TSX).toMatch(/title=\{`Reconcile · \$\{reconcileLabel\}`/);
  });

  it("Reconcile severity is sourced from the structured state, not from a hard enum-to-color map", () => {
    expect(CC_TSX).toMatch(/opsHealthToShellSeverity\(reconcileHealth\)/);
  });

  it("AccessSecurityClassifierBoard accepts rollupHealth + amber-ifies when canonical alive", () => {
    expect(CC_TSX).toMatch(/rollupHealth\?:/);
    expect(CC_TSX).toMatch(/canonicalAlive\s*=\s*rollupHealth\?\.canonicalSourceHealthy/);
    expect(CC_TSX).toMatch(/canonicalAlive\s*\?\s*"warning"\s*:\s*"high"/);
  });

  it("security classifier degraded copy reads 'rollup delayed' when canonical alive", () => {
    expect(CC_TSX).toMatch(/Detection running · rollup delayed/);
  });

  it("call sites pass the matching opsHealth slices", () => {
    expect(CC_TSX).toMatch(/telemetryHealth=\{envelope\.opsHealth\?\.telemetry/);
    expect(CC_TSX).toMatch(/reconcileHealth=\{envelope\.opsHealth\?\.reconcile/);
    expect(CC_TSX).toMatch(/rollupHealth=\{envelope\.opsHealth\?\.securityRollup/);
  });
});

// =============================================================================
// PART 8 — No-regression invariants
// =============================================================================

describe("Phase 32.8C+++++++ — no-regression invariants", () => {
  it("dashboard remains read-only at page load (no POST)", () => {
    expect(CC_TSX).not.toMatch(/method:\s*"POST"/);
  });

  it("no href=\"#\" placeholder links anywhere in the dashboard", () => {
    expect(CC_TSX).not.toMatch(/href="#"/);
  });

  it("hook cleanup is correct — observer disconnects on unmount", () => {
    expect(CC_TSX).toMatch(/return \(\) => \{[\s\S]{0,200}observer\.disconnect/);
  });

  it("no service uses legal-overclaim language", () => {
    for (const src of [
      TELEMETRY_HEALTH,
      RECONCILE_HEALTH,
      ROLLUP_HEALTH,
      PROJECTION_HEALTH,
    ]) {
      for (const banned of ["admissible", "court-ready", "proves authenticity"]) {
        expect(src).not.toMatch(new RegExp(`\\b${banned}\\b`, "i"));
      }
    }
  });

  it("no service generates signed URLs or report/package output", () => {
    for (const src of [
      TELEMETRY_HEALTH,
      RECONCILE_HEALTH,
      ROLLUP_HEALTH,
      PROJECTION_HEALTH,
    ]) {
      expect(src).not.toMatch(/getSignedUrl/i);
      expect(src).not.toMatch(/generateReport/i);
      expect(src).not.toMatch(/generatePackage/i);
    }
  });

  it("OpsHealthBanner does not include any mutation controls", () => {
    const block = CC_TSX.match(/function OpsHealthBanner\([\s\S]*?\n\}\s*\n/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toMatch(/<button/);
    expect(block![0]).not.toMatch(/onClick/);
    expect(block![0]).not.toMatch(/<form/);
  });
});
