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

  /**
   * THE COMPONENT THIS GUARDED WAS UNMOUNTED, THEN DELETED.
   *
   * `ReviewerCommandConsole` was never rendered. Phase 12 Point 4 extracted
   * its capabilities onto the canonical `/review` console "so the capability
   * keeps a real product surface", and the dead component went with it — which
   * is why this read `ENOENT` rather than a failed assertion.
   *
   * So the same markers are asserted against the components that now own them.
   * That is strictly more than before: these ones actually render.
   */
  test("the multi-stage review summary card ships the Phase B.3 markers", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const read = async (rel: string) =>
      fs.readFile(path.resolve(process.cwd(), rel), "utf8");
    const src = await read(
      "apps/web/components/reviewer-experience/MultiStageReviewSummaryCard.tsx",
    );
    expect(src).toContain('data-reviewer-section="multi-stage-review-summary"');
    expect(src).toContain("data-multi-stage-summary-tiles");
    expect(src).toContain('key: "first_required"');
    expect(src).toContain('key: "second_required"');
    expect(src).toContain('key: "conflict_detected"');
    expect(src).toContain('key: "resolved"');
    expect(src).toContain("data-multi-stage-summary-tile={chip.key}");

    // And it is MOUNTED. The predecessor shipped these markers inside a
    // component nothing rendered, which is the failure mode this line closes.
    const console_ = await read(
      "apps/web/components/reviewer-experience/ReviewerConsole.tsx",
    );
    expect(console_).toContain("MultiStageReviewSummaryCard");
  });

  // ---------------------------------------------------------------------------
  // The deploy blocker was a `useCallback` called after early-return
  // conditionals. The component it happened in (`ReviewerCommandConsole`) was
  // unmounted and deleted, and its capabilities moved onto the canonical
  // console — so the RULE now applies to the three components that inherited
  // the code, not to one that no longer exists.
  //
  // SCOPED TO THE COMPONENT'S OWN INDENTATION, and that is the whole
  // correction. A file-wide search for `if (…) return` matches the `if
  // (!envelope) return [];` inside a `useMemo` body, and then flags every
  // hook below it — measured, that reported five violations in
  // `ReviewerConsole` where there are none. A return inside a callback is not
  // an early return FROM the component. The predecessor avoided this by
  // anchoring on one exact line; this anchors on the body's two-space
  // indentation instead, which generalises without that blind spot.
  //
  // Not vacuous: `ReviewerConsole` really does carry three component-level
  // early returns, so the rule has a subject in the file that matters.
  // ---------------------------------------------------------------------------
  test("no reviewer component declares a hook after an early return", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    const EARLY = /^ {2}if \([^)]*\)\s*(\{\s*)?return\b/;
    const hookAtBodyLevel = (hook: string) =>
      new RegExp(
        "^ {2}(?:const|let)\\s+\\w+\\s*=\\s*" + hook + "\\s*\\(|^ {2}" + hook + "\\s*\\(",
      );

    let subjects = 0;
    for (const rel of [
      "apps/web/components/reviewer-experience/ReviewerConsole.tsx",
      "apps/web/components/reviewer-experience/ReviewerBulkOpsBar.tsx",
      "apps/web/components/reviewer-experience/MultiStageReviewSummaryCard.tsx",
    ]) {
      const lines = (
        await fs.readFile(path.resolve(process.cwd(), rel), "utf8")
      ).split("\n");

      const starts: number[] = [];
      lines.forEach((l, i) => {
        if (/^(export )?function [A-Z]\w*\s*\(/.test(l)) starts.push(i);
      });

      for (let c = 0; c < starts.length; c += 1) {
        const from = starts[c]!;
        const to = c + 1 < starts.length ? starts[c + 1]! : lines.length;
        const block = lines.slice(from, to);
        const early = block.findIndex((l) => EARLY.test(l));
        if (early < 0) continue;
        subjects += 1;
        for (const [j, line] of block.slice(early + 1).entries()) {
          for (const hook of ["useCallback", "useMemo", "useEffect", "useState"]) {
            expect(
              hookAtBodyLevel(hook).test(line),
              `${rel}:${from + early + 2 + j} declares ${hook} after the early ` +
                `return at line ${from + early + 1}`,
            ).toBe(false);
          }
        }
      }
    }

    // If no component in any of the three has an early return, the rule above
    // asserted nothing and the test would be green for the wrong reason.
    expect(subjects, "no component-level early return found to guard").toBeGreaterThan(0);
  });
});
