/**
 * Phase C0 — Reviewer Console contract suite.
 *
 * Source-contract style (same as A0 / A1 / A2 / A3 / B0). Six
 * contracts:
 *
 *   1. The `/v1/reviewer-ops/console` aggregator is registered and
 *      composes five bounded sections (queue / mine / escalations /
 *      sla / workload) + saved views.
 *
 *   2. Each section runs in parallel + has its own try/catch so a
 *      single sub-query failure degrades only its section.
 *
 *   3. The aggregator enforces a tight per-section cap (≤ 25 rows).
 *
 *   4. `requireReviewerActor` is anti-enumeration (404 on non-member).
 *
 *   5. The legacy `/v1/review-operations/evidence/:evidenceId/decision`
 *      endpoint enforces step-up when the workspace governance flag
 *      `requireStepUpForApprove` / `requireStepUpForReject` is set.
 *
 *   6. The frontend Reviewer Console wires keyboard navigation
 *      (j / k / Enter / / / Cmd+K) and renders the five tabs.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function readSource(rel: string): string {
  const url = new URL(rel, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf8");
}

const CONSOLE_ROUTES = readSource("../src/routes/reviewer-console.routes.ts");
const SERVER_SRC = readSource("../src/server.ts");
const REVIEW_OPS_ROUTES = readSource(
  "../src/routes/review-operations.routes.ts",
);
const CONSOLE_UI = readSource(
  "../../../apps/web/components/reviewer-experience/ReviewerConsole.tsx",
);
const REVIEW_PAGE = readSource(
  "../../../apps/web/app/(app)/review/page.tsx",
);

describe("Phase C0 — reviewer console aggregator (source contract)", () => {
  it("registers GET /v1/reviewer-ops/console", () => {
    expect(CONSOLE_ROUTES).toMatch(
      /app\.get\(\s*"\/v1\/reviewer-ops\/console"/,
    );
  });

  it("composes the five sections + saved views in parallel via Promise.all", () => {
    expect(CONSOLE_ROUTES).toContain("Promise.all([");
    // Six parallel sub-queries: queue, mine, escalations, dashboard
    // (SLA rollup source), workload, savedViews.
    const composeMatch = CONSOLE_ROUTES.match(
      /Promise\.all\(\[\s*([\s\S]*?)\s*\]\)/,
    );
    expect(composeMatch).toBeTruthy();
    const sectionCalls = (composeMatch![1].match(/safeSection\(/g) ?? [])
      .length;
    expect(sectionCalls).toBeGreaterThanOrEqual(6);
  });

  it("each section is wrapped in safeSection (try/catch) so a single failure degrades only its tab", () => {
    expect(CONSOLE_ROUTES).toContain('"degraded"');
    expect(CONSOLE_ROUTES).toContain('reviewer_console.section_failed');
    // safeSection must catch THROWS — not return; the source has a
    // `try { ... } catch` block.
    expect(CONSOLE_ROUTES).toMatch(/try\s*\{[\s\S]*?await fn\(\)[\s\S]*?\}\s*catch/);
  });

  it("per-section cap is ≤ 25 rows", () => {
    expect(CONSOLE_ROUTES).toMatch(/SECTION_LIMIT\s*=\s*25/);
  });

  it("uses anti-enumeration 404 for non-members", () => {
    expect(CONSOLE_ROUTES).toMatch(
      /reply\.code\(404\)\.send\(\{\s*error:\s*\{\s*code:\s*"not_found"/,
    );
  });

  it("returns the bounded section-status diagnostic for the frontend", () => {
    expect(CONSOLE_ROUTES).toContain("diagnostics");
    expect(CONSOLE_ROUTES).toContain("sectionStatus");
    expect(CONSOLE_ROUTES).toContain("sectionLimit");
  });

  it("server.ts registers the console route alongside reviewer-ops", () => {
    expect(SERVER_SRC).toContain("reviewerConsoleRoutes");
    const consoleIdx = SERVER_SRC.indexOf("app.register(reviewerConsoleRoutes)");
    const opsIdx = SERVER_SRC.indexOf("app.register(reviewerOpsRoutes)");
    expect(consoleIdx).toBeGreaterThan(0);
    expect(opsIdx).toBeGreaterThan(0);
  });

  it("aggregator is read-only — never writes evidence, custody, or audit", () => {
    expect(CONSOLE_ROUTES).not.toMatch(/\.evidence\.update\(/);
    expect(CONSOLE_ROUTES).not.toMatch(/\.evidence\.create\(/);
    expect(CONSOLE_ROUTES).not.toMatch(/appendCustodyEvent/);
    expect(CONSOLE_ROUTES).not.toMatch(/appendPlatformAuditLog/);
    expect(CONSOLE_ROUTES).not.toMatch(/writeAnalyticsEvent/);
  });
});

describe("Phase C0 — sensitive review decision step-up enforcement", () => {
  it("review-operations decision endpoint imports the step-up middleware", () => {
    expect(REVIEW_OPS_ROUTES).toContain("requireStepUpForSensitiveAction");
    expect(REVIEW_OPS_ROUTES).toContain("loadWorkspaceReviewerOpsFlags");
  });

  it("the decision handler gates APPROVE_INTERNAL on requireStepUpForApprove", () => {
    expect(REVIEW_OPS_ROUTES).toMatch(
      /body\.decision\s*===\s*"APPROVE_INTERNAL"/,
    );
    expect(REVIEW_OPS_ROUTES).toContain('"requireStepUpForApprove"');
    expect(REVIEW_OPS_ROUTES).toContain('"REVIEW_APPROVAL_HIGH_RISK"');
  });

  it("the decision handler gates REJECT_INSUFFICIENT on requireStepUpForReject", () => {
    expect(REVIEW_OPS_ROUTES).toMatch(
      /body\.decision\s*===\s*"REJECT_INSUFFICIENT"/,
    );
    expect(REVIEW_OPS_ROUTES).toContain('"requireStepUpForReject"');
    expect(REVIEW_OPS_ROUTES).toContain('"REVIEWER_OPS_REJECT"');
  });

  it("step-up flag-off is a true no-op (request proceeds, no 401)", () => {
    // The handler reads the flag and only invokes
    // `requireStepUpForSensitiveAction` when the flag is set. We
    // assert the conditional structure exists.
    expect(REVIEW_OPS_ROUTES).toMatch(/if \(flags\[flagKey\]\)/);
  });
});

describe("Phase C0 — reviewer console UI (source contract)", () => {
  it("React component declares five tabs (Queue / Mine / Escalations / SLA / Workload)", () => {
    expect(CONSOLE_UI).toMatch(/TABS:[\s\S]*?\{\s*id:\s*"queue"/);
    expect(CONSOLE_UI).toMatch(/id:\s*"mine"/);
    expect(CONSOLE_UI).toMatch(/id:\s*"escalations"/);
    expect(CONSOLE_UI).toMatch(/id:\s*"sla"/);
    expect(CONSOLE_UI).toMatch(/id:\s*"workload"/);
  });

  it("density modes are bounded to compact / comfortable / spacious", () => {
    // The DENSITY_VALUES constant is the bounded vocabulary the
    // component reads. We assert each value appears, and the
    // constant name + tuple literal is present (trailing comma
    // tolerated).
    expect(CONSOLE_UI).toMatch(/const DENSITY_VALUES\b/);
    expect(CONSOLE_UI).toMatch(/"compact"/);
    expect(CONSOLE_UI).toMatch(/"comfortable"/);
    expect(CONSOLE_UI).toMatch(/"spacious"/);
  });

  it("keyboard navigation handles j / k / Enter / / / Cmd+K", () => {
    // Each key has an explicit branch in `handleKeyDown`.
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"j"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"k"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"Enter"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"\/"/);
    expect(CONSOLE_UI).toMatch(
      /\(e\.metaKey \|\| e\.ctrlKey\)[\s\S]*?e\.key\.toLowerCase\(\)\s*===\s*"k"/,
    );
  });

  it("command palette opens on Cmd/Ctrl + K and closes on Escape", () => {
    expect(CONSOLE_UI).toContain("setPaletteOpen(true)");
    expect(CONSOLE_UI).toContain("setPaletteOpen(false)");
    expect(CONSOLE_UI).toContain("CommandPalette");
  });

  it("opens the focused row via the existing inspector", () => {
    // Console delegates row-open to `onOpenRow`. G3.2 adds inline
    // mutations but the inspector remains the canonical detail view.
    expect(CONSOLE_UI).toContain("onOpenRow");
  });

  it("Phase G3.2 — inline mutations route through the audited reviewer-ops endpoints only", () => {
    // The bounded mutation set: assign, request-info, escalate,
    // acknowledge, and saved-view create/delete. No other write
    // methods may appear in the console.
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/reviews/");
    expect(CONSOLE_UI).toContain("/assign");
    expect(CONSOLE_UI).toContain("/request-info");
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/escalations");
    expect(CONSOLE_UI).toContain("/acknowledge");
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/saved-views");

    // Approve / Reject MUST NOT live inline — they remain in the
    // inspector where the full risk + adaptive gate context renders.
    expect(CONSOLE_UI).not.toMatch(/\/reviews\/[^"]*\/approve/);
    expect(CONSOLE_UI).not.toMatch(/\/reviews\/[^"]*\/reject/);
  });

  it("Phase G3.2 — every inline mutation flows through useStepUpAction", () => {
    expect(CONSOLE_UI).toContain("useStepUpAction");
    expect(CONSOLE_UI).toContain("runStepUpAction");
    expect(CONSOLE_UI).toContain("StepUpModal");
  });

  it("Phase G3.2 — inline-action keyboard shortcuts wire a / e / m", () => {
    // `a` assign, `e` escalate, `m` request more info.
    expect(CONSOLE_UI).toMatch(/lower\s*===\s*"a"/);
    expect(CONSOLE_UI).toMatch(/lower\s*===\s*"e"/);
    expect(CONSOLE_UI).toMatch(/lower\s*===\s*"m"/);
  });

  it("Phase G3.2 — terminal rows do not expose inline mutation buttons", () => {
    // The TERMINAL_STATUSES set + isRowActionable() guard the rows.
    expect(CONSOLE_UI).toContain("TERMINAL_STATUSES");
    expect(CONSOLE_UI).toContain("isRowActionable");
  });

  it("Phase G3.2 — visible loading / error / flash states for every mutation", () => {
    expect(CONSOLE_UI).toContain("actionBusyKey");
    expect(CONSOLE_UI).toContain("actionError");
    expect(CONSOLE_UI).toContain("actionFlash");
  });

  it("Phase G3.2 — bounded pagination (Load more / View all) per tab", () => {
    expect(CONSOLE_UI).toContain("PaginationFooter");
    expect(CONSOLE_UI).toContain("TAB_LIMIT_CAPS");
    expect(CONSOLE_UI).toContain("data-reviewer-pagination-load-more");
    expect(CONSOLE_UI).toContain("data-reviewer-pagination-view-all");
    // Pagination must call the per-tab endpoints, not invent a new one.
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/queue?");
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/escalations?");
    expect(CONSOLE_UI).toContain("/v1/reviewer-ops/workload?");
  });

  it("Phase G3.2 — pagination caps respect the backend's bounded maxima", () => {
    // Queue endpoint allows ≤100; workload + escalations allow ≤200.
    expect(CONSOLE_UI).toMatch(/queue:\s*100/);
    expect(CONSOLE_UI).toMatch(/mine:\s*100/);
    expect(CONSOLE_UI).toMatch(/escalations:\s*200/);
    expect(CONSOLE_UI).toMatch(/workload:\s*200/);
  });

  it("consumes the /v1/reviewer-ops/console aggregator", () => {
    expect(CONSOLE_UI).toContain('/v1/reviewer-ops/console?teamId=');
  });

  it("renders an operator-safe no-workspace panel when teamId is null", () => {
    expect(CONSOLE_UI).toContain("Reviewer Console is workspace-scoped");
  });

  it("vocabulary discipline — no overclaiming phrases", () => {
    const banned = [
      /\btampered?\b/i,
      /\btamper-?proof\b/i,
      /\bauthentic\b/i,
      /\badmissible\b/i,
      /\bverified\s+report\b/i,
      /\bcourt-?ready\b/i,
      /\bforensic\s+proof\b/i,
    ];
    for (const re of banned) {
      expect(CONSOLE_UI).not.toMatch(re);
    }
  });
});

describe("Phase C0 — /review canonical page", () => {
  it("/review page exists and is wrapped in PageRouteGate", () => {
    expect(REVIEW_PAGE).toContain("PageRouteGate");
    expect(REVIEW_PAGE).toContain('routeId="review.queue"');
  });

  it("/review delegates row opens to the existing /reviewer-ops/[reviewId] inspector", () => {
    expect(REVIEW_PAGE).toContain('router.push(`/reviewer-ops/${candidate}`)');
  });

  it("/review reads density from the persona profile", () => {
    expect(REVIEW_PAGE).toContain("operationalDensityPreference");
  });

  it("/review resolves the workspace teamId from activeSpace (not legacy ctx.workspace alone)", () => {
    expect(REVIEW_PAGE).toContain('activeSpace?.type === "ORGANIZATION"');
    expect(REVIEW_PAGE).toContain('activeSpace?.type === "PERSONAL"');
  });
});
