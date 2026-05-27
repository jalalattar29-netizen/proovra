/**
 * Phase B.3 — Reviewer Workflow Orchestration.
 *
 * Locks in:
 *
 *   1. `GET /v1/reviewer-ops/decisions/summary?teamId=<uuid>` exists,
 *      requires auth + team-member gate, returns the documented shape
 *      (summary.byState + preview).
 *
 *   2. `/v1/me/inbox` now ships the `review_decision` category for
 *      multi-stage review attention items.
 *
 *   3. Reviewer console ships the multi-stage summary card markers.
 *
 *   4. No regression on Phase 2.7X / A.1B / A.1C / A.1D / Phase B /
 *      Phase B.1 / Phase B.2 / Phase C contracts.
 *
 *   5. Deploy-blocker fix verification: the duplicate-useCallback
 *      that broke Vercel is gone. The web BUILD must succeed (the
 *      typecheck-only path was insufficient before — the lint rule
 *      that fires the violation is part of `next build`).
 */
import { test, expect } from "@playwright/test";
import {
  clearTestRateLimits,
  createGuestSession,
} from "./helpers/api-client";

test.beforeEach(async () => {
  await clearTestRateLimits();
});

const NONEXISTENT_TEAM = "00000000-0000-4000-8000-0000000000e1";

test.describe("Phase B.3 — workflow orchestration @critical", () => {
  // ---------------------------------------------------------------------------
  // Auth + RBAC contracts.
  // ---------------------------------------------------------------------------
  test("GET /v1/reviewer-ops/decisions/summary requires auth", async () => {
    const { request } = await import("@playwright/test");
    const anon = await request.newContext({
      baseURL: process.env.API_BASE ?? "http://localhost:8081",
    });
    const resp = await anon.get(
      `/v1/reviewer-ops/decisions/summary?teamId=${NONEXISTENT_TEAM}`,
    );
    expect([401, 403]).toContain(resp.status());
    await anon.dispose();
  });

  test("GET /v1/reviewer-ops/decisions/summary for unknown team returns 404", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(
      `/v1/reviewer-ops/decisions/summary?teamId=${NONEXISTENT_TEAM}`,
    );
    expect(resp.status()).toBe(404);
  });

  test("GET /v1/reviewer-ops/decisions/summary validates query shape", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get(
      `/v1/reviewer-ops/decisions/summary?teamId=not-a-uuid`,
    );
    expect(resp.status()).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // Inbox contract — new `review_decision` category in summary.byCategory.
  // ---------------------------------------------------------------------------
  test("/v1/me/inbox summary now includes review_decision category", async () => {
    const session = await createGuestSession();
    const resp = await session.api.get("/v1/me/inbox");
    expect(resp.ok()).toBe(true);
    const body = (await resp.json()) as {
      summary: {
        byCategory: {
          onboarding: number;
          org_invite: number;
          org_admin: number;
          governance: number;
          review_decision: number;
        };
      };
      items: Array<{ category: string }>;
    };
    expect(typeof body.summary.byCategory.review_decision).toBe("number");
    expect(body.summary.byCategory.review_decision).toBeGreaterThanOrEqual(0);
    // For a fresh guest with no reviews, the count is 0 — but the
    // field MUST exist in the response so consumers can rely on it.
  });

  // ---------------------------------------------------------------------------
  // Source-presence regression — backend + frontend
  // ---------------------------------------------------------------------------
  test("Backend reviewer-ops routes ship the decisions/summary endpoint", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "services/api/src/routes/reviewer-ops.routes.ts",
      ),
      "utf8",
    );
    expect(src).toContain(
      '"/v1/reviewer-ops/decisions/summary"',
    );
    expect(src).toContain("SUMMARY_WINDOW_DAYS");
    expect(src).toContain('"first_required"');
    expect(src).toContain('"second_required"');
    expect(src).toContain('"conflict_detected"');
    expect(src).toContain('"resolved"');
  });

  test("Backend inbox route ships the review_decision category sources", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(process.cwd(), "services/api/src/routes/me-inbox.routes.ts"),
      "utf8",
    );
    expect(src).toContain('"review_decision"');
    expect(src).toContain("conflictWorkflows");
    expect(src).toContain("pendingSecondForMe");
    expect(src).toContain("adjudicatorTeamIds");
    expect(src).toContain("review_decision:conflict:");
    expect(src).toContain("review_decision:awaiting_second:");
  });

  test("ReviewerCommandConsole ships the Phase B.3 summary card markers", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx",
      ),
      "utf8",
    );
    expect(src).toContain('data-reviewer-section="multi-stage-review-summary"');
    expect(src).toContain("data-multi-stage-summary-tiles");
    // The tile values are emitted via a templated `chip.key`. We
    // verify the source-of-truth `stateChips` array declares the 4
    // expected buckets.
    expect(src).toContain('key: "first_required"');
    expect(src).toContain('key: "second_required"');
    expect(src).toContain('key: "conflict_detected"');
    expect(src).toContain('key: "resolved"');
    expect(src).toContain("data-multi-stage-summary-tile={chip.key}");
    expect(src).toContain('data-reviewer-scope-item="multi-stage-summary"');
    expect(src).toContain('data-reviewer-scope-item="review-decision-inbox"');
  });

  // ---------------------------------------------------------------------------
  // Hook-rule deploy-blocker regression guard.
  //
  // The deploy blocker was a `useCallback` called after early-return
  // conditionals in ReviewerCommandConsole. The fix consolidates on
  // the existing `load` callback declared ABOVE the conditionals.
  // This test enforces that no hook (useCallback / useMemo /
  // useEffect / useState) is declared inside the function body AFTER
  // the first `if (state.status === "loading") return …` line.
  // ---------------------------------------------------------------------------
  test("ReviewerCommandConsole has no hooks declared after the early-return conditionals", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(
      path.resolve(
        process.cwd(),
        "apps/web/components/reviewer-experience/ReviewerCommandConsole.tsx",
      ),
      "utf8",
    );
    // Find the `export function ReviewerCommandConsole()` block.
    const funcStart = src.indexOf("export function ReviewerCommandConsole()");
    expect(
      funcStart,
      "ReviewerCommandConsole function must be locatable",
    ).toBeGreaterThan(-1);
    // The block ends where the next top-level `function`/`export` is
    // declared. We approximate by scanning to "// ----" comment block
    // or the `function CommandCenterReady` / next exported function.
    const blockEnd = src.indexOf("\n// ", funcStart + 50);
    const block = src.slice(funcStart, blockEnd > 0 ? blockEnd : funcStart + 8000);
    // Index of the first early return.
    const firstReturn = block.indexOf(
      'if (state.status === "loading") return',
    );
    expect(
      firstReturn,
      "the early-return on loading state must exist",
    ).toBeGreaterThan(-1);
    const afterReturns = block.slice(firstReturn);
    // No hook calls allowed after the early return inside this
    // function body. (The QueuePeekSection/etc are SEPARATE function
    // components and have their own hook scope — this check only
    // matches `<hook>(` patterns within the SAME function block.)
    expect(afterReturns).not.toMatch(/\buseCallback\s*\(/);
    expect(afterReturns).not.toMatch(/\buseMemo\s*\(/);
    expect(afterReturns).not.toMatch(/\buseEffect\s*\(/);
    expect(afterReturns).not.toMatch(/\buseState\s*\(/);
  });
});
