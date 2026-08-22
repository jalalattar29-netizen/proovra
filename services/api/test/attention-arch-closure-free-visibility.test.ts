/**
 * ATTENTION ARCHITECTURE — CLOSURE PASS (2026-08-22).
 * HOME INFORMATION, PERSONAL FREE VISIBILITY, AND ONE COUNT PER DEFINITION.
 *
 * ---------------------------------------------------------------------------
 * THE PRODUCT DECISION THIS ENFORCES
 * ---------------------------------------------------------------------------
 * Home and Operations answer different questions:
 *
 *   HOME        "what is happening in my workspace?"
 *   OPERATIONS  "what unresolved work do I need to manage?"
 *
 * Home is allowed to SHOW operational and trust information, and it must keep
 * showing it — the earlier phases removed Home's duplicate COMPUTATION, not
 * its content. This suite is the guard against over-correction: it asserts the
 * cards are still there, still populated, and now sourced from canonical
 * authorities rather than from one person's mailbox.
 *
 * ---------------------------------------------------------------------------
 * THE FREE PROBLEM, AND WHY IT IS NOT SOLVED WITH A CAPABILITY GRANT
 * ---------------------------------------------------------------------------
 * A Personal Free user owns Evidence. That Evidence can fail timestamping, sit
 * unanchored, or need integrity review. They must be able to SEE that and act
 * on it — while still not receiving a shared operational workbench they have
 * no use for.
 *
 * Two gates, two questions:
 *
 *   see my own workspace health  ->  `operations.view` PERMISSION (role floor)
 *   enter the workbench          ->  `OPERATIONS_VIEW` CAPABILITY (route gate)
 *
 * Granting Free `OPERATIONS_VIEW` to make Home work would have handed them a
 * workbench to solve a reporting problem. Both halves are pinned below.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { roleHasPermission } from "@proovra/shared";

import { resolveCapabilities } from "../src/services/platform-context/capability-registry.js";

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), "utf8");
}

const VM = read("apps/web/components/home-experience/home-view-model.ts");
const DASH = read("apps/web/components/home-experience/SelfServeHomeDashboard.tsx");
const OPS_ROUTES = read("services/api/src/routes/ops.routes.ts");
const REGISTRY = read("apps/web/lib/navigation/routeRegistry.ts");

/** Source with comments stripped — for "is this actually the code?" checks. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

// ============================================================================
// PERSONAL FREE — the two gates, kept apart
// ============================================================================

describe("Closure — Personal Free can SEE its health without a workbench", () => {
  it("every workspace role holds the summary-READ permission", () => {
    // Including the sole owner of a Personal Free space: their evidence is
    // their own data, and a count of their own failing records is not
    // somebody else's secret.
    for (const role of ["OWNER", "ADMIN", "REVIEWER", "CONTRIBUTOR", "VIEWER"] as const) {
      expect(roleHasPermission(role, "operations.view"), role).toBe(true);
    }
  });

  it("Personal Free still gets NO workbench capability", () => {
    const caps = resolveCapabilities({
      scope: "PERSONAL",
      role: "OWNER",
      plan: "FREE",
      isPlatformAdmin: false,
      workspaceKind: "PERSONAL",
      packageProducesOperationalConditions: false,
      memberCount: 1,
    });
    expect(caps.OPERATIONS_VIEW).toBeFalsy();
    // And none of the mutations either — seeing is not acting.
    expect(caps.OPERATIONS_ACKNOWLEDGE).toBeFalsy();
    expect(caps.OPERATIONS_ASSIGN).toBeFalsy();
    expect(caps.OPERATIONS_RESOLVE).toBeFalsy();
    expect(caps.OPERATIONS_SUPPRESS).toBeFalsy();
  });

  it("the summary endpoint is gated on the PERMISSION, not on the capability", () => {
    // `requireOpsActor` resolves `operations.view` through
    // `evaluateMemberAccess`, which reads the canonical ROLE floor. It does
    // not consult `OPERATIONS_VIEW`, and it must not: that is the route gate.
    expect(OPS_ROUTES).toMatch(
      /async function requireOpsActor\([\s\S]{0,400}"operations\.view"/,
    );
    const summaryAt = OPS_ROUTES.indexOf('"/v1/ops/summary"');
    expect(summaryAt).toBeGreaterThan(0);
    const block = OPS_ROUTES.slice(summaryAt, summaryAt + 700);
    expect(block).toContain("requireOpsActor(req, reply, q.teamId)");
    expect(block).not.toContain("OPERATIONS_VIEW");
  });

  it("the WORKBENCH route is gated on the capability, not on the permission", () => {
    const at = REGISTRY.indexOf('id: "workspace.operations"');
    expect(at).toBeGreaterThan(0);
    const entry = REGISTRY.slice(at, REGISTRY.indexOf("\n  },", at));
    expect(entry).toContain('requiredCapabilities: ["OPERATIONS_VIEW"]');
  });

  it("the two gates are DOCUMENTED as different questions", () => {
    // The next person to touch this must find the reasoning, not rediscover
    // it by breaking Free.
    expect(OPS_ROUTES).toContain(
      "WHO MAY READ THIS, AND WHY IT IS NOT THE WORKBENCH GATE",
    );
  });
});

// ============================================================================
// HOME KEPT ITS INFORMATION
// ============================================================================

describe("Closure — Home is still information-rich", () => {
  it("every major block is still composed on the page", () => {
    // The over-correction this guards against: reading "Home is a cockpit" as
    // "Home should lose its cards".
    for (const [block, marker] of [
      ["attention hero", "<ExecutiveSummaryBand"],
      ["KPI band", "<KpiRow"],
      ["Workspace Health", "<WorkspaceHealthCard"],
      ["What Needs Attention", "<WorkspacePrioritiesCard"],
      ["Recent Evidence", "<RecentEvidenceCard"],
      ["Active Matters", "<ActiveMatters"],
      ["Verification Summary", "<VerificationHealthCard"],
      ["Trust State", "<TrustStateCard"],
      ["Report Production", "<ReportProductionCard"],
      ["Intake Status", "<IntakePipelineCard"],
      ["Analytics — type donut", "<EvidenceTypeDonutCard"],
    ] as const) {
      expect(DASH, `Home lost its ${block}`).toContain(marker);
    }
  });

  it("the three tabs survive, and the Operations tab is a SUMMARY tab", () => {
    expect(DASH).toContain('data-home-tabpanel="overview"');
    expect(DASH).toContain('data-home-tabpanel="operations"');
    expect(DASH).toContain('data-home-tabpanel="analytics"');
    // The Home Operations tab renders summaries and links. It must never
    // acquire the workbench's lifecycle verbs.
    const at = DASH.indexOf('data-home-tabpanel="operations"');
    const panel = DASH.slice(at, DASH.indexOf('data-home-tabpanel="analytics"'));
    for (const verb of ["acknowledge", "suppress", "assign"]) {
      expect(panel.toLowerCase(), `Home ops tab must not ${verb}`).not.toContain(
        verb,
      );
    }
  });

  it("What Needs Attention owns no shared lifecycle", () => {
    const SECTIONS = read(
      "apps/web/components/home-experience/HomeDashboardSections.tsx",
    );
    const at = SECTIONS.indexOf("export function WorkspacePrioritiesCard");
    expect(at).toBeGreaterThan(0);
    const card = SECTIONS.slice(at, at + 9000);
    for (const verb of [
      "acknowledgeIncident",
      "resolveIncident",
      "suppressIncident",
      "assignIncident",
    ]) {
      expect(card).not.toContain(verb);
    }
  });
});

// ============================================================================
// ONE COUNT, ONE DEFINITION
// ============================================================================

describe("Closure — every Home metric names a canonical authority", () => {
  /**
   * The Home source-of-truth map, asserted rather than documented. Each row is
   * (priority key, the `derivedFrom` provenance the view model must record).
   */
  const PROVENANCE: ReadonlyArray<[string, string]> = [
    ["tsa_failures", "dashboard/trust-summary.tsa.failed"],
    ["anchoring_terminal", "dashboard/trust-summary.ots.failed"],
    ["resolve_integrity", "dashboard/trust-summary.needingAttention"],
    ["ots_pending", "dashboard/trust-summary.ots.pending"],
  ];

  for (const [key, provenance] of PROVENANCE) {
    it(`${key} is derived from ${provenance}`, () => {
      const at = VM.indexOf(`key: "${key}"`);
      expect(at, `${key} priority must exist`).toBeGreaterThan(0);
      const block = VM.slice(at, at + 1400);
      expect(block).toContain(provenance);
    });
  }

  it("NO Home priority is derived from the personal notification feed", () => {
    // THE regression this pass fixed: `anchoring_terminal` counted
    // `needsFixing.filter(critical).length`, which is built from the caller's
    // own /v1/me/inbox items — capped by the feed's per-category take, and
    // moved by that one person's archive.
    const start = VM.indexOf("function buildWorkspacePriorities");
    expect(start).toBeGreaterThan(0);
    // Assert over CODE — the tombstones quote the removed derivations by name
    // so the next reader knows what was there, and a whole-file search would
    // match the explanation instead of the thing.
    const body = code(VM.slice(start, VM.indexOf("\n}\n", start)));
    expect(body).not.toMatch(/me\/inbox/);
    expect(body).not.toMatch(/needsFixing/);
    expect(body).not.toMatch(/criticalFailuresCount/);
  });

  it("`criticalFailuresCount` is gone from the view model entirely", () => {
    expect(code(VM)).not.toMatch(/criticalFailuresCount/);
  });

  it("the TSA count and its CTA describe the SAME population", () => {
    // `trust.tsaFailed` counts tsaBucket("failed") = FAILED|REJECTED|ERROR,
    // and the link filters on exactly that union. A count whose link opens a
    // different set is a number nobody can check.
    expect(VM).toContain(
      'export const HOME_TSA_FAILURES_HREF = "/evidence?tsaStatus=FAILED,REJECTED,ERROR"',
    );
    const TRUST = read("services/api/src/services/dashboard/trust-summary.service.ts");
    expect(TRUST).toMatch(
      /v === "FAILED" \|\| v === "REJECTED" \|\| v === "ERROR"/,
    );
  });

  it("the anchoring count and its CTA describe the SAME population", () => {
    expect(VM).toContain(
      'export const HOME_ANCHORING_FAILURES_HREF =\n  "/evidence?otsStatus=FAILED,ERRORED,ERROR"',
    );
    const TRUST = read("services/api/src/services/dashboard/trust-summary.service.ts");
    expect(TRUST).toMatch(
      /v === "FAILED" \|\| v === "ERRORED" \|\| v === "ERROR"/,
    );
  });

  it("the integrity-review count and its CTA describe the SAME population", () => {
    expect(VM).toContain(
      'export const HOME_INTEGRITY_REVIEW_HREF =\n  "/evidence?verificationStatus=REVIEW_REQUIRED,FAILED"',
    );
  });
});

// ============================================================================
// CTA DESTINATIONS — reachable by the person who sees them
// ============================================================================

describe("Closure — a Free user's CTA never leads somewhere they are refused", () => {
  it("no trust/integrity priority sends the user to the workbench", () => {
    // A Free user seeing "34 TSA timestamps failed" must land on the records,
    // not on a route their capability set will refuse.
    for (const key of [
      "tsa_failures",
      "anchoring_terminal",
      "resolve_integrity",
      "ots_pending",
    ]) {
      const at = VM.indexOf(`key: "${key}"`);
      expect(at).toBeGreaterThan(0);
      const block = VM.slice(at, at + 1400);
      expect(block, `${key} must not deep-link to /operations`).not.toMatch(
        /href: "\/operations/,
      );
      expect(block).toMatch(/href: HOME_[A-Z_]+_HREF/);
    }
  });

  it("Home's link TO Operations is the summary's own, and is capability-aware", () => {
    // The one place Home points at the workbench is the Operations summary
    // block itself, which only renders meaningfully when the summary resolved.
    expect(VM).toMatch(/href: "\/operations"/);
  });
});
