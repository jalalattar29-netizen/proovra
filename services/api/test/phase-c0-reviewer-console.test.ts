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
const REVIEW_GATE = readSource("../src/services/reviewer-ops/review-action-gate.ts");
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
  it("the review-operations decision endpoint asks the one review gate", () => {
    expect(REVIEW_OPS_ROUTES).toContain("enforceReviewActionGate");
    expect(REVIEW_GATE).toContain("requireStepUpForSensitiveAction");
    expect(REVIEW_GATE).toContain("loadWorkspaceReviewerOpsFlags");
  });

  it("APPROVE_INTERNAL answers to requireStepUpForApprove", () => {
    expect(REVIEW_OPS_ROUTES).toMatch(/gateForVerdict\(body\.decision\)/);
    expect(REVIEW_GATE).toContain('"APPROVE_INTERNAL"');
    expect(REVIEW_GATE).toContain('"requireStepUpForApprove"');
    expect(REVIEW_GATE).toContain('"REVIEW_APPROVAL_HIGH_RISK"');
  });

  it("REJECT_INSUFFICIENT answers to requireStepUpForReject", () => {
    expect(REVIEW_GATE).toContain('"REJECT_INSUFFICIENT"');
    expect(REVIEW_GATE).toContain('"requireStepUpForReject"');
    expect(REVIEW_GATE).toContain('"REVIEWER_OPS_REJECT"');
  });

  it("step-up flag-off proceeds without a step-up unless adaptive auth asks for one", () => {
    // The gate reads the flag and only invokes
    // `requireStepUpForSensitiveAction` when the flag is set, or when the
    // runtime adaptive gate has decided this session must step up
    // (20ef15600): the adaptive decision is answered here, not ignored.
    expect(REVIEW_GATE).toMatch(/if \(!flags\[gate\.flag\] && !adaptive\.stepUpRequired\) return true/);
  });
});

describe("Phase C0 — reviewer console UI (source contract)", () => {
  // TEAM-SPEC §3 (2026-11-23) — five tabs became two. Escalations, SLA and
  // Workload duplicated the Monitoring pages (/reviewer-ops/escalations,
  // /reviewer-ops/sla), which the Review hub tabs lead to.
  it("React component declares the two review slices (Queue / Mine); Monitoring tabs removed", () => {
    expect(CONSOLE_UI).toMatch(/TABS:[\s\S]*?\{\s*id:\s*"queue"/);
    expect(CONSOLE_UI).toMatch(/id:\s*"mine"/);
    expect(CONSOLE_UI).not.toMatch(/id:\s*"escalations"/);
    expect(CONSOLE_UI).not.toMatch(/id:\s*"sla"/);
    expect(CONSOLE_UI).not.toMatch(/id:\s*"workload"/);
  });

  it("no operational-density mode system remains in the reviewer console", () => {
    // (2026-07-20) The compact / comfortable / spacious density modes
    // were removed with the workspace-persona / operational-density
    // feature. The "comfortable" spacing was folded into the base
    // styling; the console renders one canonical density for everyone.
    expect(CONSOLE_UI).not.toMatch(/const DENSITY_VALUES\b/);
    expect(CONSOLE_UI).not.toMatch(/operationalDensity/i);
    expect(CONSOLE_UI).not.toMatch(/data-density=/);
  });

  it("keyboard navigation handles j / k / Enter / /, and leaves chords to the app", () => {
    // Each key has an explicit branch in `handleKeyDown`.
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"j"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"k"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"Enter"/);
    expect(CONSOLE_UI).toMatch(/e\.key\s*===\s*"\/"/);
    // TEAM-SPEC §3 (D12) — Ctrl/Cmd+K is the app-wide "Jump to a page"
    // palette only; the console returns early on any chord.
    expect(CONSOLE_UI).toMatch(/if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey\) return;/);
  });

  // TEAM-SPEC §3 (2026-11-23) — INVERTED. The reviewer command palette bound
  // Ctrl/Cmd+K on window alongside the global palette and both opened at once.
  it("the reviewer command palette is removed (trigger, overlay, handler, CSS)", () => {
    expect(CONSOLE_UI).not.toContain("setPaletteOpen");
    expect(CONSOLE_UI).not.toContain("paletteOpen");
    expect(CONSOLE_UI).not.toMatch(/function CommandPalette\(/);
    expect(CONSOLE_UI).not.toContain("reviewer-console__palette");
    expect(CONSOLE_UI).not.toContain("data-reviewer-command-palette-open");
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
    // TEAM-SPEC §3 — acknowledging an escalation lives on the Escalations
    // page with the escalation tab gone from the console.
    expect(CONSOLE_UI).not.toContain("/acknowledge");
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
    // TEAM-SPEC §3 — the shared queueRow guard (TERMINAL_QUEUE_STATES over the
    // real lifecycleState) replaces the console's own set, which compared the
    // `status` field the API never sent.
    expect(CONSOLE_UI).toContain("isQueueRowActionable");
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
    // TEAM-SPEC §3 — only the queue slices remain on the console.
    expect(CONSOLE_UI).not.toContain("/v1/reviewer-ops/escalations?");
    expect(CONSOLE_UI).not.toContain("/v1/reviewer-ops/workload?");
  });

  it("Phase G3.2 — pagination caps respect the backend's bounded maxima", () => {
    // Queue endpoint allows ≤100; workload + escalations allow ≤200.
    expect(CONSOLE_UI).toMatch(/queue:\s*100/);
    expect(CONSOLE_UI).toMatch(/mine:\s*100/);
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

  it("/review does not read a persona-profile density preference", () => {
    // (2026-07-20) Operational density + the workspace-persona profile
    // were removed. The /review page no longer threads a density prop
    // into the reviewer console.
    expect(REVIEW_PAGE).not.toContain("operationalDensityPreference");
    expect(REVIEW_PAGE).not.toContain("personaProfile");
  });

  it("/review resolves the workspace teamId from activeSpace (not legacy ctx.workspace alone)", () => {
    expect(REVIEW_PAGE).toContain('activeSpace?.type === "ORGANIZATION"');
    expect(REVIEW_PAGE).toContain('activeSpace?.type === "PERSONAL"');
  });
});
