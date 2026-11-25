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

import { REVIEW_GATE_TABLE } from "@proovra/shared";
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
// Stage D (T-065) — the console UI was retired: /review is the one Inbox
// (apps/web/components/reviewer-experience/ReviewInbox.tsx), proven behaviourally
// in apps/web/__tests__/render/review-inbox-views.render.test.tsx.
const INBOX_UI = readSource(
  "../../../apps/web/components/reviewer-experience/ReviewInbox.tsx",
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
    // Stage B (T-021): flag and purpose live in the ONE shared table that the
    // gate, the settings page and the step-up copy all read.
    expect(REVIEW_GATE).toContain("REVIEW_GATE_TABLE");
    expect(REVIEW_GATE_TABLE.approve.flag).toBe("requireStepUpForApprove");
    expect(REVIEW_GATE_TABLE.approve.purpose).toBe("REVIEW_APPROVAL_HIGH_RISK");
  });

  it("REJECT_INSUFFICIENT answers to requireStepUpForReject", () => {
    expect(REVIEW_GATE).toContain('"REJECT_INSUFFICIENT"');
    expect(REVIEW_GATE_TABLE.reject.flag).toBe("requireStepUpForReject");
    expect(REVIEW_GATE_TABLE.reject.purpose).toBe("REVIEWER_OPS_REJECT");
  });

  it("step-up flag-off proceeds without a step-up unless adaptive auth asks for one", () => {
    // The gate reads the flag and only invokes
    // `requireStepUpForSensitiveAction` when the flag is set, or when the
    // runtime adaptive gate has decided this session must step up
    // (20ef15600): the adaptive decision is answered here, not ignored.
    expect(REVIEW_GATE).toMatch(/const flagOn = flags\[gate\.flag\] === true;/);
    expect(REVIEW_GATE).toMatch(/if \(!flagOn && !adaptive\.stepUpRequired\) return true/);
  });
});

describe("Stage D — the Inbox replaced the reviewer console UI (source contract)", () => {
  it("/review mounts the one Inbox behind review.queue", () => {
    expect(REVIEW_PAGE).toContain('routeId="review.queue"');
    expect(REVIEW_PAGE).toContain("<ReviewInbox />");
  });
  it("the Inbox reads the reviewer-ops queue slice and opens rows on the Review page", () => {
    expect(INBOX_UI).toContain("/v1/reviewer-ops/queue?");
    expect(INBOX_UI).toContain("reviewHrefFromInbox(");
    expect(INBOX_UI).not.toContain("/v1/reviewer-ops/console");
  });
});

describe("Phase C0 — /review canonical page", () => {
  it("/review page exists and is wrapped in PageRouteGate", () => {
    expect(REVIEW_PAGE).toContain("PageRouteGate");
    expect(REVIEW_PAGE).toContain('routeId="review.queue"');
  });

  it("/review rows open the Review page (/reviewer-ops/[reviewId]) carrying the Inbox view", () => {
    expect(INBOX_UI).toContain("router.push(reviewHrefFromInbox(row.id, view, { focus }))");
  });

  it("/review does not read a persona-profile density preference", () => {
    // (2026-07-20) Operational density + the workspace-persona profile
    // were removed. The /review page no longer threads a density prop
    // into the reviewer console.
    expect(REVIEW_PAGE).not.toContain("operationalDensityPreference");
    expect(REVIEW_PAGE).not.toContain("personaProfile");
  });

  it("/review resolves the workspace from the active space (useActiveSpaceId)", () => {
    expect(INBOX_UI).toContain("const teamId = useActiveSpaceId();");
  });
});
